const obsidian = require("obsidian");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const PLUGIN_VERSION = __DPE_VERSION__;
const PLUGIN_NAME = "Document PDF Exporter";
const PRINT_CSS = __DPE_PRINT_CSS__;
const SUPPORTED_EXTENSIONS = new Set(["md", "pdf", ...core.IMAGE_EXTENSIONS]);
const PAGE_HEIGHTS = { Letter: "11in", A4: "11.6929in", Legal: "14in" };
const MARGIN_PRESETS = {
    normal: { css: "0.62in 0.65in 0.56in", verticalIn: 1.18 },
    narrow: { css: "0.40in 0.42in 0.38in", verticalIn: 0.78 },
    wide: { css: "0.82in 0.84in 0.74in", verticalIn: 1.56 },
};
const QUALITY_PRESETS = {
    compact: { scale: 1.45, mime: "image/jpeg", quality: 0.86, maxPixels: 2600 },
    balanced: { scale: 2.0, mime: "image/jpeg", quality: 0.93, maxPixels: 3600 },
    high: { scale: 2.65, mime: "image/jpeg", quality: 0.96, maxPixels: 4800 },
};
const DEFAULT_SETTINGS = {
    settingsVersion: 2,
    brand: "DOCUMENT",
    defaultSubtitle: "",
    defaultPageSize: "Letter",
    defaultMargin: "normal",
    defaultQuality: "balanced",
    outputFolder: "",
    cover: false,
    toc: true,
    pageNumbers: true,
    openAfterExport: true,
    maxTransclusionDepth: 8,
    onboardingComplete: false,
    lastManifest: null,
};

class ManifestCancelError extends Error {
    constructor(message = "Cancelled") {
        super(message);
        this.name = "ManifestCancelError";
    }
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cloneData(value) {
    if (typeof structuredClone === "function") {
        try { return structuredClone(value); } catch (_) {}
    }
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function processError(error) {
    const message = String(error?.message || error || "Unknown error");
    return message.length > 900 ? `${message.slice(0, 900)}…` : message;
}

function sourceKindLabel(kind) {
    if (kind === "note") return "Note";
    if (kind === "pdf") return "PDF";
    if (kind === "image") return "Image";
    return "File";
}

function iconForKind(kind) {
    if (kind === "note") return "file-text";
    if (kind === "pdf") return "file-type-2";
    if (kind === "image") return "image";
    return "file";
}

function extensionFromPath(value) {
    return core.extensionOf(String(value || ""));
}

function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
}

function uniqueFilePath(directory, fileName) {
    const parsed = path.parse(fileName);
    let candidate = path.join(directory, fileName);
    let number = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(directory, `${parsed.name} (${number})${parsed.ext}`);
        number += 1;
    }
    return candidate;
}

function normalizeExternalPath(value) {
    return path.resolve(String(value || ""));
}

function formatLocalDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function withTimeout(promise, milliseconds, message) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), milliseconds);
        }),
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function replaceFileAtomically(temporaryPath, outputPath) {
    const backupPath = `${outputPath}.previous-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const hadExisting = fs.existsSync(outputPath);
    try {
        if (hadExisting) fs.renameSync(outputPath, backupPath);
        fs.renameSync(temporaryPath, outputPath);
        if (hadExisting) fs.rmSync(backupPath, { force: true });
    } catch (error) {
        try {
            if (!fs.existsSync(outputPath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, outputPath);
        } catch (restoreError) {
            error.message += `\nThe previous PDF could not be restored automatically: ${processError(restoreError)}`;
        }
        throw error;
    } finally {
        try { if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
        try { if (fs.existsSync(backupPath) && fs.existsSync(outputPath)) fs.rmSync(backupPath, { force: true }); } catch (_) {}
    }
}

function htmlToken(context, html) {
    const index = context.htmlTokens.push(html) - 1;
    return `\n@@DPE_HTML_${index}@@\n`;
}

function flattenProperties(value, prefix = "", rows = []) {
    if (value == null || value === "") return rows;
    if (Array.isArray(value)) {
        rows.push([prefix, value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ")]);
        return rows;
    }
    if (typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            flattenProperties(child, prefix ? `${prefix}.${key}` : key, rows);
        }
        return rows;
    }
    rows.push([prefix, String(value)]);
    return rows;
}

function propertyTable(rawFrontmatter) {
    if (!rawFrontmatter.trim()) return "";
    let parsed;
    try { parsed = obsidian.parseYaml(rawFrontmatter); } catch (_) { parsed = null; }
    const rows = parsed && typeof parsed === "object"
        ? flattenProperties(parsed)
        : rawFrontmatter.split("\n").map((line) => {
            const separator = line.indexOf(":");
            return separator >= 0 ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] : ["Property", line.trim()];
        }).filter((row) => row[1]);
    if (!rows.length) return "";
    return `<div class="pdf-export-properties"><table><tbody>${rows.map(([key, value]) => `<tr><td>${core.escapeHtml(key)}</td><td>${core.escapeHtml(value)}</td></tr>`).join("")}</tbody></table></div>`;
}

function makeManifestState(settings, activeFile) {
    const previous = settings.lastManifest && typeof settings.lastManifest === "object" ? cloneData(settings.lastManifest) : null;
    if (previous) {
        previous.sources = Array.isArray(previous.sources) ? previous.sources.map(core.normalizeSource) : [];
        previous.title = String(previous.title || "Manifest");
        previous.subtitle = String(previous.subtitle || settings.defaultSubtitle || "");
        previous.pageSize = previous.pageSize || settings.defaultPageSize;
        previous.margin = previous.margin || settings.defaultMargin;
        previous.quality = previous.quality || settings.defaultQuality;
        previous.cover = previous.cover === true;
        previous.toc = previous.toc !== false;
        previous.pageNumbers = previous.pageNumbers !== false;
        previous.openAfterExport = previous.openAfterExport !== false;
        return previous;
    }
    return {
        title: activeFile?.basename || "Manifest",
        subtitle: settings.defaultSubtitle || "",
        pageSize: settings.defaultPageSize,
        margin: settings.defaultMargin,
        quality: settings.defaultQuality,
        cover: false,
        toc: settings.toc,
        pageNumbers: settings.pageNumbers,
        openAfterExport: settings.openAfterExport,
        sources: activeFile ? [core.normalizeSource({ location: "vault", path: activeFile.path })] : [],
    };
}

class ExportWorkspace {
    constructor() {
        this.root = fs.mkdtempSync(path.join(os.tmpdir(), "document-pdf-exporter-"));
        this.assets = path.join(this.root, "assets");
        ensureDirectory(this.assets);
        this.counter = 0;
    }

    nextAsset(prefix, extension) {
        this.counter += 1;
        const safe = core.safeFilename(prefix || "asset", "asset").replace(/\s+/g, "-").toLowerCase();
        return path.join(this.assets, `${String(this.counter).padStart(4, "0")}-${safe}.${String(extension || "bin").replace(/^\./, "")}`);
    }

    writeAsset(prefix, extension, bytes) {
        const target = this.nextAsset(prefix, extension);
        fs.writeFileSync(target, bytes);
        return pathToFileURL(target).href;
    }

    writeHtml(html) {
        const target = path.join(this.root, "manifest.html");
        fs.writeFileSync(target, html, "utf8");
        return target;
    }

    cleanup() {
        try { fs.rmSync(this.root, { recursive: true, force: true }); } catch (_) {}
    }
}

class PdfRasterizer {
    constructor(plugin, workspace, quality, progress) {
        this.plugin = plugin;
        this.workspace = workspace;
        this.quality = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced;
        this.progress = progress;
        this.pdfjs = null;
    }

    async ensurePdfJs() {
        if (!this.pdfjs) this.pdfjs = await obsidian.loadPdfJs();
        return this.pdfjs;
    }

    async render(source, range = "all", label = "PDF") {
        const pdfjs = await this.ensurePdfJs();
        const bytes = await this.plugin.readSourceBinary(source);
        const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableAutoFetch: false });
        const pdf = await task.promise;
        const pages = core.parsePageRange(range || "all", pdf.numPages);
        const rendered = [];
        try {
            for (let index = 0; index < pages.length; index += 1) {
                const pageNumber = pages[index];
                this.progress?.(`Rendering ${label}: page ${pageNumber} of ${pdf.numPages}`, null);
                const page = await pdf.getPage(pageNumber);
                const base = page.getViewport({ scale: 1 });
                const capScale = Math.min(this.quality.scale, this.quality.maxPixels / Math.max(base.width, base.height));
                const viewport = page.getViewport({ scale: Math.max(1, capScale) });
                const canvas = obsidian.activeDocument.createElement("canvas");
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                const context = canvas.getContext("2d", { alpha: false });
                if (!context) throw new Error(`Could not create a canvas for ${label}, page ${pageNumber}.`);
                context.fillStyle = "#ffffff";
                context.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvasContext: context, viewport, background: "#ffffff" }).promise;
                const dataUrl = canvas.toDataURL(this.quality.mime, this.quality.quality);
                const comma = dataUrl.indexOf(",");
                const bytesOut = Buffer.from(dataUrl.slice(comma + 1), "base64");
                const extension = this.quality.mime === "image/png" ? "png" : "jpg";
                const url = this.workspace.writeAsset(`${core.titleFromPath(source.path)}-page-${pageNumber}`, extension, bytesOut);
                rendered.push({ pageNumber, totalPages: pdf.numPages, url, width: canvas.width, height: canvas.height });
                page.cleanup?.();
                canvas.width = 1;
                canvas.height = 1;
                await sleep(0);
            }
        } finally {
            try { await pdf.destroy(); } catch (_) {}
        }
        return rendered;
    }
}

class DocumentBuilder {
    constructor(plugin, state, workspace, progress) {
        this.plugin = plugin;
        this.state = state;
        this.workspace = workspace;
        this.progress = progress;
        this.rasterizer = new PdfRasterizer(plugin, workspace, state.quality, progress);
        this.sourceRecords = [];
    }

    async build() {
        const enabled = this.state.sources.filter((source) => source.enabled !== false);
        if (!enabled.length) throw new Error("Add at least one source before export.");
        const sections = [];
        for (let index = 0; index < enabled.length; index += 1) {
            const source = core.normalizeSource(enabled[index]);
            this.progress?.(`Preparing ${index + 1} of ${enabled.length}: ${source.title}`, Math.round((index / Math.max(1, enabled.length)) * 72));
            sections.push(await this.renderSource(source, index));
        }
        this.progress?.("Building the final document", 78);
        const cover = this.state.cover ? this.renderCover(enabled.length) : "";
        const toc = this.state.toc ? this.renderContents(enabled) : "";
        return this.wrapHtml([cover, toc, sections.join("\n")].filter(Boolean).join("\n"));
    }

    sourceHeader(source) {
        if (!source.showSourceHeader || source.kind === "pdf") return "";
        return `<header class="pdf-export-source-header"><div class="pdf-export-source-title">${core.escapeHtml(source.title)}</div><div class="pdf-export-source-meta">${sourceKindLabel(source.kind)}</div></header>`;
    }

    async renderSource(source, index) {
        const classes = ["pdf-export-source", `pdf-export-source-${source.kind}`, source.startOnNewPage && index > 0 ? "pdf-export-new-page" : ""].filter(Boolean).join(" ");
        if (source.kind === "note") {
            const content = await this.renderNote(source, 0, new Set());
            return `<section class="${classes}" data-source="${core.escapeHtml(source.id)}">${this.sourceHeader(source)}<div class="pdf-export-note">${content}</div></section>`;
        }
        if (source.kind === "image") {
            const url = await this.plugin.materializeImage(source, this.workspace);
            const caption = source.showImageCaption ? (source.caption.trim() || source.title) : "";
            return `<section class="${classes}" data-source="${core.escapeHtml(source.id)}">${this.sourceHeader(source)}<figure class="pdf-export-image-page fit-${core.escapeHtml(source.imageFit)}"><img src="${core.escapeHtml(url)}" alt="${core.escapeHtml(source.title)}">${caption ? `<figcaption>${core.escapeHtml(caption)}</figcaption>` : ""}</figure></section>`;
        }
        if (source.kind === "pdf") {
            const pages = await this.rasterizer.render(source, source.pageRange, source.title);
            return `<section class="${classes}" data-source="${core.escapeHtml(source.id)}">${pages.map((page, pageIndex) => `<div class="pdf-export-pdf-page${pageIndex === 0 ? " first" : ""}"><img src="${core.escapeHtml(page.url)}" alt="${core.escapeHtml(`${source.title}, page ${page.pageNumber}`)}"><div class="pdf-export-pdf-page-label">Page ${page.pageNumber} of ${page.totalPages}</div></div>`).join("\n")}</section>`;
        }
        throw new Error(`Unsupported source type: ${source.path}`);
    }

    async renderNote(source, depth, seen) {
        const identity = `${source.location}:${source.path}`;
        if (seen.has(identity)) return `<div class="pdf-export-export-warning">A repeated note embed was skipped.</div>`;
        if (depth > this.plugin.settings.maxTransclusionDepth) return `<div class="pdf-export-export-warning">A deeply nested note embed was skipped.</div>`;
        seen = new Set(seen);
        seen.add(identity);
        const raw = await this.plugin.readSourceText(source);
        const frontmatter = core.stripFrontmatter(raw);
        const reordered = core.reorderSections(frontmatter.body, source.sectionOrder);
        const filtered = core.filterSections(reordered, source.excludedSections, source.includePreamble);
        const context = { htmlTokens: [] };
        const visibleMarkdown = staticMarkdown.stripObsidianComments(filtered.markdown);
        const prepared = await this.resolveEmbeds(visibleMarkdown, source, context, depth, seen);
        const body = staticMarkdown.renderStaticMarkdown(prepared, { htmlTokens: context.htmlTokens });
        return `${source.includeFrontmatter ? propertyTable(frontmatter.raw) : ""}${body}`;
    }

    async resolveEmbeds(markdown, source, context, depth, seen) {
        const segments = core.splitFencedSegments(markdown);
        const output = [];
        for (const segment of segments) {
            if (segment.fenced) output.push(segment.text);
            else output.push(await this.resolveSegment(segment.text, source, context, depth, seen));
        }
        return output.join("\n");
    }

    async resolveSegment(text, source, context, depth, seen) {
        const wikiMatches = [...text.matchAll(/!\[\[([^\]]+)\]\]/g)];
        for (const match of wikiMatches.reverse()) {
            const parsed = core.parseWikiEmbed(match[1]);
            const target = this.plugin.resolveTarget(parsed.linkpath, source);
            let replacement = `*[missing embed: ${parsed.rawTarget}]*`;
            if (target) {
                const kind = core.kindFromPath(target.path);
                if (kind === "image") {
                    const url = await this.plugin.materializeImage(target, this.workspace);
                    const width = parsed.alias.match(/^(\d+)/)?.[1];
                    replacement = htmlToken(context, `<figure class="pdf-export-inline-image"><img src="${core.escapeHtml(url)}" alt="${core.escapeHtml(parsed.alias || core.titleFromPath(target.path))}"${width ? ` width="${Math.max(1, Math.min(10000, Number(width)))}"` : ""}></figure>`);
                } else if (kind === "pdf") {
                    const range = core.parsePdfPageRangeFromAnchor(parsed.anchor) || parsed.alias.match(/^[0-9,\-]+$/)?.[0] || "all";
                    const pages = await this.rasterizer.render(target, range, core.titleFromPath(target.path));
                    replacement = htmlToken(context, `<div class="pdf-export-embedded-pdf">${pages.map((page) => `<div class="pdf-export-pdf-page"><img src="${core.escapeHtml(page.url)}" alt="PDF page ${page.pageNumber}"><div class="pdf-export-pdf-page-label">Page ${page.pageNumber} of ${page.totalPages}</div></div>`).join("")}</div>`);
                } else if (kind === "note") {
                    const noteSource = core.normalizeSource({ ...target, title: core.titleFromPath(target.path), showSourceHeader: false, includeFrontmatter: false });
                    const nestedIdentity = `${noteSource.location}:${noteSource.path}`;
                    if (seen.has(nestedIdentity)) {
                        replacement = htmlToken(context, `<div class="pdf-export-export-warning">Circular note embed stopped: ${core.escapeHtml(core.titleFromPath(noteSource.path))}</div>`);
                    } else if (depth + 1 > this.plugin.settings.maxTransclusionDepth) {
                        replacement = htmlToken(context, `<div class="pdf-export-export-warning">Maximum note embed depth reached: ${core.escapeHtml(core.titleFromPath(noteSource.path))}</div>`);
                    } else {
                        let noteText = await this.plugin.readSourceText(noteSource);
                        noteText = core.stripFrontmatter(noteText).body;
                        if (parsed.anchor) noteText = core.sliceAnchor(noteText, parsed.anchor);
                        noteText = staticMarkdown.stripObsidianComments(noteText);
                        const nestedSeen = new Set(seen);
                        nestedSeen.add(nestedIdentity);
                        const prepared = await this.resolveEmbeds(noteText, noteSource, context, depth + 1, nestedSeen);
                        const nestedHtml = staticMarkdown.renderStaticMarkdown(prepared, { htmlTokens: context.htmlTokens });
                        replacement = htmlToken(context, `<div class="pdf-export-transclusion"><div class="pdf-export-transclusion-label">Embedded note · ${core.escapeHtml(core.titleFromPath(target.path))}</div>${nestedHtml}</div>`);
                    }
                }
            }
            text = text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
        }

        const markdownImages = [...text.matchAll(/!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g)];
        for (const match of markdownImages.reverse()) {
            const alt = match[1] || "";
            const rawTarget = decodeURIComponent(match[2].replace(/^<|>$/g, "")).split("#")[0];
            if (/^(https?:|data:)/i.test(rawTarget)) continue;
            const target = this.plugin.resolveTarget(rawTarget, source);
            if (!target || core.kindFromPath(target.path) !== "image") continue;
            const url = await this.plugin.materializeImage(target, this.workspace);
            const width = alt.match(/\|(\d+)/)?.[1];
            const cleanAlt = alt.replace(/\|\d+.*$/, "");
            const replacement = htmlToken(context, `<figure class="pdf-export-inline-image"><img src="${core.escapeHtml(url)}" alt="${core.escapeHtml(cleanAlt)}"${width ? ` width="${Math.max(1, Math.min(10000, Number(width)))}"` : ""}></figure>`);
            text = text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
        }
        return text;
    }

    renderCover(sourceCount) {
        const date = formatLocalDate();
        return `<section class="pdf-export-cover"><div><div class="pdf-export-cover-top"><div class="pdf-export-eyebrow">${core.escapeHtml(this.plugin.settings.brand || "Manifest")}</div></div><h1 class="pdf-export-cover-title">${core.escapeHtml(this.state.title)}</h1>${this.state.subtitle ? `<div class="pdf-export-cover-subtitle">${core.escapeHtml(this.state.subtitle)}</div>` : ""}</div><div class="pdf-export-cover-bottom"><div><span class="pdf-export-label">Document</span><br>${sourceCount} file${sourceCount === 1 ? "" : "s"}</div><div><span class="pdf-export-label">Prepared</span><br>${date}</div></div></section>`;
    }

    renderContents(sources) {
        return `<section class="pdf-export-contents"><div class="pdf-export-section-label">Ordered document</div><h1>Contents</h1><div class="pdf-export-toc-list">${sources.map((source, index) => `<div class="pdf-export-toc-row"><div class="pdf-export-toc-number">${String(index + 1).padStart(2, "0")}</div><div class="pdf-export-toc-title">${core.escapeHtml(source.title)}</div><div class="pdf-export-toc-kind">${sourceKindLabel(source.kind)}</div></div>`).join("")}</div></section>`;
    }

    wrapHtml(body) {
        const pageSize = PAGE_HEIGHTS[this.state.pageSize] ? this.state.pageSize : "Letter";
        const margin = MARGIN_PRESETS[this.state.margin] || MARGIN_PRESETS.normal;
        return `<!doctype html><html><head><meta charset="utf-8"><title>${core.escapeHtml(this.state.title)}</title><style>:root{--pdf-export-page-height:${PAGE_HEIGHTS[pageSize]};--pdf-export-content-height:calc(${PAGE_HEIGHTS[pageSize]} - ${margin.verticalIn}in);}@page{size:${pageSize};margin:${margin.css};}</style><style>${PRINT_CSS}</style></head><body><main class="pdf-export-document">${body}</main></body></html>`;
    }
}

class ManifestExporterPlugin extends obsidian.Plugin {
    async onload() {
        const loadedSettings = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings || {});
        if ((Number(loadedSettings?.settingsVersion) || 0) < 2) {
            this.settings.cover = false;
            if (this.settings.lastManifest && typeof this.settings.lastManifest === "object") this.settings.lastManifest.cover = false;
            this.settings.settingsVersion = 2;
            await this.saveData(this.settings);
        }
        this.addRibbonIcon("files", "Open Document PDF Exporter", () => this.openBuilder());
        this.addCommand({ id: "open-document-builder", name: "Open document builder", callback: () => this.openBuilder() });
        this.addCommand({ id: "export-active-note", name: "Export active note as PDF", checkCallback: (checking) => {
            const file = this.app.workspace.getActiveFile();
            if (!file || file.extension !== "md") return false;
            if (!checking) {
                const state = makeManifestState(this.settings, null);
                state.title = file.basename;
                state.sources = [core.normalizeSource({ location: "vault", path: file.path })];
                new ManifestBuilderModal(this, state).open();
            }
            return true;
        }});
        this.addSettingTab(new ManifestExporterSettingTab(this.app, this));
        this.app.workspace.onLayoutReady(() => {
            if (!this.settings.onboardingComplete) new WelcomeModal(this).open();
        });
    }

    onunload() {}

    async saveSettings() {
        await this.saveData(this.settings);
    }

    openBuilder() {
        const active = this.app.workspace.getActiveFile();
        new ManifestBuilderModal(this, makeManifestState(this.settings, active?.extension === "md" ? active : null)).open();
    }

    vaultFile(pathValue) {
        const file = this.app.vault.getAbstractFileByPath(pathValue);
        return file instanceof obsidian.TFile ? file : null;
    }

    async readSourceBinary(source) {
        if (source.location === "external") return fs.promises.readFile(normalizeExternalPath(source.path));
        const file = this.vaultFile(source.path);
        if (!file) throw new Error(`Vault file not found: ${source.path}`);
        return Buffer.from(await this.app.vault.readBinary(file));
    }

    async readSourceText(source) {
        if (source.location === "external") return fs.promises.readFile(normalizeExternalPath(source.path), "utf8");
        const file = this.vaultFile(source.path);
        if (!file) throw new Error(`Vault file not found: ${source.path}`);
        return this.app.vault.cachedRead(file);
    }

    resolveTarget(linkpath, source) {
        const clean = String(linkpath || "").trim().replace(/^<|>$/g, "");
        if (!clean) return null;
        if (source.location === "vault") {
            const target = this.app.metadataCache.getFirstLinkpathDest(clean, source.path);
            if (target) return { location: "vault", path: target.path };
            const direct = this.vaultFile(obsidian.normalizePath(clean));
            if (direct) return { location: "vault", path: direct.path };
        }
        if (source.location === "external") {
            const targetPath = path.resolve(path.dirname(source.path), clean);
            if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) return { location: "external", path: targetPath };
        }
        return null;
    }

    async materializeImage(source, workspace) {
        const extension = extensionFromPath(source.path);
        const bytes = await this.readSourceBinary(source);
        return workspace.writeAsset(core.titleFromPath(source.path), extension || "bin", bytes);
    }

    getElectronApi() {
        try {
            const remote = require("@electron/remote");
            if (remote) return remote;
        } catch (_) {}
        try {
            const electron = require("electron");
            if (electron?.remote) return electron.remote;
            return electron;
        } catch (_) {
            return null;
        }
    }

    async chooseExternalSources() {
        const electron = this.getElectronApi();
        const dialog = electron?.dialog;
        if (!dialog?.showOpenDialog) throw new Error("The operating-system file picker is not available.");
        const result = await dialog.showOpenDialog({
            title: "Add notes, PDFs, or images",
            properties: ["openFile", "multiSelections"],
            filters: [
                { name: "Supported sources", extensions: [...SUPPORTED_EXTENSIONS] },
                { name: "All files", extensions: ["*"] },
            ],
        });
        if (result.canceled) return [];
        return result.filePaths
            .filter((filePath) => SUPPORTED_EXTENSIONS.has(extensionFromPath(filePath)))
            .map((filePath) => core.normalizeSource({ location: "external", path: filePath }));
    }

    async chooseOutputPath(state) {
        const electron = this.getElectronApi();
        const dialog = electron?.dialog;
        const fileName = `${core.safeFilename(state.title, "export")}.pdf`;
        if (dialog?.showSaveDialog) {
            const basePath = this.app.vault.adapter.getBasePath?.();
            const defaultDirectory = this.settings.outputFolder
                ? (path.isAbsolute(this.settings.outputFolder) ? this.settings.outputFolder : (basePath ? path.join(basePath, this.settings.outputFolder) : ""))
                : "";
            const result = await dialog.showSaveDialog({
                title: "Export PDF",
                defaultPath: defaultDirectory ? path.join(defaultDirectory, fileName) : fileName,
                filters: [{ name: "PDF", extensions: ["pdf"] }],
            });
            if (result.canceled || !result.filePath) throw new ManifestCancelError();
            return result.filePath.toLowerCase().endsWith(".pdf") ? result.filePath : `${result.filePath}.pdf`;
        }
        const basePath = this.app.vault.adapter.getBasePath?.();
        if (!basePath) throw new Error("Could not open the save dialog or determine the Vault folder.");
        const directory = this.settings.outputFolder
            ? (path.isAbsolute(this.settings.outputFolder) ? this.settings.outputFolder : path.join(basePath, this.settings.outputFolder))
            : basePath;
        ensureDirectory(directory);
        return uniqueFilePath(directory, fileName);
    }

    async renderPdf(htmlPath, state, progress) {
        const electron = this.getElectronApi();
        const BrowserWindow = electron?.BrowserWindow;
        if (!BrowserWindow) throw new Error("PDF export is not available in this Obsidian version.");
        const win = new BrowserWindow({
            show: false,
            width: 1000,
            height: 1200,
            backgroundColor: "#ffffff",
            webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                webSecurity: true,
                backgroundThrottling: false,
                javascript: true,
            },
        });
        try {
            win.webContents?.setWindowOpenHandler?.(() => ({ action: "deny" }));
            win.webContents?.on?.("will-navigate", (event, targetUrl) => {
                const expected = pathToFileURL(htmlPath).href;
                if (targetUrl !== expected) event.preventDefault();
            });
            progress?.("Opening the isolated print document", 82);
            await withTimeout(
                win.loadFile(htmlPath),
                60_000,
                "The print document took too long to load.",
            );
            await withTimeout(
                win.webContents.executeJavaScript(`Promise.all([document.fonts ? document.fonts.ready : Promise.resolve(), ...Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = img.onerror = r; }))]).then(() => true)`),
                60_000,
                "The print document did not finish loading its images.",
            );
            progress?.("Printing the final PDF", 90);
            const pageSize = PAGE_HEIGHTS[state.pageSize] ? state.pageSize : "Letter";
            const displayHeaderFooter = state.pageNumbers !== false;
            return await withTimeout(
                win.webContents.printToPDF({
                    printBackground: true,
                    pageSize,
                    preferCSSPageSize: true,
                    displayHeaderFooter,
                    headerTemplate: "<div></div>",
                    footerTemplate: displayHeaderFooter
                        ? `<div style="width:100%;font-family:monospace;font-size:8px;color:#888;text-align:center;padding:0 20px;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`
                        : "<div></div>",
                    margins: { top: 0, bottom: 0, left: 0, right: 0 },
                }),
                90_000,
                "PDF printing timed out after 90 seconds.",
            );
        } finally {
            try { if (!win.isDestroyed()) win.close(); } catch (_) {}
        }
    }

    async exportManifest(state, progress) {
        const outputPath = await this.chooseOutputPath(state);
        const workspace = new ExportWorkspace();
        let temporaryTarget = null;
        try {
            const builder = new DocumentBuilder(this, state, workspace, progress);
            const html = await builder.build();
            const htmlPath = workspace.writeHtml(html);
            const pdf = await this.renderPdf(htmlPath, state, progress);
            const pdfBuffer = Buffer.from(pdf || []);
            const hasHeader = pdfBuffer.length >= 5 && pdfBuffer.subarray(0, 5).equals(Buffer.from("%PDF-"));
            const hasEndMarker = pdfBuffer.subarray(Math.max(0, pdfBuffer.length - 4096)).includes(Buffer.from("%%EOF"));
            if (pdfBuffer.length < 1000 || !hasHeader || !hasEndMarker) {
                throw new Error("The PDF could not be completed.");
            }
            ensureDirectory(path.dirname(outputPath));
            temporaryTarget = `${outputPath}.partial-${Date.now()}`;
            fs.writeFileSync(temporaryTarget, pdfBuffer);
            replaceFileAtomically(temporaryTarget, outputPath);
            temporaryTarget = null;
            progress?.("Export complete", 100);
            if (state.openAfterExport) {
                try {
                    const electronModule = require("electron");
                    await electronModule?.shell?.openPath?.(outputPath);
                } catch (_) {}
            }
            return { outputPath, bytes: pdfBuffer.length, sourceCount: state.sources.filter((source) => source.enabled !== false).length };
        } finally {
            if (temporaryTarget) {
                try { fs.rmSync(temporaryTarget, { force: true }); } catch (_) {}
            }
            workspace.cleanup();
        }
    }
}

