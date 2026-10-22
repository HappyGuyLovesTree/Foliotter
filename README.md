# Foliotter

**Open a book. Let chance choose.**

Foliotter is a local ebook reader built around one button: **Random passage**. Bring a book you own, click, and land somewhere unexpected in its text. Stay with a thought, follow it into the next passage, or let chance take you somewhere else.

For the book you keep meaning to start. For the one you thought you knew. For five quiet minutes with a passage you would not have chosen yourself.

## One click, an unexpected passage

1. **Bring a book.** Import an ebook and open it from your local library.
2. **Click Random passage.** Meet a passage from the book you have open, in your selected reading language.
3. **Follow what catches you.** Keep reading from there, bookmark it, leave a note, or draw another passage.

The random encounter is the heart of Foliotter. Importing, navigation and notes help you get to it and keep what you find.

- **Explore a shuffled round.** Eligible passages are shuffled, then drawn without repeating within that round. A new round starts when the pool runs out; changing the reading language or available pool starts a fresh queue. A book with only one eligible passage can repeat it.
- **Keep the passage in its book.** Read the original text with its chapter and position, then continue through the surrounding passages using the reading controls.
- **Keep a trail.** Bookmark a discovery, add your own note, or revisit it from reading history. Records stay in this browser and can be exported.
- **Let the language follow your choice.** Random reading defaults to English when available. A single-language book uses its own language, with no empty translation column.

Random draws come from the **current book**, not from the whole library. Imported books use their non-empty prose units; headings and image-only units are excluded. Passage boundaries depend on the source file and its conversion. Draws show the book's text, without generating or translating it.

**This repository contains MIT-licensed software and original icons only.** It includes no books, translations, publisher notes or book artwork. Supply ebooks you have the right to use. The software license does not grant rights to redistribute a book; see [NOTICE](NOTICE.md).

## Try your first encounter

Install Python 3.10 or later, download and extract the code, then run these commands from the extracted folder:

```sh
python3 -B scripts/setup_importers.py --ensure
python3 -B scripts/serve.py --open
```

Setup downloads the pinned import tools into this project's `.venv`. It downloads software, not books. Later runs reuse installed versions. The server automatically uses this environment when it exists. EPUB, TXT and FB2 do not require the optional PDF/Kindle tools; without them, those formats remain available and the library explains how to enable the others.

Open `http://127.0.0.1:8787/`, choose a file in the library, and select **Import and read**. A fresh installation opens the library automatically. Once the book opens, click **Random passage**. Imported books stay in your library and can be reopened from the reading page.

On macOS, double-click `Start Foliotter.command` to set up the import tools and launch the reader. For a desktop shortcut and background service, use `Install Foliotter.command`. A new installation creates `Foliotter.app`. Keep the extracted folder in its installed location. Existing local installations retain their shortcut and browser address.

If port 8787 is already occupied, use `python3 -B scripts/serve.py --port 8788 --open`. Browser records belong to their address: export them before changing ports. The server listens on the local computer only; do not expose it to the public Internet.

## Bring your own books

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

The interface starts in **English**. Choose **Chinese** in the language selector to switch it. This setting is separate from the language of your book.

- The default reading language is **English**, when the book has English text. Random passages follow the selected reading language.
- With a single-language book, the reader uses that language and fills the available page. It does not reserve an empty translation column.
- The optional comparison column shows a **real corresponding passage**, when one exists. The current primary/secondary language choices are English and Chinese; comparison is off by default.
- Changing the interface to Chinese does not change the book's reading language.
- Foliotter does **not** automatically translate, match unrelated passages, or pair separately imported books by paragraph number. Ordinary single-language imports remain single-language books. Existing local material with verified bilingual mappings remains compatible; those private texts and mappings are not distributed here.

Supporting tools include contents, pagination, type-size controls, search, favorites, notes, and record export/restore. Importing the exact same file reopens the existing book instead of adding another copy.

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

## License

[MIT](LICENSE) for this project's software, documentation and original icon. Imported books and personal records are excluded. Separately installed tools retain their own licenses. See [third-party notices](THIRD_PARTY_NOTICES.md), [security notes](SECURITY.md) and [contribution guide](CONTRIBUTING.md).
