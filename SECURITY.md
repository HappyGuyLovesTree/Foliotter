# Security and privacy

Foliotter is a local desktop reader. The Python server listens on `127.0.0.1`; it is not designed to be exposed to the Internet, a reverse proxy or a shared network.

## Local content

The browser sends a selected EPUB to the local Python service. Converted reading data and supported images are stored in `user-library/` beside the application. The source EPUB is not retained by the importer. The reader does not upload imported books to a remote service. Imported books do not enable the historical project's online interpretation feature.

Reading position, favorites and notes are saved in the browser, separately for each imported book. Export reading records before changing browser profiles, clearing site data, moving to a different port or removing the application. A code ZIP is not a backup of books or reading records.

## EPUB boundary

Only supported, unencrypted, reflowable EPUB files are accepted. The importer uses bounded ZIP/XML processing and constructs reading data from text and supported raster images. It does not execute embedded JavaScript, load remote book resources or bypass DRM. It does not reproduce arbitrary book HTML, CSS or embedded fonts. Importing a file is not an endorsement of its source or a grant of rights to redistribute it.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting channel if enabled for the repository. Otherwise open an issue containing only a high-level description and request a private contact method before sharing exploit details. Do not attach a copyrighted ebook, personal notes, credentials or an actual user's library. Prefer a minimal synthetic EPUB that you created and have permission to share.