class WelcomeModal extends obsidian.Modal {
    constructor(plugin) {
        super(plugin.app);
        this.plugin = plugin;
    }

    onOpen() {
        this.modalEl.addClass("dpe-onboarding");
        this.titleEl.empty();
        const hero = this.contentEl.createDiv({ cls: "dpe-onboarding-hero" });
        hero.createDiv({ cls: "dpe-kicker", text: "Document PDF Exporter" });
        hero.createEl("h1", { text: "One clean PDF from every source." });
        hero.createEl("p", {
            cls: "dpe-onboarding-copy",
            text: "Add notes, PDFs, JPEGs, PNGs, WebP images, and other supported images. Put them in the exact order you need. Turn off any note section. Export one consistent document.",
        });
        const grid = this.contentEl.createDiv({ cls: "dpe-onboarding-grid" });
        const cards = [
            ["1 · Add", "Choose Vault files or normal files from your computer."],
            ["2 · Arrange", "Choose and reorder note headings directly under each file."],
            ["3 · Export", "Create one polished PDF without leaving Obsidian."],
        ];
        for (const [title, text] of cards) {
            const card = grid.createDiv({ cls: "dpe-onboarding-card" });
            card.createEl("strong", { text: title });
            card.createSpan({ text });
        }
        this.contentEl.createDiv({ cls: "dpe-privacy", text: "Your files stay on your computer." });
        const footer = this.contentEl.createDiv({ cls: "dpe-footer" });
        footer.createDiv({ cls: "dpe-footer-status", text: "Desktop: macOS · Windows · Linux" });
        const later = footer.createEl("button", { text: "Done for now" });
        later.addEventListener("click", async () => {
            this.plugin.settings.onboardingComplete = true;
            await this.plugin.saveSettings();
            this.close();
        });
        const start = footer.createEl("button", { cls: "mod-cta", text: "Build a PDF" });
        start.addEventListener("click", async () => {
            this.plugin.settings.onboardingComplete = true;
            await this.plugin.saveSettings();
            this.close();
            this.plugin.openBuilder();
        });
    }

