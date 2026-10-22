# Security and privacy

Foliotter is a local reader. The Python server listens on `127.0.0.1`; it is not designed to be exposed to the Internet, a reverse proxy or a shared network.

## Local content

The browser sends a selected ebook to the local Python service. Converted text and supported images are stored in `user-library/` beside the application. The source upload and temporary conversion outputs are removed after processing. The reader does not upload imported books to a remote service. Importing a book does not enable the historical project's online interpretation feature.

Positions, favorites and notes are saved in the browser, separately for each imported book. Export records before changing browser profiles, clearing site data, moving to a different port or removing the application. A code ZIP is not a backup of books or records.

Interface and reading-language preferences are separate. Translation columns use existing corresponding content only. Foliotter does not submit book text to an automatic translation service.

## Import boundary

Accepted inputs are supported, unencrypted EPUB, text PDF, TXT, MOBI, AZW3 and FB2 files, up to 60 MiB. Import requests require the local page's exact origin. Processing applies byte, archive, XML, time and conversion limits. Text extraction does not execute book scripts, load remote book resources or bypass DRM. Original arbitrary HTML, CSS, fonts and interactive content are not reproduced.

PDF text parsing and Kindle unpacking use separately installed open-source tools. Conversion uses local subprocesses and temporary directories. On macOS, the parent periodically checks the owned conversion process group's memory and terminates it above the configured 768 MiB threshold; polling is not an instantaneous hard memory limit. Linux also applies a 1 GiB address-space limit. These controls are not a complete operating-system sandbox or a guarantee against every parser vulnerability. Keep the import tools current with reviewed dependency updates. Scanned PDFs are not sent to an OCR service; unsupported or unusable files receive an error.

Installing import tools downloads software from the configured Python package registry. Reading and import do not need a cloud account. The public package excludes `.venv`, source books, converted libraries, caches, personal records and private development evidence.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting channel if enabled for the repository. Otherwise open an issue containing only a high-level description and request a private contact method before sharing exploit details. Do not attach a copyrighted ebook, personal notes, credentials or an actual user's library. Prefer a minimal synthetic file that you created and have permission to share.
