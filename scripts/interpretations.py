"""Per-unit, source-grounded interpretations. No book paragraphs leave this process.

Only small evidence excerpts, original summaries, hashes and verification metadata
are persisted. Retrieved public articles are transient in-memory inputs, not a
local article library. Background work never blocks the reading response.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'cache' / 'interpretations'
SEEDS = ROOT / 'data' / 'verified_interpretations.json'
TARGETS = ROOT / 'data' / 'interpretation_targets.json'
DISCOVERY_HINTS = ROOT / 'data' / 'source_discovery_hints.json'
SCHEMA = 'interpretations-3'
TTL = 24 * 60 * 60
RETRY_COOLDOWN = 5 * 60
MAX_MODEL_SOURCES = 1  # At most one generation + review pair per unit update.
POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix='interpretation')
LOCK = threading.RLock()
JOBS = {}
EXECUTING = set()
WAITING = []
MAX_WAITING = 2
SOURCE_LOCKS = {}
READ_MEMORY = {}
ALLOWED_DOMAINS = {
    'iaap.org', 'jungpage.org', 'jung.org', 'sanforddrob.com',
    'theredbookofcgjung.blogspot.com', 'symbolreader.net',
    'murraystein.com', 'philemonfoundation.org', 'routledge.com',
    'api.pageplace.de', 'stottilien.com', 'dreamnetworkjournal.com',
}


def stamp():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')


def digest(value):
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(value.encode()).hexdigest()


def canonical_url(url):
    p = urlparse(url)
    removable = {'replytocom', 'like_comment', '_wpnonce', 'fbclid', 'gclid', 'dclid', 'mc_cid', 'mc_eid'}
    params = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
              if k.lower() not in removable and not k.lower().startswith('utm_')]
    return urlunparse((p.scheme.lower(), p.netloc.lower(), p.path.rstrip('/'), '', urlencode(sorted(params)), ''))


def normalize(text):
    text = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', text)
    text = text.replace('\\', '').replace('*', '').replace('_', '')
    return re.sub(r'\s+', ' ', text).strip().casefold()


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + str(threading.get_ident()) + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.replace(path)


def load_json(path, fallback):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return deepcopy(fallback)


def source_catalog():
    return load_json(SEEDS, {'sources': []}).get('sources', [])


def allowed_url(url, catalog):
    p = urlparse(url)
    domains = ALLOWED_DOMAINS | {urlparse(s['url']).hostname for s in catalog}
    host = (p.hostname or '').lower()
    # Exact hosts only. No credentials, alternate ports, or user-supplied URLs.
    return p.scheme == 'https' and p.username is None and p.password is None and p.port in (None, 443) and host in domains


def is_article_url(url):
    p = urlparse(url)
    return not re.search(r'/(tag|category|search|author|page)/|/\d{4}/\d{2}/?$', p.path) and not p.query


def clean_article(body, source=None):
    """Keep article region where known; never treat a tiny widget as the article."""
    if source and source.get('bodyStart'):
        starts = [body.find(x) for x in source['bodyStart'] if body.find(x) >= 0]
        if starts:
            body = body[min(starts):]
    elif re.search(r'^#{1,2} ', body, re.M):
        # Prefer a title heading after site navigation; model validates page type.
        candidates = list(re.finditer(r'^#{1,2} ', body, re.M))
        if len(candidates) == 1:
            body = body[candidates[0].start():]
    for end in (source or {}).get('bodyEnd', []) + ['### Share this:', '## Share this:', '## Leave a Reply', '## Leave a comment']:
        i = body.find(end)
        if i > 200:
            body = body[:i]
    return body.strip()


class ReadFailure(Exception):
    pass


def read_public_source(url, source=None, force=False):
    catalog = source_catalog()
    if not allowed_url(url, catalog):
        raise ReadFailure('来源不在已确认的公开域名范围')
    key = canonical_url(url)
    with LOCK:
        cached = READ_MEMORY.get(key)
        if cached and time.monotonic() - cached['at'] < (15 if force else 600):
            return deepcopy(cached['value']) | {'retrievalMode': 'memory'}
        source_lock = SOURCE_LOCKS.setdefault(key, threading.Lock())
    with source_lock:
        with LOCK:
            cached = READ_MEMORY.get(key)
            if cached and time.monotonic() - cached['at'] < (15 if force else 600):
                return deepcopy(cached['value']) | {'retrievalMode': 'memory'}
        attempts = []
        body = ''
        channel = ''
        lp = shutil.which('lp') or '/opt/homebrew/bin/lp'
        if not urlparse(url).path.lower().endswith('.pdf') and Path(lp).is_file():
            # The installed wrapper's 8-second render wait is needed by real
            # article pages; a 1-second override yielded incomplete bodies.
            env = dict(os.environ, LP_MAX_BYTES='100000', LP_WAIT_MS='8000', LP_HTTP_TIMEOUT='30000', LP_CONNECT_TIMEOUT='12000')
            try:
                result = subprocess.run([lp, url], capture_output=True, text=True, timeout=42, env=env)
                raw = result.stdout.strip()
                # A permission wall is a stop, not permission to try another route.
                if len(raw) < 5000 and re.search(r'captcha|verify (you are|that you are) human|access denied|sign in to continue|subscribe to continue|just a moment', raw, re.I):
                    raise ReadFailure('来源出现验证码、访问限制或登录墙，已停止读取')
                candidate = clean_article(raw, source)
                if result.returncode == 0 and len(candidate) > 700 and not re.search(r'IntenseDebate account|Navigation failed', candidate[:400]):
                    body, channel = candidate, 'Lightpanda'
                else:
                    attempts.append('Lightpanda未返回有效文章正文')
            except (subprocess.TimeoutExpired, OSError):
                attempts.append('Lightpanda网络或超时')
        if not body:
            cli = shutil.which('tvly') or str(Path.home() / '.local/bin/tvly')
            try:
                result = subprocess.run([cli, 'extract', url, '--extract-depth', 'advanced', '--format', 'markdown', '--timeout', '25', '--json'], capture_output=True, text=True, timeout=35)
                answer = json.loads(result.stdout)
                items = answer.get('results', [])
                if not items:
                    raise ReadFailure('公开正文读取失败；搜索摘要不能替代正文')
                body = clean_article(str(items[0].get('raw_content', '')), source)
                channel = 'Tavily extract (public body)'
                if len(body) < 700:
                    raise ReadFailure('正文不足，未升级为解读')
                if len(body) < 5000 and re.search(r'captcha|access denied|sign in to continue|subscribe to continue', body, re.I):
                    raise ReadFailure('来源存在访问限制，已停止读取')
            except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
                raise ReadFailure('公开正文读取超时或返回无效内容') from exc
        value = {'url': key, 'body': body, 'bodyHash': digest(body), 'normalizedBodyHash': digest(normalize(body)), 'readAt': stamp(), 'method': channel, 'bodyLength': len(body), 'attempts': attempts, 'retrievalMode': 'network'}
        with LOCK:
            READ_MEMORY[key] = {'at': time.monotonic(), 'value': value}
            # Bound ephemeral RAM; full bodies are never written to disk.
            if len(READ_MEMORY) > 24:
                READ_MEMORY.pop(next(iter(READ_MEMORY)))
        return deepcopy(value)


class TargetMissing(ValueError):
    pass


class SourceMissing(ValueError):
    pass


def target_for(unit):
    target = load_json(TARGETS, {}).get('units', {}).get(unit['id'])
    if not target:
        raise TargetMissing('Missing reviewed unit target')
    actual = digest({'zh': unit['zh'], 'en': unit['en'], 'chapter': unit['chapter']})
    if target['textHash'] != actual:
        raise ValueError('Unit source changed; mapping requires review')
    return target


def make_card(source, viewpoint, match, verified_at=None, read=None):
    proof = source.get('readEvidence', {})
    return {
        'id': source['id'] + ':' + viewpoint['id'], 'sourceId': source['id'],
        'author': source['author'], 'title': source['title'], 'url': source['url'],
        'publishedAt': source.get('publishedAt'), 'originalLanguage': source.get('originalLanguage', 'en'),
        'dateNote': source.get('dateNote'), 'publicationId': source.get('publicationId'),
        'publicationTitle': source.get('publicationTitle'),
        'verifiedAt': verified_at or proof.get('verifiedAt'),
        'sourceHash': (read or {}).get('bodyHash') or proof.get('bodyHash'),
        'relation': match['relation'],
        'interpretation': {'zh': viewpoint['zh'], 'en': viewpoint['en'],
                           'labelZh': '应用辅助中文转述 · 非作者原话',
                           'labelEn': 'App-assisted English paraphrase · not a quotation'},
        'match': {'zh': match['zh'], 'en': match['en'], 'locator': match.get('locator') or viewpoint.get('locator', '')},
        'evidence': {'excerpt': viewpoint.get('excerpt', ''), 'locator': viewpoint.get('locator', ''),
                     'method': (read or {}).get('method') or proof.get('method')},
        'verification': {'method': '已读公开正文，核对作者署名、观点与段落位置；双语为应用转述',
                         'review': source.get('review', '独立模型代理复核；非人类专家审校'),
                         'identityCheckedAt': source['author'].get('verifiedAt', proof.get('verifiedAt'))},
        'cached': True,
    }


def seed_cards(unit_id, catalog):
    cards = []
    for source in catalog:
        for viewpoint in source.get('viewpoints', []):
            for match in viewpoint.get('matches', []):
                if match['unitId'] == unit_id:
                    cards.append(make_card(source, viewpoint, match))
    return cards


def merge_cards(*groups):
    result = {}
    rank = {'direct': 0, 'chapter': 1, 'theme': 2}
    for group in groups:
        for card in group:
            result[card['id']] = card
    return sorted(result.values(), key=lambda c: (rank.get(c['relation'], 3), c['author']['name'], c['id']))


def coverage(cards, target):
    counts = {r: sum(c['relation'] == r for c in cards) for r in ('direct', 'chapter', 'theme')}
    authors = len({c['author']['id'] for c in cards})
    if not cards:
        zh, en = '尚无核实后的解读。', 'No verified interpretation yet.'
    elif not counts['direct']:
        zh, en = '尚未找到直接解释本单元的来源；下列为同章或主题材料。', 'No direct commentary on this unit has been verified; the material below is contextual.'
    elif authors < 2:
        zh, en = '目前仅有1位独立作者；另一种视角仍待补足。', 'Only one independent author is available; another perspective remains a gap.'
    else:
        zh, en = '直接对应与背景材料已分级；不代表所有作者都逐句解释本段。', 'Direct and contextual material are distinguished; not every author comments sentence by sentence.'
    return dict(authorCount=authors, **counts, gapZh=zh, gapEn=en, focusZh=target['focusZh'], focusEn=target['focusEn'])


def context(unit, metadata, dataset='active'):
    target = target_for(unit)
    catalog = source_catalog()
    sources = metadata.get('sourceFiles', [])
    if (not catalog or not isinstance(sources, list) or not sources
            or any(not isinstance(x, dict) or not isinstance(x.get('sha256'), str)
                   or not re.fullmatch(r'[0-9a-f]{64}', x['sha256']) for x in sources)):
        raise SourceMissing('Reviewed source metadata unavailable')
    version = '|'.join(x.get('sha256', '') for x in metadata.get('sourceFiles', []))
    key = digest([SCHEMA, unit['id'], version, target['textHash'], digest(catalog)])
    if dataset != 'active':
        if dataset != 'candidate' or not metadata.get('datasetId'):
            raise SourceMissing('Candidate identity unavailable')
        key = digest(['candidate', metadata['datasetId'], key])
    return target, catalog, version, key, CACHE / 'units' / (key + '.json')


def run_scheduled(args):
    key = args[4]
    try:
        research(*args)
    finally:
        with LOCK:
            EXECUTING.discard(key)
            if JOBS[key].get('running'):
                JOBS[key].update(running=False, phase='failed', message='后台更新未完整结束，保留已有材料。')
            if WAITING:
                following = WAITING.pop(0)
                start_scheduled(following)


def start_scheduled(args):
    """Called under LOCK; reserve execution before submitting to the executor."""
    key = args[4]
    EXECUTING.add(key)
    JOBS[key].update(phase='starting', message='正在启动本次显式更新。')
    try:
        POOL.submit(run_scheduled, args)
    except Exception:
        EXECUTING.discard(key)
        JOBS[key].update(running=False, phase='failed', message='后台更新未能启动。')


def unavailable_snapshot(unit, reason):
    return {'unitId': unit['id'], 'status': 'empty', 'reason': reason, 'cached': False,
            'results': [], 'lastVerifiedAt': None,
            'coverage': {'authorCount': 0, 'direct': 0, 'chapter': 0, 'theme': 0,
                         'gapZh': '尚无核实解读。', 'gapEn': 'No verified interpretation yet.'},
            'research': {'running': False, 'phase': 'not_configured'},
            'notice': ('本单元尚未建立审核后的检索目标。正文可继续阅读。' if reason == 'target_missing'
                       else '来源配置缺失，已停止联网更新。正文可继续阅读。')}


def snapshot(unit, metadata, refresh=False, poll=False, dataset='active'):
    identity = {'dataset': dataset, 'datasetId': metadata.get('datasetId')}
    try:
        target, catalog, version, key, path = context(unit, metadata, dataset)
    except TargetMissing:
        return unavailable_snapshot(unit, 'target_missing') | identity
    except SourceMissing:
        return unavailable_snapshot(unit, 'source_missing') | identity
    stored = load_json(path, {})
    if dataset == 'candidate' and not stored:
        # Fingerprint and source metadata have already passed context(). Read old
        # cards without ever writing candidate work into the active namespace.
        legacy_path = context(unit, metadata, 'active')[4]
        stored = load_json(legacy_path, {})
    cards = merge_cards(seed_cards(unit['id'], catalog), stored.get('results', []))
    reason = None
    with LOCK:
        running = key in EXECUTING or JOBS.get(key, {}).get('running', False)
        stale = time.time() - stored.get('completedEpoch', 0) > TTL
        cooling_down = time.time() - stored.get('attemptedEpoch', 0) < RETRY_COOLDOWN
        if refresh and not poll and not running:
            if not stale:
                reason = 'cache_fresh'
            elif cooling_down:
                reason = 'cooldown'
            elif len(EXECUTING) >= 2 and len(WAITING) >= MAX_WAITING:
                reason = 'queue_full'
            else:
                JOBS[key] = {'running': True, 'phase': 'queued', 'updatedAt': stamp(), 'message': '已保留核实材料；等待更新。', 'unverifiedCandidateCount': 0}
                # No book paragraphs or notes are carried into background work.
                args = ({'id': unit['id']}, deepcopy(target), catalog, version, key, path, True)
                if len(EXECUTING) < 2:
                    start_scheduled(args)
                else:
                    WAITING.append(args)
        job = deepcopy(JOBS.get(key) or stored.get('research') or {'running': False, 'phase': 'complete', 'message': '显示已核实材料。', 'unverifiedCandidateCount': 0})
        # A persisted running flag is not evidence of a job in this process.
        if key not in JOBS:
            job['running'] = False
    dates = [c.get('verifiedAt') for c in cards if c.get('verifiedAt')]
    return {**identity, 'reason': reason, 'unitId': unit['id'], 'status': 'ready' if cards else ('error' if job['phase'] == 'failed' else 'empty'),
            'cached': bool(cards), 'results': cards, 'coverage': coverage(cards, target),
            'lastVerifiedAt': max(dates) if dates else None, 'research': job,
            'notice': {'queue_full': '已有2个更新执行、2个等待；本次未排队，保留已有观点。',
                       'cooldown': '上次更新尚未完成核验，请在5分钟冷却后重试；已有观点保留。',
                       'cache_fresh': '显示24小时内的成功缓存，本次未发起联网。'}.get(reason,
                       '只展示已读来源正文并核对后的作者观点。中英文均有明确转述标识。'),
            'nextPollMs': 1800 if job.get('running') else None, 'sourceVersion': version, 'unitTextHash': target['textHash'],
            'cacheScope': '版本＋完整单元指纹＋来源证据；各单元独立核验',
            'query': target['query'], 'refreshedAt': stored.get('refreshedAt')}


def progress(key, phase, message, **fields):
    with LOCK:
        JOBS[key].update(phase=phase, message=message, updatedAt=stamp(), **fields)


def search_candidates(query, catalog):
    cli = shutil.which('tvly') or str(Path.home() / '.local/bin/tvly')
    domains = sorted(ALLOWED_DOMAINS | {urlparse(s['url']).hostname for s in catalog})
    result = subprocess.run([cli, 'search', query, '--depth', 'advanced', '--max-results', '5', '--include-domains', ','.join(domains), '--json'], capture_output=True, text=True, timeout=35)
    raw = json.loads(result.stdout)
    if result.returncode or not isinstance(raw.get('results'), list):
        raise ValueError('Search unavailable')
    seen, items = set(), []
    for r in raw['results']:
        url = canonical_url(r.get('url', ''))
        if url in seen or not allowed_url(url, catalog) or not is_article_url(url):
            continue
        seen.add(url)
        items.append({'url': url, 'title': str(r.get('title', ''))})
    # Persist search provenance, never summaries or raw article bodies.
    return items, {'query': query, 'at': stamp(), 'urls': items, 'requestId': raw.get('request_id')}


def refresh_seed(source, unit_id, read):
    normalized = normalize(read['body'])
    proof = source.get('readEvidence', {})
    unchanged = proof.get('normalizedBodyHash') == read.get('normalizedBodyHash') if proof.get('normalizedBodyHash') else proof.get('bodyHash') == read['bodyHash']
    if not unchanged:
        return [], '来源正文指纹与已核验版本不同，需语义复核；不能仅凭短引延长核验时间'
    required = source.get('requiredMarkers', [])
    if required and not all(normalize(marker) in normalized for marker in required):
        return [], '来源署名或正文标记变化，需要重新核对'
    cards = []
    for v in source.get('viewpoints', []):
        matching = [m for m in v.get('matches', []) if m['unitId'] == unit_id]
        if not matching:
            continue
        anchors = v.get('anchors') or ([v['excerpt']] if v.get('excerpt') else [])
        if not anchors or not all(normalize(a) in normalized for a in anchors):
            continue
        for m in matching:
            cards.append(make_card(source, v, m, read['readAt'], read))
    return cards, '' if cards else '旧证据定位未在本次公开正文中确认；保留原核验时间'


def model_context(body, target, viewpoint=None):
    """Bound model input using relevant public-article paragraphs, not book text.

    The fetcher has read the whole public body. Long bodies retain byline/footer
    plus the best topic paragraphs and their neighbors; selection is disclosed.
    """
    if len(body) <= 47000:
        return body
    terms = set(re.findall(r'[a-z]{4,}', target['focusEn'].lower()))
    if viewpoint:
        terms.update(re.findall(r'[a-z]{4,}', viewpoint.get('excerpt', '').lower()))
    paragraphs = re.split(r'\n\s*\n', body)
    scores = sorted(range(len(paragraphs)), key=lambda n: sum(t in paragraphs[n].lower() for t in terms), reverse=True)
    selected = set(range(min(3, len(paragraphs)))) | set(range(max(0, len(paragraphs) - 3), len(paragraphs)))
    for index in scores[:10]:
        selected.update(n for n in (index-1, index, index+1) if 0 <= n < len(paragraphs))
    pieces, size = [], 0
    for index in sorted(selected):
        paragraph = paragraphs[index]
        if size + len(paragraph) > 45000:
            continue
        pieces.append(paragraph)
        size += len(paragraph) + 2
    return '[Reading scope: selected complete paragraphs from a longer public article, including byline/context. Omitted paragraphs are not evidence.]\n\n' + '\n\n'.join(pieces)


def resolve_author(name, url, catalog):
    """Only curated, evidenced aliases; don't guess same people from surnames."""
    candidate = normalize(name)
    for source in catalog:
        author = source['author']
        names = [author['name'], *author.get('aliases', [])]
        if candidate in {normalize(n) for n in names}:
            # Monika alone is not globally unique: require her confirmed domain.
            if candidate in {'monika', 'symbol reader', 'symbolreader'} and urlparse(url).hostname != 'symbolreader.net':
                continue
            return author
    return None