    onClose() {
        if (!this.plugin.settings.onboardingComplete) {
            this.plugin.settings.onboardingComplete = true;
            this.plugin.saveSettings().catch((error) => console.warn(`[${PLUGIN_NAME}] Could not save onboarding state.`, error));
        }
        this.contentEl.empty();
    }
}

class ManifestBuilderModal extends obsidian.Modal {
    constructor(plugin, state) {
        super(plugin.app);
        this.plugin = plugin;
        this.state = cloneData(state);
        this.exporting = false;
        this.noteOutlineCache = new Map();
    }

    onOpen() {
        this.modalEl.addClass("dpe-modal");
        this.titleEl.empty();
        this.render();
    }

    async persist() {
        this.plugin.settings.lastManifest = cloneData(this.state);
        await this.plugin.saveSettings();
    }

    render() {
        this.contentEl.empty();
        const shell = this.contentEl.createDiv({ cls: "dpe-shell" });
        const header = shell.createDiv({ cls: "dpe-header" });
        const headMain = header.createDiv();
        headMain.createDiv({ cls: "dpe-kicker", text: "Local document builder" });
        headMain.createEl("h2", { cls: "dpe-title", text: "Document PDF Exporter" });
        headMain.createEl("p", { cls: "dpe-subtitle", text: "Build one ordered PDF from notes, PDFs, and images. Everything stays local." });
        header.createDiv({ cls: "dpe-badge", text: `v${PLUGIN_VERSION}` });

        const body = shell.createDiv({ cls: "dpe-body" });
        const steps = body.createDiv({ cls: "dpe-stepbar" });
        [["1", "Add sources"], ["2", "Arrange and edit"], ["3", "Export PDF"]].forEach(([number, text]) => {
            const step = steps.createDiv({ cls: "dpe-step" });
            step.createEl("strong", { text: number });
            step.appendText(text);
        });

        const toolbar = body.createDiv({ cls: "dpe-toolbar" });
        const addActive = toolbar.createEl("button", { text: "Add active note" });
        addActive.addEventListener("click", async () => {
            const file = this.plugin.app.workspace.getActiveFile();
            if (!file || file.extension !== "md") {
                new obsidian.Notice("Open a Markdown note first.");
                return;
            }
            this.addSources([core.normalizeSource({ location: "vault", path: file.path })]);
        });
        const addVault = toolbar.createEl("button", { text: "Add from Vault" });
        addVault.addEventListener("click", () => new VaultSourcePickerModal(this.plugin, (sources) => this.addSources(sources)).open());
        const addExternal = toolbar.createEl("button", { text: "Add computer files" });
        addExternal.addEventListener("click", async () => {
            try { this.addSources(await this.plugin.chooseExternalSources()); }
            catch (error) { this.showError(error); }
        });
        toolbar.createDiv({ cls: "dpe-toolbar-spacer" });
        const clear = toolbar.createEl("button", { text: "Clear" });
        clear.addEventListener("click", () => {
            this.state.sources = [];
            this.render();
            this.persist();
        });

        this.sourceList = body.createDiv({ cls: "dpe-source-list" });
        this.renderSources();
        this.renderOptions(body);

        const footer = shell.createDiv({ cls: "dpe-footer" });
        this.statusEl = footer.createDiv({ cls: "dpe-footer-status", text: this.sourceSummary() });
        this.progressEl = footer.createEl("progress", { cls: "dpe-progress", attr: { max: "100", value: "0" } });
        const close = footer.createEl("button", { text: "Close" });
        close.addEventListener("click", () => this.close());
        this.exportButton = footer.createEl("button", { cls: "mod-cta", text: "Export PDF" });
        this.exportButton.disabled = this.state.sources.filter((source) => source.enabled).length === 0;
        this.exportButton.addEventListener("click", () => this.runExport());
    }

