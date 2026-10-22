# Contributing

Thanks for helping Foliotter become a better place to read.

- Keep book content, images extracted from books, reading records, caches and local paths out of commits and issue attachments.
- Use short original synthetic text for fixtures. Tests should create ebook files at runtime in temporary directories.
- Do not introduce a book download service, DRM bypass or silent remote processing.
- Preserve the original local dataset and record compatibility; imported books must remain separate from each other.
- Document each format's limitations instead of silently claiming full fidelity or automatic translation alignment.
- Keep interface text explicitly localizable. English is the initial UI language; changing it must not translate or modify book content.

Run the tests listed in `README.md`, then run `python3 scripts/audit_release.py`. The audit inspects source and reachable Git history. Review its results before publishing a repository or attaching a ZIP to a release.

Changes to the software are contributed under the project's MIT license. Do not submit code or assets you do not have permission to license on those terms.
