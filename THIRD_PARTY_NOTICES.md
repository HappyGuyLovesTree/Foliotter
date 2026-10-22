# Third-party notices

Foliotter's own application code, documentation and original geometric book icon are distributed under the MIT license in `LICENSE`. Imported books and personal reading data are excluded; see `NOTICE.md`.

## Runtime and import tools

Python 3.10+ and the browser are installed by the user, not bundled in the code archive. System fonts such as Georgia, Songti and platform UI fonts are requested through CSS; no font files are distributed. The EPUB, TXT and FB2 processing uses Python standard-library modules plus this project's code.

The optional importer setup installs the exact versions in `requirements-import.txt` into the local `.venv`. They are separate downloads; their code is not vendored in Foliotter's source ZIP. The installed distributions retain their own license files and terms:

| Package / tool | License | Use and upstream source |
| --- | --- | --- |
| pypdf 6.21.2 | BSD-3-Clause | Extract PDF text. [py-pdf/pypdf](https://github.com/py-pdf/pypdf) |
| mobi 0.4.1 / `mobiunpack` | GPL-3.0-only | Independently executed command-line unpacker derived from KindleUnpack. [iscc/mobi](https://github.com/iscc/mobi), [KindleUnpack](https://github.com/kevinhendricks/KindleUnpack) |
| loguru 0.7.3 | MIT | Dependency of the independently installed unpacker. [Delgan/loguru](https://github.com/Delgan/loguru) |
| standard-imghdr 3.13.0 | Python Software Foundation License | Compatibility dependency of the unpacker on recent Python versions. [Standard library redistribution project](https://github.com/youknowone/python-deadlib) |

Foliotter does not copy or import the GPL unpacker's implementation into its application modules. It invokes the separately installed `mobiunpack` executable in a subprocess and exchanges temporary files. Foliotter's MIT license does not relicense that tool. If you redistribute the external tool or its modified code, you must independently follow its GPL terms, including the applicable source obligations. No proprietary Kindle SDK or DRM-removal code is included.

## Optional icon tooling

The icon build script uses [sharp](https://github.com/lovell/sharp) (Apache-2.0) and macOS `iconutil`. Neither sharp, its libvips dependency nor macOS tools are bundled. The checked-in SVG, PNG and ICNS are this project's original geometric book artwork. Reading does not require Node.js, sharp or an icon rebuild.

Tests construct short original synthetic texts and binary fixtures in temporary directories. No proprietary book text, translations, illustrations, external fonts or sample ebooks are part of the distribution.

Historical internal identifiers containing `redbook` remain for compatibility with existing local records and desktop installations. They do not indicate affiliation with an author, publisher or estate.
