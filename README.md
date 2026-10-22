# Foliotter · 书獭

**Hold a book. Drift awhile.**

A local ebook reader for EPUB, PDF, TXT, MOBI, AZW3 and FB2. Bring your own books; keep your reading on your computer.

The interface starts in **English**. Choose **中文** in the language selector to switch the interface. This setting is separate from the language of your book.

**This repository contains MIT-licensed software and original icons only.** It includes no books, translations, publisher notes or book artwork. Supply ebooks you have the right to use. The software license does not grant rights to redistribute a book; see [NOTICE](NOTICE.md).

## Start reading

Install Python 3.10 or later, download and extract the code, then run these commands from the extracted folder:

```sh
python3 -B scripts/setup_importers.py --ensure
python3 -B scripts/serve.py --open
```

Setup downloads the pinned import tools into this project's `.venv`. It downloads software, not books. Later runs reuse installed versions. The server automatically uses this environment when it exists. EPUB, TXT and FB2 do not require the optional PDF/Kindle tools; without them, those formats remain available and the library explains how to enable the others.

Open `http://127.0.0.1:8787/`, choose a file in the library, and select **Import and read**. A fresh installation opens the library automatically. Imported books stay in your library and can be reopened from the reading page.

On macOS, double-click `启动阅读.command` to set up the import tools and launch the reader. For a desktop shortcut and background service, use `安装桌面入口.command`. A new installation creates `Foliotter.app`. Keep the extracted folder in its installed location. Existing local installations retain their shortcut and browser address.

If port 8787 is already occupied, use `python3 -B scripts/serve.py --port 8788 --open`. Browser records belong to their address: export them before changing ports. The server listens on the local computer only; do not expose it to the public Internet.

## Supported books

Every input must be unencrypted and at most **60 MiB**.

| Format | Import behavior |
| --- | --- |
| EPUB 2 / 3 | Reflowable text, headings and supported raster images, in spine order |
| PDF | Extractable text, organized by source page; no OCR for scanned pages |
| TXT | UTF-8, UTF-16 with a byte-order mark, and GB18030; ambiguous encodings are rejected rather than guessed |
| MOBI / AZW3 | Local unpacking through the separately installed KindleUnpack-based tool, then safe reading-data conversion |
| FB2 | FictionBook XML text and supported images |

The reader reflows imported content. It does not reproduce the publisher's exact page layout, arbitrary CSS, fonts, scripts, multimedia or interactive footnotes. PDF extraction can have imperfect line or reading order, especially in multi-column documents. DRM, password-protected books, unsupported containers and files without usable text receive an explanation instead of an empty book. No DRM removal or OCR is provided.

## Reading languages

- The default reading language is **English**, when the book has English text. Random passages follow the selected reading language.
- With a single-language book, the reader uses that language and fills the available page. It does not reserve an empty translation column.
- The optional comparison column shows a **real corresponding passage**, when one exists. The current primary/secondary language choices are English and Chinese; comparison is off by default.
- Changing the interface to Chinese does not change the book's reading language.
- Foliotter does **not** automatically translate, match unrelated passages, or pair separately imported books by paragraph number. Ordinary single-language imports remain single-language books. Existing local material with verified bilingual mappings remains compatible; those private texts and mappings are not distributed here.

Reading tools include contents, pagination, type-size controls, search, random passages, favorites, notes, and record export/restore. Importing the exact same file reopens the existing book instead of adding another copy.

## Where books and records live

- Converted text and supported images: `user-library/` inside the project, with a separate directory for each book. Git and the public package builder exclude it.
- The original uploaded file is not retained after processing. Temporary conversion files are removed when the operation finishes.
- Reading positions, favorites and notes: this browser's local storage, isolated by imported book. Export records before changing browser profiles, clearing site data or moving to a different port.
- Back up `user-library/` for books and use **Backup and restore** for records. The source-code ZIP contains neither.
- There is no graphical book-deletion tool yet. Back up first, close the reader, and remove only the intended book's directory if necessary.

Importing a new book does not overwrite existing local material. `scripts/install_local_content.py` is solely for restoring an older personal offline package you own; it is not a download service or the normal import route.

## Development and release checks

```sh
python3 -B scripts/setup_importers.py --ensure
.venv/bin/python -B -m unittest discover -s scripts -p 'test_*.py'
node --test scripts/test_reading_pages.cjs scripts/test_reader_import.cjs scripts/test_i18n.cjs scripts/test_reading_language.cjs scripts/test_record_notices.cjs
python3 -B scripts/audit_release.py
python3 -B scripts/package_reader.py --output dist/Foliotter-code.zip
python3 -B scripts/audit_release.py --zip dist/Foliotter-code.zip
```

On Windows, the environment interpreter is `.venv\Scripts\python.exe`. Tests generate short original synthetic materials and do not need private books. New public code files must be added to the explicit release allowlist. The audit checks candidate files, the Git index and reachable history, common credential patterns, and package fingerprints. It is not a substitute for a human rights review. Do not turn a private development repository public if its history still contains private material; use an audited code-only export.

`--personal` is a legacy packaging option that includes private reading material. **Never upload its result to GitHub or a Release.** It does not include the new library and is not a general backup. Use the default code-only package for public releases.

The optional icon build script uses Node.js, sharp and macOS iconutil. Reading does not require Node.js or rebuilding icons. Historical internal `redbook` identifiers remain to preserve existing local records and desktop installations.

## 中文说明

书獭支持本机导入 EPUB、PDF、TXT、MOBI、AZW3、FB2，默认英文界面，可在语言选项中切换中文。正文优先英文；单语书按原语言铺满阅读区，不留空栏。有真实对应译文时可开启另一语言对照，不自动翻译，也不把两本书按段号硬配对。

首次运行上面的安装和启动命令；macOS 也可双击启动文件。每个文件最大 60 MiB，须无 DRM。PDF 需要可提取的文字，扫描版不提供 OCR。书和笔记都留在本机，但分别保存在书库目录和浏览器中，备份时两者都要保存。

## License

[MIT](LICENSE) for this project's software, documentation and original icon. Imported books and personal records are excluded. Separately installed tools retain their own licenses. See [third-party notices](THIRD_PARTY_NOTICES.md), [security notes](SECURITY.md) and [contribution guide](CONTRIBUTING.md).
