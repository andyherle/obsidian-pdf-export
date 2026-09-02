# Document PDF Exporter

Document PDF Exporter builds one ordered PDF from Obsidian notes, PDFs, and images.

## Features

- Add notes, PDFs, and images from the Vault or from the computer.
- Drag files into the exact export order.
- Show note headings directly under each note.
- Turn headings on or off inline.
- Reorder sibling heading sections while child sections stay attached.
- Set PDF pages in any order, such as `3,1,2` or `5-3`.
- Add an optional cover, contents page, and page numbers. The cover is off by default.
- Keep export processing local to the desktop app.

The exported PDF does not add file hashes, local file paths, or a technical source appendix.

## Install a release

1. Download the release ZIP.
2. Put the `document-pdf-exporter` folder in `<Vault>/.obsidian/plugins/`.
3. Reload Obsidian and enable **Document PDF Exporter**.
4. Run **Document PDF Exporter: Open document builder**.

## Development

```bash
npm ci
npm run validate
npm run package
```

The source branch does not commit generated `main.js`. A release builds and publishes the standard Obsidian files: `main.js`, `manifest.json`, and `styles.css`.

The plugin is desktop-only because PDF output uses the Electron runtime that is already part of Obsidian. It does not start an external browser, Python process, shell command, or network service.

## License

MIT.