    sourceSummary() {
        const enabled = this.state.sources.filter((source) => source.enabled).length;
        return `${enabled} item${enabled === 1 ? "" : "s"} ready · ${this.state.pageSize}`;
    }

    addSources(sources) {
        if (!sources?.length) return;
        const existing = new Set(this.state.sources.map((source) => `${source.location}:${source.path}`));
        for (const source of sources.map(core.normalizeSource)) {
            const key = `${source.location}:${source.path}`;
            if (!existing.has(key)) {
                this.state.sources.push(source);
                existing.add(key);
            }
        }
        this.render();
        this.persist();
    }

    renderSources() {
        this.sourceList.empty();
        if (!this.state.sources.length) {
            const empty = this.sourceList.createDiv({ cls: "dpe-empty" });
            const icon = empty.createDiv({ cls: "dpe-empty-icon" });
            obsidian.setIcon(icon, "files");
            empty.createEl("h3", { text: "No files yet" });
            empty.createEl("p", { text: "Add notes, PDFs, or images. Their order here is their order in the final PDF." });
            const button = empty.createEl("button", { cls: "mod-cta", text: "Add from Vault" });
            button.addEventListener("click", () => new VaultSourcePickerModal(this.plugin, (sources) => this.addSources(sources)).open());
            return;
        }

        this.state.sources.forEach((source, index) => {
            const item = this.sourceList.createDiv({ cls: `dpe-source-item${source.enabled ? "" : " is-disabled"}` });
            const card = item.createDiv({ cls: "dpe-source-card" });
            card.draggable = true;
            card.dataset.index = String(index);
            const drag = card.createDiv({ cls: "dpe-drag" });
            obsidian.setIcon(drag, "grip-vertical");
            const icon = card.createDiv({ cls: "dpe-kind-icon" });
            obsidian.setIcon(icon, iconForKind(source.kind));
            const main = card.createDiv({ cls: "dpe-source-main" });
            main.createDiv({ cls: "dpe-source-name", text: source.title });
            const detailBits = [sourceKindLabel(source.kind)];
            if (source.kind === "note" && source.excludedSections.length) detailBits.push(`${source.excludedSections.length} hidden`);
            if (source.kind === "pdf" && source.pageRange !== "all") detailBits.push(`pages ${source.pageRange}`);
            main.createDiv({ cls: "dpe-source-detail", text: detailBits.join(" · ") });
            const actions = card.createDiv({ cls: "dpe-source-actions" });
            const toggle = actions.createEl("button", { cls: "dpe-icon-button", attr: { "aria-label": source.enabled ? "Hide file" : "Include file" } });
            obsidian.setIcon(toggle, source.enabled ? "eye" : "eye-off");
            toggle.addEventListener("click", () => { source.enabled = !source.enabled; this.render(); this.persist(); });
            const up = actions.createEl("button", { cls: "dpe-icon-button", attr: { "aria-label": "Move file up" } });
            obsidian.setIcon(up, "arrow-up");
            up.disabled = index === 0;
            up.addEventListener("click", () => this.moveSource(index, index - 1));
            const down = actions.createEl("button", { cls: "dpe-icon-button", attr: { "aria-label": "Move file down" } });
            obsidian.setIcon(down, "arrow-down");
            down.disabled = index === this.state.sources.length - 1;
            down.addEventListener("click", () => this.moveSource(index, index + 1));
            const options = actions.createEl("button", { cls: "dpe-icon-button", attr: { "aria-label": "File options" } });
            obsidian.setIcon(options, "settings-2");
            options.addEventListener("click", () => new SourceOptionsModal(this.plugin, source, (updated) => {
                this.state.sources[index] = core.normalizeSource(updated);
                this.noteOutlineCache.delete(`${source.location}:${source.path}`);
                this.render();
                this.persist();
            }).open());
            const remove = actions.createEl("button", { cls: "dpe-icon-button", attr: { "aria-label": "Remove file" } });
            obsidian.setIcon(remove, "trash-2");
            remove.addEventListener("click", () => { this.state.sources.splice(index, 1); this.render(); this.persist(); });

            card.addEventListener("dragstart", (event) => {
                card.addClass("is-dragging");
                event.dataTransfer?.setData("text/plain", String(index));
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            });
            card.addEventListener("dragend", () => card.removeClass("is-dragging"));
            card.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; });
            card.addEventListener("drop", (event) => {
                event.preventDefault();
                const from = Number(event.dataTransfer?.getData("text/plain"));
                if (Number.isInteger(from)) this.moveSource(from, index);
            });

            if (source.kind === "note") {
                const tree = item.createDiv({ cls: "dpe-inline-tree" });
                this.renderNoteOutline(source, tree);
            } else if (source.kind === "pdf") {
                this.renderPdfOrder(source, item.createDiv({ cls: "dpe-inline-controls" }));
            }
        });
    }

    async renderNoteOutline(source, tree) {
        const key = `${source.location}:${source.path}`;
        tree.createDiv({ cls: "dpe-tree-loading", text: "Loading headings…" });
        try {
            let headings = this.noteOutlineCache.get(key);
            if (!headings) {
                const raw = await this.plugin.readSourceText(source);
                headings = core.scanHeadings(core.stripFrontmatter(raw).body);
                this.noteOutlineCache.set(key, headings);
            }
            if (!tree.isConnected) return;
            tree.empty();
            if (!headings.length) {
                tree.createDiv({ cls: "dpe-tree-empty", text: "No headings in this note" });
                return;
            }
            const available = new Set(headings.map((heading) => heading.id));
            source.excludedSections = source.excludedSections.filter((id) => available.has(id));
            const baseOrder = source.sectionOrder.filter((id) => available.has(id));
            for (const heading of headings) if (!baseOrder.includes(heading.id)) baseOrder.push(heading.id);
            source.sectionOrder = baseOrder;
            const ordered = core.orderedHeadings(headings, source.sectionOrder);
            const excluded = new Set(source.excludedSections);
            const subtreeIds = (heading) => headings.filter((candidate) => candidate.start >= heading.start && candidate.start < heading.end).map((candidate) => candidate.id);
            const preamble = tree.createDiv({ cls: "dpe-tree-preamble" });
            const preambleToggle = preamble.createEl("input", { type: "checkbox" });
            preambleToggle.checked = source.includePreamble;
            preamble.createSpan({ text: "Text before first heading" });
            preambleToggle.addEventListener("change", () => { source.includePreamble = preambleToggle.checked; this.persist(); });
            for (const heading of ordered) {
                const row = tree.createDiv({ cls: `dpe-heading-row dpe-heading-level-${heading.level}` });
                row.draggable = true;
                row.dataset.headingId = heading.id;
                const grip = row.createDiv({ cls: "dpe-heading-grip" });
                obsidian.setIcon(grip, "grip-vertical");
                const checkbox = row.createEl("input", { type: "checkbox" });
                checkbox.checked = !excluded.has(heading.id);
                const title = row.createDiv({ cls: "dpe-heading-title", text: heading.title });
                const controls = row.createDiv({ cls: "dpe-heading-actions" });
                const siblings = ordered.filter((candidate) => candidate.parentId === heading.parentId);
                const siblingIndex = siblings.findIndex((candidate) => candidate.id === heading.id);
                const move = (delta) => {
                    const other = siblings[siblingIndex + delta];
                    if (!other) return;
                    const a = source.sectionOrder.indexOf(heading.id);
                    const b = source.sectionOrder.indexOf(other.id);
                    [source.sectionOrder[a], source.sectionOrder[b]] = [source.sectionOrder[b], source.sectionOrder[a]];
                    this.render(); this.persist();
                };
                const up = controls.createEl("button", { cls: "dpe-mini-button", attr: { "aria-label": "Move heading up" } });
                obsidian.setIcon(up, "chevron-up"); up.disabled = siblingIndex <= 0; up.addEventListener("click", () => move(-1));
                const down = controls.createEl("button", { cls: "dpe-mini-button", attr: { "aria-label": "Move heading down" } });
                obsidian.setIcon(down, "chevron-down"); down.disabled = siblingIndex >= siblings.length - 1; down.addEventListener("click", () => move(1));
                checkbox.addEventListener("change", () => {
                    const ids = subtreeIds(heading);
                    const set = new Set(source.excludedSections);
                    for (const id of ids) checkbox.checked ? set.delete(id) : set.add(id);
                    source.excludedSections = [...set];
                    this.render(); this.persist();
                });
                row.addEventListener("dragstart", (event) => { event.dataTransfer?.setData("application/x-dpe-heading", heading.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; });
                row.addEventListener("dragover", (event) => event.preventDefault());
                row.addEventListener("drop", (event) => {
                    event.preventDefault();
                    const draggedId = event.dataTransfer?.getData("application/x-dpe-heading");
                    if (!draggedId || draggedId === heading.id) return;
                    const dragged = headings.find((candidate) => candidate.id === draggedId);
                    if (!dragged || dragged.parentId !== heading.parentId) return;
                    const order = source.sectionOrder.filter((id) => id !== draggedId);
                    const target = order.indexOf(heading.id);
                    order.splice(Math.max(0, target), 0, draggedId);
                    source.sectionOrder = order;
                    this.render(); this.persist();
                });
            }
        } catch (error) {
            if (tree.isConnected) { tree.empty(); tree.createDiv({ cls: "dpe-tree-empty", text: processError(error) }); }
        }
    }

    renderPdfOrder(source, controls) {
        const label = controls.createEl("label", { cls: "dpe-page-order" });
        label.createSpan({ text: "Pages and order" });
        const input = label.createEl("input", { type: "text", value: source.pageRange || "all", placeholder: "all or 3,1,2,5-7" });
        input.addEventListener("change", () => { source.pageRange = input.value.trim() || "all"; this.persist(); this.render(); });
        const reset = controls.createEl("button", { cls: "dpe-small-button", text: "All pages" });
        reset.addEventListener("click", () => { source.pageRange = "all"; this.render(); this.persist(); });
        controls.createDiv({ cls: "dpe-inline-hint", text: "Use 3,1,2 to change page order. Use 5-3 to reverse pages." });
    }

    moveSource(from, to) {
        this.state.sources = core.moveItem(this.state.sources, from, to);
        this.render();
        this.persist();
    }

    renderOptions(parent) {
        const options = parent.createDiv({ cls: "dpe-options" });
        options.createEl("h3", { text: "Document" });
        const grid = options.createDiv({ cls: "dpe-grid" });
        new obsidian.Setting(grid).setName("Title").addText((text) => text.setValue(this.state.title).onChange((value) => { this.state.title = value; this.persist(); }));
        new obsidian.Setting(grid).setName("Subtitle").addText((text) => text.setValue(this.state.subtitle || "").onChange((value) => { this.state.subtitle = value; this.persist(); }));
        new obsidian.Setting(grid).setName("Page size").addDropdown((dropdown) => dropdown.addOptions({ Letter: "Letter", A4: "A4", Legal: "Legal" }).setValue(this.state.pageSize).onChange((value) => { this.state.pageSize = value; this.persist(); }));
        new obsidian.Setting(grid).setName("Margins").addDropdown((dropdown) => dropdown.addOptions({ normal: "Normal", narrow: "Narrow", wide: "Wide" }).setValue(this.state.margin).onChange((value) => { this.state.margin = value; this.persist(); }));
        new obsidian.Setting(grid).setName("Imported PDF quality").addDropdown((dropdown) => dropdown.addOptions({ compact: "Compact", balanced: "Balanced", high: "High" }).setValue(this.state.quality).onChange((value) => { this.state.quality = value; this.persist(); }));
        new obsidian.Setting(grid).setName("Cover page").addToggle((toggle) => toggle.setValue(this.state.cover).onChange((value) => { this.state.cover = value; this.persist(); }));
        new obsidian.Setting(grid).setName("Contents page").addToggle((toggle) => toggle.setValue(this.state.toc).onChange((value) => { this.state.toc = value; this.persist(); }));
        new obsidian.Setting(grid).setName("Page numbers").addToggle((toggle) => toggle.setValue(this.state.pageNumbers).onChange((value) => { this.state.pageNumbers = value; this.persist(); }));
        new obsidian.Setting(grid).setName("Open after export").addToggle((toggle) => toggle.setValue(this.state.openAfterExport).onChange((value) => { this.state.openAfterExport = value; this.persist(); }));
    }

    updateProgress(message, percent) {
        if (!this.statusEl) return;
        this.statusEl.setText(message);
        this.progressEl?.addClass("is-active");
        if (Number.isFinite(percent)) this.progressEl.value = Math.max(0, Math.min(100, percent));
    }

    async runExport() {
        if (this.exporting) return;
        this.state.title = this.state.title.trim() || "Manifest";
        this.exporting = true;
        this.exportButton.disabled = true;
        try {
            await this.persist();
            const result = await this.plugin.exportManifest(this.state, (message, percent) => this.updateProgress(message, percent));
            this.statusEl.setText(`Saved ${path.basename(result.outputPath)} · ${core.formatBytes(result.bytes)}`);
            new obsidian.Notice(`PDF ready: ${path.basename(result.outputPath)}`, 7000);
        } catch (error) {
            if (error?.name === "ManifestCancelError") {
                this.statusEl.setText("Export cancelled.");
            } else {
                this.showError(error);
            }
        } finally {
            this.exporting = false;
            this.exportButton.disabled = this.state.sources.filter((source) => source.enabled).length === 0;
            this.progressEl?.removeClass("is-active");
        }
    }

    showError(error) {
        const message = processError(error);
        console.error(`[${PLUGIN_NAME} ${PLUGIN_VERSION}]`, error);
        if (this.statusEl) this.statusEl.setText(message);
        new ErrorModal(this.plugin, message).open();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class VaultSourcePickerModal extends obsidian.Modal {
    constructor(plugin, onAdd) {
        super(plugin.app);
        this.plugin = plugin;
        this.onAdd = onAdd;
        this.selected = new Set();
        this.query = "";
    }

    onOpen() {
        this.modalEl.addClass("dpe-picker-modal");
        this.titleEl.setText("Add files from the Vault");
        const shell = this.contentEl.createDiv({ cls: "dpe-picker-shell" });
        const search = shell.createEl("input", { type: "search", placeholder: "Search notes, PDFs, and images" });
        search.addEventListener("input", () => { this.query = search.value; this.renderList(); });
        const toolbar = shell.createDiv({ cls: "dpe-toolbar" });
        this.resultCount = toolbar.createDiv({ cls: "dpe-footer-status" });
        const selectAll = toolbar.createEl("button", { text: "Select shown" });
        selectAll.addEventListener("click", () => {
            this.filteredFiles().forEach((file) => this.selected.add(file.path));
            this.renderList();
        });
        const clear = toolbar.createEl("button", { text: "Clear" });
        clear.addEventListener("click", () => { this.selected.clear(); this.renderList(); });
        this.list = shell.createDiv({ cls: "dpe-picker-list" });
        const footer = shell.createDiv({ cls: "dpe-footer" });
        footer.createDiv({ cls: "dpe-footer-status", text: "Select more than one file to add them together." });
        const cancel = footer.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());
        this.addButton = footer.createEl("button", { cls: "mod-cta", text: "Add selected" });
        this.addButton.addEventListener("click", () => {
            const sources = [...this.selected].map((filePath) => core.normalizeSource({ location: "vault", path: filePath }));
            this.onAdd(sources);
            this.close();
        });
        search.focus();
        this.renderList();
    }

    filteredFiles() {
        const query = this.query.trim().toLowerCase();
        return this.plugin.app.vault.getFiles()
            .filter((file) => SUPPORTED_EXTENSIONS.has(file.extension.toLowerCase()))
            .filter((file) => !query || `${file.basename} ${file.path}`.toLowerCase().includes(query))
            .sort((a, b) => a.path.localeCompare(b.path))
            .slice(0, 500);
    }

    renderList() {
        this.list.empty();
        const files = this.filteredFiles();
        this.resultCount.setText(`${files.length}${files.length === 500 ? "+" : ""} shown · ${this.selected.size} selected`);
        this.addButton.disabled = this.selected.size === 0;
        for (const file of files) {
            const row = this.list.createDiv({ cls: "dpe-picker-row" });
            const checkbox = row.createEl("input", { type: "checkbox" });
            checkbox.checked = this.selected.has(file.path);
            const icon = row.createDiv({ cls: "dpe-kind-icon" });
            obsidian.setIcon(icon, iconForKind(core.kindFromPath(file.path)));
            const main = row.createDiv();
            main.createDiv({ cls: "dpe-picker-title", text: file.basename });
            main.createDiv({ cls: "dpe-picker-path", text: file.path });
            const update = (checked) => {
                if (checked) this.selected.add(file.path);
                else this.selected.delete(file.path);
                checkbox.checked = checked;
                this.resultCount.setText(`${files.length}${files.length === 500 ? "+" : ""} shown · ${this.selected.size} selected`);
                this.addButton.disabled = this.selected.size === 0;
            };
            row.addEventListener("click", (event) => { if (event.target !== checkbox) update(!checkbox.checked); });
            checkbox.addEventListener("change", () => update(checkbox.checked));
        }
    }

    onClose() { this.contentEl.empty(); }
}

class SourceOptionsModal extends obsidian.Modal {
    constructor(plugin, source, onSave) {
        super(plugin.app);
        this.plugin = plugin;
        this.source = cloneData(core.normalizeSource(source));
        this.onSave = onSave;
    }

    onOpen() {
        this.titleEl.setText(`${sourceKindLabel(this.source.kind)} options`);
        new obsidian.Setting(this.contentEl).setName("Display title").addText((text) => text.setValue(this.source.title).onChange((value) => { this.source.title = value; }));
        new obsidian.Setting(this.contentEl).setName("Export this source").addToggle((toggle) => toggle.setValue(this.source.enabled).onChange((value) => { this.source.enabled = value; }));
        new obsidian.Setting(this.contentEl).setName("Start on a new page").addToggle((toggle) => toggle.setValue(this.source.startOnNewPage).onChange((value) => { this.source.startOnNewPage = value; }));
        if (this.source.kind !== "pdf") {
            new obsidian.Setting(this.contentEl).setName("Source heading").addToggle((toggle) => toggle.setValue(this.source.showSourceHeader).onChange((value) => { this.source.showSourceHeader = value; }));
        }
        if (this.source.kind === "note") {
            new obsidian.Setting(this.contentEl).setName("Include properties").setDesc("Show note properties at the start of this note.").addToggle((toggle) => toggle.setValue(this.source.includeFrontmatter).onChange((value) => { this.source.includeFrontmatter = value; }));
        } else if (this.source.kind === "pdf") {
            new obsidian.Setting(this.contentEl).setName("Pages and order").setDesc("Use all, 1-4, 3,1,2, or 5-3.").addText((text) => text.setValue(this.source.pageRange || "all").onChange((value) => { this.source.pageRange = value; }));
        } else if (this.source.kind === "image") {
            new obsidian.Setting(this.contentEl).setName("Image fit").addDropdown((dropdown) => dropdown.addOptions({ contain: "Contain", cover: "Cover", actual: "Actual size" }).setValue(this.source.imageFit).onChange((value) => { this.source.imageFit = value; }));
            new obsidian.Setting(this.contentEl).setName("Show caption").addToggle((toggle) => toggle.setValue(this.source.showImageCaption).onChange((value) => { this.source.showImageCaption = value; }));
            new obsidian.Setting(this.contentEl).setName("Caption text").addTextArea((text) => text.setValue(this.source.caption).onChange((value) => { this.source.caption = value; }));
        }
        const footer = this.contentEl.createDiv({ cls: "dpe-footer" });
        footer.createDiv({ cls: "dpe-footer-status", text: sourceKindLabel(this.source.kind) });
        const cancel = footer.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());
        const save = footer.createEl("button", { cls: "mod-cta", text: "Save" });
        save.addEventListener("click", () => {
            this.source.title = this.source.title.trim() || core.titleFromPath(this.source.path);
            this.onSave(this.source);
            this.close();
        });
    }

    onClose() { this.contentEl.empty(); }
}