def dynamic_source_record(candidate, read, analyzed, unit_id):
    author_id = 'author-' + digest(normalize(analyzed['authorName']))[:16]
    source_id = 'online-' + digest(candidate['url'])[:16]
    source = {'id': source_id, 'url': candidate['url'], 'title': analyzed['title'],
              'author': {'id': author_id, 'name': analyzed['authorName'], 'kind': 'reader',
                         'identity': '来源正文署名作者；专业资格未独立核实', 'identityUrl': candidate['url'], 'verifiedAt': read['readAt']},
              'publishedAt': analyzed.get('publishedAt'), 'originalLanguage': 'en',
              'readEvidence': {k: read[k] for k in ('bodyHash', 'method', 'bodyLength')} | {'verifiedAt': read['readAt']},
              'review': '本机模型进行来源归属、相关性与双语忠实性两阶段检查；非人类专家审校',
              'viewpoints': [{'id': 'view', 'zh': analyzed['summaryZh'], 'en': analyzed['summaryEn'],
                              'excerpt': analyzed['evidenceExcerpt'], 'locator': analyzed['locator'],
                              'anchors': [analyzed['anchor']],
                              'matches': [{'unitId': unit_id, 'relation': analyzed['relation'], 'zh': analyzed['matchZh'], 'en': analyzed['matchEn'], 'locator': analyzed['locator']}]}]}
    source['modelVerification'] = {k: analyzed.get(k) for k in ('model', 'modelMetadata', 'usage', 'review')}
    return source


