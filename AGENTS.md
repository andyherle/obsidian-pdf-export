# AGENTS.md

## Product rules

- Keep the plugin local-first and desktop-only.
- Do not add telemetry, remote code, runtime downloads, Python, shell commands, or an external browser process.
- Keep the plugin ID `document-pdf-exporter` stable after publication.
- Keep user-facing text simple and direct.
- Do not add file hashes, local paths, or technical provenance pages to exported PDFs.

## Architecture

- `src/core.js`: pure data and parsing functions.
- `src/markdown.js`: static Markdown rendering.
- `src/plugin.js`: Obsidian integration, local files, PDF.js, and Electron PDF output.
- `src/print.css`: exported PDF design.
- `src/styles.css`: plugin UI under `.dpe-*` classes.
- `scripts/build.js`: creates one self-contained `main.js` with no relative runtime imports.

## Required checks

Run `npm run validate` before a release. The checks include tests, a public-tree privacy scan, release validation, and a bundle smoke test.

## Release rules

- Update `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` together.
- Tags use the exact version without a `v` prefix.
- GitHub release assets must include `main.js`, `manifest.json`, and `styles.css`.
- Do not commit generated `main.js`, `dist/`, local Vault data, or credentials.