class ErrorModal extends obsidian.Modal {
    constructor(plugin, message) {
        super(plugin.app);
        this.plugin = plugin;
        this.message = message;
    }

    onOpen() {
        this.titleEl.setText("PDF export failed");
        this.contentEl.createEl("p", { text: "The final PDF was not replaced by a partial file." });
        this.contentEl.createDiv({ cls: "dpe-error-box", text: this.message });
        const footer = this.contentEl.createDiv({ cls: "dpe-footer" });
        footer.createDiv({ cls: "dpe-footer-status", text: "Copy this message when reporting the problem." });
        const copy = footer.createEl("button", { text: "Copy error" });
        copy.addEventListener("click", async () => {
            await obsidian.activeWindow.navigator.clipboard.writeText(this.message);
            new obsidian.Notice("Error copied.");
        });
        const close = footer.createEl("button", { cls: "mod-cta", text: "Close" });
        close.addEventListener("click", () => this.close());
    }

    onClose() { this.contentEl.empty(); }
}

class ManifestExporterSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        new obsidian.Setting(containerEl).setName("Document PDF Exporter").setHeading();
        containerEl.createEl("p", { text: "These values are used for new exports. You can change them in the builder." });
        new obsidian.Setting(containerEl).setName("Brand label").setDesc("Small uppercase label on the cover.").addText((text) => text.setValue(this.plugin.settings.brand).onChange(async (value) => { this.plugin.settings.brand = value; await this.plugin.saveSettings(); }));
        new obsidian.Setting(containerEl).setName("Default subtitle").addText((text) => text.setValue(this.plugin.settings.defaultSubtitle).onChange(async (value) => { this.plugin.settings.defaultSubtitle = value; await this.plugin.saveSettings(); }));
        new obsidian.Setting(containerEl).setName("Default page size").addDropdown((dropdown) => dropdown.addOptions({ Letter: "Letter", A4: "A4", Legal: "Legal" }).setValue(this.plugin.settings.defaultPageSize).onChange(async (value) => { this.plugin.settings.defaultPageSize = value; await this.plugin.saveSettings(); }));
        new obsidian.Setting(containerEl).setName("Default PDF quality").addDropdown((dropdown) => dropdown.addOptions({ compact: "Compact", balanced: "Balanced", high: "High" }).setValue(this.plugin.settings.defaultQuality).onChange(async (value) => { this.plugin.settings.defaultQuality = value; await this.plugin.saveSettings(); }));
        new obsidian.Setting(containerEl).setName("Default save folder").setDesc("Optional folder to show first when you save.").addText((text) => text.setValue(this.plugin.settings.outputFolder).onChange(async (value) => { this.plugin.settings.outputFolder = value; await this.plugin.saveSettings(); }));
        new obsidian.Setting(containerEl).setName("Nested note limit").setDesc("Stops very deep note embeds from looping.").addSlider((slider) => slider.setLimits(1, 20, 1).setValue(this.plugin.settings.maxTransclusionDepth).setDynamicTooltip().onChange(async (value) => { this.plugin.settings.maxTransclusionDepth = value; await this.plugin.saveSettings(); }));
        new obsidian.Setting(containerEl).setName("Show onboarding again").addButton((button) => button.setButtonText("Open welcome screen").onClick(() => new WelcomeModal(this.plugin).open()));
        new obsidian.Setting(containerEl).setName("Reset saved export").setDesc("Clears the file list and document options saved from the last builder session.").addButton((button) => button.setWarning().setButtonText("Reset").onClick(async () => {
            this.plugin.settings.lastManifest = null;
            await this.plugin.saveSettings();
            new obsidian.Notice("Saved export reset.");
        }));
    }
}

module.exports = ManifestExporterPlugin;