def research(unit, target, catalog, version, key, path, force):
    started = time.monotonic()
    previous = load_json(path, {})
    cards = merge_cards(seed_cards(unit['id'], catalog), previous.get('results', []))
    events, errors, discoveries = [], [], []
    def checkpoint():
        # Preserve even rejected attempts across a service restart; no full body,
        # credential, prompt or model reasoning is included in these events.
        atomic_json(path, {**previous, 'unitId': unit['id'], 'sourceVersion': version,
                           'unitTextHash': target['textHash'], 'results': cards,
                           'events': events, 'attemptedEpoch': time.time(),
                           'research': {'running': False, 'phase': 'partial',
                                        'message': '显示已保存材料；上一轮尚无完整核验结果。',
                                        'updatedAt': stamp(), 'unverifiedCandidateCount': 0}})
    confirmed = 0
    network_urls = set()
    search_ok = False
    try:
        progress(key, 'searching', '按当前单元的具体问题搜索公开来源。')
        try:
            discoveries, search_evidence = search_candidates(target['query'], catalog)
            events.append({'stage': 'search', **search_evidence})
            checkpoint()
            search_ok = True
        except (OSError, ValueError, subprocess.TimeoutExpired):
            errors.append('本次搜索失败；继续尝试已有来源的公开正文。')
        seed_sources = [s for s in catalog if any(m['unitId'] == unit['id'] for v in s.get('viewpoints', []) for m in v.get('matches', []))]
        known = {canonical_url(s['url']): s for s in catalog}
        by_id = {s['id']: s for s in catalog}
        # Explicit discovery hints first, then relevant seed pages and search hits.
        seed_candidates = [{'url': s['url'], 'title': s['title'], 'sourceId': s['id']} for s in seed_sources]
        # Hints are discovery inputs only. They have no cards or verified status
        # until actual body retrieval and the two model checks succeed.
        hints = load_json(DISCOVERY_HINTS, {}).get(unit['id'], [])
        candidates = [h for h in hints if allowed_url(h.get('url', ''), catalog)] + seed_candidates
        candidates.extend(x for x in discoveries if canonical_url(x['url']) not in {canonical_url(y['url']) for y in candidates})
        unverified = 0
        new_attempts = 0
        model_sources = 0
        deferred = 0
        for candidate in candidates:
            source = by_id.get(candidate.get('sourceId')) or known.get(canonical_url(candidate['url']))
            # Known source with no reviewed relation must not inherit another unit's card.
            relevant_seed = source and source in seed_sources
            if not relevant_seed and (new_attempts >= 2 or model_sources >= MAX_MODEL_SOURCES):
                unverified += 1
                deferred += 1
                continue
            progress(key, 'reading', '正在读取来源正文：' + candidate['title'], unverifiedCandidateCount=unverified)
            try:
                read = read_public_source(candidate['url'], source, force=force)
            except ReadFailure as exc:
                errors.append(candidate['url'] + '：' + str(exc))
                events.append({'stage': 'read', 'url': candidate['url'], 'ok': False, 'reason': str(exc), 'at': stamp()})
                unverified += 1
                continue
            if read['retrievalMode'] == 'network':
                network_urls.add(canonical_url(candidate['url']))
            events.append({'stage': 'read', 'url': candidate['url'], 'ok': True, **{k: read[k] for k in ('bodyHash', 'readAt', 'method', 'bodyLength', 'retrievalMode')}})
            checkpoint()
            progress(key, 'matching', '核对作者观点与本单元的位置和语境。')
            if relevant_seed:
                refreshed, issue = refresh_seed(source, unit['id'], read)
                if not refreshed and '指纹' in issue and model_sources >= MAX_MODEL_SOURCES:
                    deferred += 1
                    issue += '；本轮模型核验额度已用完，保留旧材料及其原核验时间'
                elif not refreshed and '指纹' in issue:
                    from interpretation_model import analyze_source
                    progress(key, 'checking', '来源内容变化，重新核对旧观点的归属、双语与本段关联。')
                    for viewpoint in source['viewpoints']:
                        if not any(m['unitId'] == unit['id'] for m in viewpoint.get('matches', [])):
                            continue
                        if model_sources >= MAX_MODEL_SOURCES:
                            deferred += 1
                            break
                        model_sources += 1
                        checked = analyze_source({**candidate, 'body': model_context(read['body'], target, viewpoint), 'readAt': read['readAt']}, target, existing_viewpoint=viewpoint)
                        events.append({'stage': 'changed-source-review', 'url': candidate['url'], 'sourceId': source['id'], 'accepted': bool(checked.get('accepted')), 'reason': checked.get('reason'), 'review': checked.get('review'), 'modelMetadata': checked.get('modelMetadata'), 'usage': checked.get('usage'), 'at': stamp()})
                        checkpoint()
                        identified = resolve_author(checked.get('authorName', ''), candidate['url'], catalog)
                        if checked.get('accepted') and identified and identified['id'] == source['author']['id']:
                            match = {'unitId': unit['id'], 'relation': checked['relation'], 'zh': checked['matchZh'], 'en': checked['matchEn'], 'locator': checked['locator']}
                            refreshed.append(make_card(source, viewpoint, match, read['readAt'], read))
                if refreshed:
                    cards = merge_cards(cards, refreshed)
                    confirmed += 1
                    events.append({'stage': 'verify', 'url': candidate['url'], 'method': 'reviewed-map-and-body-anchors', 'accepted': True, 'unitId': unit['id']})
                else:
                    errors.append(candidate['url'] + '：' + issue)
                    unverified += 1
                # Publish verified cards incrementally without claiming job success.
                checkpoint()
                continue
            source_path = CACHE / 'sources' / (digest(candidate['url']) + '.json')
            prior_source = load_json(source_path, {})
            if prior_source:
                refreshed, _ = refresh_seed(prior_source, unit['id'], read)
                if refreshed:
                    cards = merge_cards(cards, refreshed)
                    confirmed += 1
                    events.append({'stage': 'verify', 'url': candidate['url'], 'method': 'unchanged-runtime-source-and-reviewed-unit-map', 'accepted': True, 'unitId': unit['id']})
                    checkpoint()
                    continue
            new_attempts += 1
            model_sources += 1
            try:
                from interpretation_model import analyze_source
                progress(key, 'translating', '为新来源核对观点并生成有标识的中英转述。')
                prior_view = prior_source.get('viewpoints', [None])[0]
                analyzed = analyze_source({**candidate, 'body': model_context(read['body'], target, prior_view), 'readAt': read['readAt']}, target, existing_viewpoint=prior_view)
                progress(key, 'checking', '检查作者归属、双语忠实性和关联范围。')
                events.append({'stage': 'model', 'url': candidate['url'], 'accepted': bool(analyzed.get('accepted')), 'reason': analyzed.get('reason'), 'model': analyzed.get('model'), 'modelMetadata': analyzed.get('modelMetadata'), 'usage': analyzed.get('usage'), 'review': analyzed.get('review'), 'at': stamp()})
                checkpoint()
                if not analyzed.get('accepted'):
                    if str(analyzed.get('reason', '')).startswith(('model_', 'source_invalid', 'input_')):
                        errors.append('新来源自动核验未完成：' + str(analyzed.get('reason')) + '；未生成已核实观点。')
                    unverified += 1
                    continue
                # A known author's page may be quoted by another writer. The model
                # checks ownership; canonical author IDs prevent counting a reprint twice.
                record = dynamic_source_record(candidate, read, analyzed, unit['id'])
                identified = resolve_author(record['author']['name'], candidate['url'], catalog)
                if identified:
                    record['author'] = identified
                # One bounded bilingual digest per external source. Reuse it for
                # later units, with a fresh matching check; never accumulate chapters.
                if prior_source:
                    old_v = prior_source['viewpoints'][0]
                    if normalize(old_v['excerpt']) not in normalize(read['body']):
                        unverified += 1
                        errors.append('来源旧证据发生变化，暂未扩展其单元覆盖。')
                        continue
                    # New summary is not persisted as a second digest; use first only
                    # if its evidence is the same, otherwise leave a visible gap.
                    if normalize(old_v['excerpt']) != normalize(record['viewpoints'][0]['excerpt']):
                        unverified += 1
                        continue
                    record['viewpoints'][0]['zh'] = old_v['zh']
                    record['viewpoints'][0]['en'] = old_v['en']
                atomic_json(source_path, record)
                v = record['viewpoints'][0]
                cards = merge_cards(cards, [make_card(record, v, v['matches'][0], read['readAt'], read)])
                confirmed += 1
                checkpoint()
            except (ImportError, OSError, ValueError, subprocess.TimeoutExpired):
                errors.append('新来源模型核验未完成；未将候选伪装成解读。')
                unverified += 1
        success = confirmed > 0
        phase = 'complete' if success else 'failed'
        message = ('本次核对或复用' + str(confirmed) + '个作者来源；实际联网读取' + str(len(network_urls)) + '个页面。' if success else '本次在线核验未完成，保留此前已核实的材料及时间。')
        if errors:
            message += ' 部分来源未完成；可展开查看状态。'
        if deferred:
            message += ' 本轮仅对1个来源运行双阶段模型核验，其余保留待核对状态。'
        progress(key, phase, message, running=False, unverifiedCandidateCount=unverified, errors=errors, onlineSourceCount=len(network_urls), verifiedSourceCount=confirmed,
                 searchCompleted=search_ok, modelSourceCount=model_sources, deferredSourceCount=deferred, elapsedSeconds=round(time.monotonic() - started, 2))
        with LOCK:
            status = deepcopy(JOBS[key])
        payload = {'unitId': unit['id'], 'sourceVersion': version, 'unitTextHash': target['textHash'], 'results': cards,
                   'research': status, 'refreshedAt': stamp() if success else previous.get('refreshedAt'),
                   'completedEpoch': time.time() if success else previous.get('completedEpoch', 0), 'attemptedEpoch': time.time(),
                   'events': events, 'coverage': coverage(cards, target)}
        atomic_json(path, payload)
    except Exception as exc:
        # No provider stderr, credentials, source body or reasoning text in errors.
        progress(key, 'failed', '后台核验未完成，保留已有材料。', running=False, errors=[type(exc).__name__])
        with LOCK:
            status = deepcopy(JOBS[key])
        atomic_json(path, {**previous, 'unitId': unit['id'], 'sourceVersion': version,
                           'unitTextHash': target['textHash'], 'results': cards,
                           'events': events, 'research': status, 'attemptedEpoch': time.time()})

