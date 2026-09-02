# Architecture

## Goal

Create one deterministic PDF from an ordered set of local notes, PDFs, and images without external software or network access.

## Layers

### Builder

The builder stores an ordered list of normalized sources. Each source has its own enable state and rendering options. Note sources also store excluded heading IDs.

The complete builder state is saved in Obsidian plugin data. Source contents are not copied into saved settings.

### Static Markdown renderer

The renderer handles common Markdown without calling Obsidian's live preview or Markdown post-processor pipeline. This prevents unrelated plugins from changing or breaking the export.

Before Markdown rendering, the embed resolver converts visible local embeds into controlled export tokens:

- Images become temporary local assets.
- Notes become recursive static transclusions.
- PDFs become page images from PDF.js.

Obsidian comments are removed before embed resolution. Raw HTML from notes is escaped.

### PDF rasterizer

`loadPdfJs()` loads the PDF.js build supplied by Obsidian. Selected PDF pages are rendered one at a time to a canvas. The page image is written to the temporary workspace. The canvas and PDF page resources are released before the next page.

### Print document

A self-contained HTML document references only files inside one temporary export workspace. It includes the cover, ordered contents, selected source content, and print CSS.

A hidden Electron `BrowserWindow` loads the document and calls `webContents.printToPDF()`.

The print window is sandboxed. It has context isolation and web security, no Node integration, and blocked navigation and new-window requests.

### Output safety

The returned PDF buffer must contain both the `%PDF-` signature and a final `%%EOF` marker.

The valid PDF is written to a temporary sibling file. When a final file already exists, it is moved to a temporary backup. The new PDF is then moved into place. If replacement fails, the old file is restored. Temporary cleanup does not replace a successful export result.

## Data retention

The plugin stores settings and the last manifest structure in Obsidian plugin data. It does not store source file contents. Temporary render assets are removed after export.
