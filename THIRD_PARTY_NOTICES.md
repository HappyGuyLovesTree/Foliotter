# Third-party notices

Foliotter's application code, documentation and original geometric book icon are distributed under the MIT license in `LICENSE`. Imported books and personal reading data are excluded; see `NOTICE.md`.

The reader uses Python 3.10+ standard-library modules and browser APIs. Python and the browser are installed by the user, not bundled in the code archive. System fonts such as Georgia, Songti and the platform UI font are requested through CSS; no font files are distributed.

The optional icon build script uses [sharp](https://github.com/lovell/sharp) (Apache-2.0) and macOS `iconutil`. Neither sharp, its libvips dependency nor macOS tools are bundled. The checked-in SVG, PNG and ICNS are this project's original geometric book artwork. Running the reader does not require Node.js, sharp or an icon rebuild.

The EPUB importer is implemented in this project with Python's ZIP and XML libraries. It does not bundle or copy EbookLib, epub.js or an EPUB rendering engine. No proprietary book text, translations, illustrations, external fonts or sample ebooks are part of the distribution. Tests construct their own short synthetic texts in temporary directories.

Historical internal identifiers containing `redbook` remain for compatibility with existing local records and desktop installations. They do not indicate affiliation with an author, publisher or estate.
