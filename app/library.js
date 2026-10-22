'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const maxBytes = 60 * 1024 * 1024;
  const bookPattern = /^epub-[a-f0-9]{64}$/;
  let importing = false;
  let listing = false;

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if(className)item.className=className;
    if(text!==undefined)item.textContent=text;
    return item;
  }
  function languageName(code) {
    try{return new Intl.DisplayNames(['zh-CN'],{type:'language'}).of(code || 'und') || '语言未标注';}
    catch(_){return '语言未标注';}
  }
  function fileProblem(file) {
    if(!file)return '请先选择一本 EPUB 电子书。';
    if(!/\.epub$/i.test(file.name))return '请选择 .epub 文件。PDF、MOBI 和其他格式暂不支持。';
    if(!file.size)return '这个文件是空的，请重新选择电子书。';
    if(file.size>maxBytes)return '这本书超过 60 MiB，请选择较小的无 DRM EPUB。';
    return '';
  }
  function feedback(message, error = false) {
    $('import-feedback').hidden=!message;
    $('import-feedback').classList.toggle('is-error',error);
    $('import-status').textContent=message;
  }
  function updateFile() {
    const file=$('epub-file').files[0],problem=fileProblem(file);
    $('import-button').disabled=Boolean(problem) || importing;
    $('epub-file').setAttribute('aria-invalid',String(Boolean(file && problem)));
    $('file-details').textContent=file?`${file.name} · ${(file.size/1024/1024).toFixed(2)} MiB`:'支持 EPUB 2 / 3 的文字与常见图片；不支持 PDF、MOBI 或加密电子书。';
    feedback(file && problem?problem:'',Boolean(problem));
  }
  function setBusy(value) {
    importing=value;
    $('epub-file').disabled=value;
    $('import-button').disabled=value || Boolean(fileProblem($('epub-file').files[0]));
    $('import-button').textContent=value?'正在本机导入…':'导入并开始阅读';
    $('epub-import-form').setAttribute('aria-busy',String(value));
    $('import-progress').hidden=!value;
  }
  async function refreshLibrary() {
    if(listing)return;
    listing=true;$('library-refresh').disabled=true;
    $('library-status').hidden=false;$('library-status').textContent='正在打开本机书库…';$('library-status').classList.remove('is-error');
    try{
      const response=await fetch('/api/library',{cache:'no-store'});
      if(!response.ok)throw Error('本机书库暂不可用，请确认阅读服务仍在运行，再刷新书库。');
      const payload=await response.json();
      if(!Array.isArray(payload.books))throw Error('书库信息不完整，请重启本机阅读服务后再试。');
      const seen=new Set(),books=payload.books.filter(book=>book && bookPattern.test(book.id) && !seen.has(book.id) && seen.add(book.id));
      const list=$('book-list');list.replaceChildren();
      for(const book of books){
        const item=element('li'),link=element('a','library-book');link.href=`/?book=${encodeURIComponent(book.id)}`;
        const spine=element('span','book-spine');spine.setAttribute('aria-hidden','true');
        const details=element('div','book-details');details.append(element('h3','',book.title || '未命名电子书'));
        details.append(element('p','',`${book.author || '作者未标注'} · ${languageName(book.language)} · ${Number(book.chapterCount) || 0} 章`));
        link.append(spine,details,element('span','book-open','打开 →'));item.append(link);list.append(item);
      }
      $('book-count').textContent=books.length?`${books.length} 本`:'';
      $('library-empty').hidden=Boolean(books.length);
      $('legacy-book').hidden=!payload.legacyAvailable;
      $('library-status').hidden=true;
    }catch(error){$('library-status').textContent=error.message;$('library-status').classList.add('is-error');}
    finally{listing=false;$('library-refresh').disabled=false;}
  }
  $('epub-file').addEventListener('change',updateFile);
  $('choose-first-book').addEventListener('click',()=>$('epub-file').click());
  $('library-refresh').addEventListener('click',refreshLibrary);
  $('epub-import-form').addEventListener('submit',async event=>{
    event.preventDefault();if(importing)return;
    const file=$('epub-file').files[0],problem=fileProblem(file);
    if(problem){feedback(problem,true);$('epub-file').focus();return;}
    setBusy(true);feedback('正在本机解析文字、章节和图片。较大的电子书可能需要稍等。');
    try{
      const response=await fetch('/api/library/import',{method:'POST',headers:{'Content-Type':'application/epub+zip','X-Reader-Request':'local-import'},body:file});
      let payload;
      try{payload=await response.json();}catch(_){throw Error('本机服务未返回有效结果。请确认服务仍在运行，然后重试；重复导入同一文件不会增加副本。');}
      if(!response.ok)throw Error(payload.notice || (response.status===413?'这本书超过本机导入大小限制。':'电子书导入失败，请选择有效的无 DRM EPUB 后重试。'));
      if(!bookPattern.test(payload.book?.id))throw Error('导入结果缺少书籍标识，请刷新书库查看。');
      const target=`/?book=${encodeURIComponent(payload.book.id)}`;
      feedback(payload.duplicate?'书库中已有这本书，正在打开…':'已导入，正在打开你的书…');
      location.assign(target);
    }catch(error){feedback(error instanceof TypeError?'无法连接本机阅读服务。请重新启动服务后重试，电子书不会发送到其他地址。':error.message,true);setBusy(false);}
  });
  refreshLibrary();
})();
