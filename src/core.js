const CORE_VERSION = "1.0.0";

const IMAGE_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif",
]);
const PDF_EXTENSION = "pdf";
const NOTE_EXTENSION = "md";
const MIME_TYPES = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    avif: "image/avif",
};
const PAGE_SIZES = {
    Letter: { widthIn: 8.5, heightIn: 11 },
    A4: { widthIn: 8.2677165, heightIn: 11.692913 },
    Legal: { widthIn: 8.5, heightIn: 14 },
};

function normalizeNewlines(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n");
}

function stripFrontmatter(text) {
    const normalized = normalizeNewlines(text);
    const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    if (!match) return { body: normalized, raw: "", start: 0, end: 0 };
    return {
        body: normalized.slice(match[0].length),
        raw: match[1],
        start: 0,
        end: match[0].length,
    };
}

function slugify(value) {
    return String(value ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 96) || "section";
}

function scanHeadings(text) {
    const normalized = normalizeNewlines(text);
    const lines = normalized.split("\n");
    const headings = [];
    const hierarchy = [];
    const duplicateCounts = new Map();
    let offset = 0;
    let fenceChar = null;
    let fenceLength = 0;

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        const line = lines[lineNumber];
        const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (fence) {
            const token = fence[1];
            if (!fenceChar) {
                fenceChar = token[0];
                fenceLength = token.length;
            } else if (token[0] === fenceChar && token.length >= fenceLength) {
                fenceChar = null;
                fenceLength = 0;
            }
        } else if (!fenceChar) {
            const heading = line.match(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
            if (heading) {
                const level = heading[1].length;
                const title = heading[2].trim();
                hierarchy.length = level - 1;
                hierarchy[level - 1] = title;
                const hierarchyText = hierarchy.filter(Boolean).join(" / ");
                const duplicateKey = hierarchyText.toLocaleLowerCase();
                const occurrence = (duplicateCounts.get(duplicateKey) || 0) + 1;
                duplicateCounts.set(duplicateKey, occurrence);
                let parentId = null;
                for (let index = headings.length - 1; index >= 0; index -= 1) {
                    if (headings[index].level < level) {
                        parentId = headings[index].id;
                        break;
                    }
                }
                headings.push({
                    id: `${slugify(hierarchyText)}::${occurrence}`,
                    level,
                    title,
                    hierarchy: hierarchyText,
                    occurrence,
                    parentId,
                    start: offset,
                    end: normalized.length,
                    lineNumber: lineNumber + 1,
                });
            }
        }
        offset += line.length + (lineNumber < lines.length - 1 ? 1 : 0);
    }

    for (let index = 0; index < headings.length; index += 1) {
        for (let next = index + 1; next < headings.length; next += 1) {
            if (headings[next].level <= headings[index].level) {
                headings[index].end = headings[next].start;
                break;
            }
        }
    }
    return headings;
}


function orderedHeadings(headings, orderIds = []) {
    const rank = new Map((orderIds || []).map((id, index) => [id, index]));
    const children = new Map();
    const byId = new Map(headings.map((heading) => [heading.id, heading]));
    for (const heading of headings) {
        const key = heading.parentId && byId.has(heading.parentId) ? heading.parentId : null;
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(heading);
    }
    const sortGroup = (items) => [...items].sort((a, b) => {
        const ar = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
        const br = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
        return ar - br || a.start - b.start;
    });
    const output = [];
    const walk = (parentId) => {
        for (const heading of sortGroup(children.get(parentId) || [])) {
            output.push(heading);
            walk(heading.id);
        }
    };
    walk(null);
    return output;
}

function reorderSections(text, orderIds = []) {
    const normalized = normalizeNewlines(text);
    const headings = scanHeadings(normalized);
    if (!headings.length || !Array.isArray(orderIds) || !orderIds.length) return normalized;
    const rank = new Map(orderIds.map((id, index) => [id, index]));
    const byId = new Map(headings.map((heading) => [heading.id, heading]));
    const children = new Map();
    for (const heading of headings) {
        const key = heading.parentId && byId.has(heading.parentId) ? heading.parentId : null;
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(heading);
    }
    const sortGroup = (items) => [...items].sort((a, b) => {
        const ar = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
        const br = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
        return ar - br || a.start - b.start;
    });
    const renderNode = (heading) => {
        const directChildren = children.get(heading.id) || [];
        const ownEnd = directChildren.length ? Math.min(...directChildren.map((child) => child.start)) : heading.end;
        return normalized.slice(heading.start, ownEnd) + sortGroup(directChildren).map(renderNode).join("");
    };
    const roots = children.get(null) || [];
    const preambleEnd = roots.length ? Math.min(...roots.map((heading) => heading.start)) : normalized.length;
    return normalized.slice(0, preambleEnd) + sortGroup(roots).map(renderNode).join("");
}

function mergeRanges(ranges) {
    const sorted = ranges
        .filter((range) => range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
        .map((range) => ({ start: range.start, end: range.end }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const range of sorted) {
        const previous = merged[merged.length - 1];
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push(range);
    }
    return merged;
}

function removeRanges(text, ranges) {
    const normalized = normalizeNewlines(text);
    const merged = mergeRanges(ranges);
    if (!merged.length) return normalized;
    let cursor = 0;
    const output = [];
    for (const range of merged) {
        output.push(normalized.slice(cursor, range.start));
        cursor = Math.max(cursor, range.end);
    }
    output.push(normalized.slice(cursor));
    return output.join("").replace(/\n{4,}/g, "\n\n\n").trim();
}

function filterSections(text, excludedIds = [], includePreamble = true) {
    const normalized = normalizeNewlines(text);
    const headings = scanHeadings(normalized);
    const excluded = new Set(excludedIds || []);
    const ranges = headings
        .filter((heading) => excluded.has(heading.id))
        .map((heading) => ({ start: heading.start, end: heading.end }));
    if (!includePreamble && headings.length && headings[0].start > 0) {
        ranges.push({ start: 0, end: headings[0].start });
    }
    return {
        markdown: removeRanges(normalized, ranges),
        headings,
        removedRanges: mergeRanges(ranges),
    };
}

function sliceAnchor(text, rawAnchor) {
    const normalized = normalizeNewlines(text);
    const anchor = String(rawAnchor || "").replace(/^#/, "").trim();
    if (!anchor) return normalized;

    if (anchor.startsWith("^")) {
        const blockId = anchor.slice(1).trim();
        if (!blockId) return normalized;
        const escaped = blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const lines = normalized.split("\n");
        const index = lines.findIndex((line) => new RegExp(`(?:^|\\s)\\^${escaped}\\s*$`).test(line));
        if (index < 0) return normalized;
        let start = index;
        let end = index + 1;
        while (start > 0 && lines[start - 1].trim() !== "" && !/^#{1,6}\s+/.test(lines[start - 1])) start -= 1;
        while (end < lines.length && lines[end].trim() !== "" && !/^#{1,6}\s+/.test(lines[end])) end += 1;
        return lines.slice(start, end)
            .join("\n")
            .replace(new RegExp(`\\s*\\^${escaped}\\s*$`, "m"), "")
            .trim();
    }

    const target = anchor.replace(/#/g, " ").trim().toLocaleLowerCase();
    const headings = scanHeadings(normalized);
    const exact = headings.find((heading) => heading.title.toLocaleLowerCase() === target);
    const partial = headings.find((heading) => heading.title.toLocaleLowerCase().includes(target));
    const match = exact || partial;
    return match ? normalized.slice(match.start, match.end).trim() : normalized;
}

function splitFencedSegments(text) {
    const normalized = normalizeNewlines(text);
    const lines = normalized.split("\n");
    const result = [];
    let current = [];
    let currentIsFence = false;
    let fenceChar = null;
    let fenceLength = 0;

    const flush = () => {
        if (!current.length) return;
        result.push({ fenced: currentIsFence, text: current.join("\n") });
        current = [];
    };

    for (const line of lines) {
        const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (!fenceChar && match) {
            flush();
            currentIsFence = true;
            fenceChar = match[1][0];
            fenceLength = match[1].length;
            current.push(line);
            continue;
        }
        if (fenceChar) {
            current.push(line);
            if (match && match[1][0] === fenceChar && match[1].length >= fenceLength) {
                flush();
                currentIsFence = false;
                fenceChar = null;
                fenceLength = 0;
            }
            continue;
        }
        current.push(line);
    }
    flush();
    return result;
}

function splitInlineCodeSegments(text) {
    const value = String(text || "");
    const result = [];
    let cursor = 0;
    let index = 0;
    while (index < value.length) {
        if (value[index] !== "`") {
            index += 1;
            continue;
        }
        let runEnd = index + 1;
        while (runEnd < value.length && value[runEnd] === "`") runEnd += 1;
        const token = value.slice(index, runEnd);
        const close = value.indexOf(token, runEnd);
        if (close < 0) {
            index = runEnd;
            continue;
        }
        if (index > cursor) result.push({ code: false, text: value.slice(cursor, index) });
        result.push({ code: true, text: value.slice(index, close + token.length) });
        cursor = close + token.length;
        index = cursor;
    }
    if (cursor < value.length) result.push({ code: false, text: value.slice(cursor) });
    return result.length ? result : [{ code: false, text: value }];
}

async function replaceAsync(text, regex, replacer) {
    const matches = [...String(text).matchAll(regex)];
    if (!matches.length) return String(text);
    const replacements = await Promise.all(matches.map((match) => replacer(...match)));
    let cursor = 0;
    const output = [];
    matches.forEach((match, index) => {
        output.push(String(text).slice(cursor, match.index));
        output.push(replacements[index]);
        cursor = match.index + match[0].length;
    });
    output.push(String(text).slice(cursor));
    return output.join("");
}

function parseWikiEmbed(inside) {
    const value = String(inside || "");
    const pipeIndex = value.indexOf("|");
    const rawTarget = (pipeIndex >= 0 ? value.slice(0, pipeIndex) : value).trim();
    const alias = (pipeIndex >= 0 ? value.slice(pipeIndex + 1) : "").trim();
    const hashIndex = rawTarget.indexOf("#");
    return {
        rawTarget,
        linkpath: (hashIndex >= 0 ? rawTarget.slice(0, hashIndex) : rawTarget).trim(),
        anchor: hashIndex >= 0 ? rawTarget.slice(hashIndex + 1).trim() : "",
        alias,
    };
}

function parsePdfPageRangeFromAnchor(anchor) {
    const value = String(anchor || "").trim();
    const pages = value.match(/(?:^|&)pages?=([0-9,\-\s]+)/i);
    return pages ? pages[1].replace(/\s+/g, "") : "";
}

function parsePageRange(value, totalPages = null) {
    const text = String(value || "").trim().toLowerCase();
    if (!text || text === "all" || text === "*") {
        if (!Number.isFinite(totalPages)) return null;
        return Array.from({ length: totalPages }, (_, index) => index + 1);
    }
    const pages = [];
    const seen = new Set();
    const addPage = (page) => {
        if (!seen.has(page)) {
            pages.push(page);
            seen.add(page);
        }
    };
    for (const rawPart of text.split(",")) {
        const part = rawPart.trim();
        if (!part) continue;
        if (/^\d+$/.test(part)) {
            addPage(Number(part));
            continue;
        }
        const match = part.match(/^(\d*)-(\d*)$/);
        if (!match) throw new Error(`Invalid page order: ${rawPart}`);
        const start = match[1] ? Number(match[1]) : 1;
        const end = match[2] ? Number(match[2]) : totalPages;
        if (!Number.isFinite(end)) throw new Error(`Open page order needs a known page count: ${rawPart}`);
        if (start < 1 || end < 1) throw new Error(`Invalid page order: ${rawPart}`);
        const step = start <= end ? 1 : -1;
        for (let page = start; ; page += step) {
            addPage(page);
            if (page === end) break;
        }
    }
    if (!pages.length) throw new Error("The page order is empty.");
    if (Number.isFinite(totalPages) && pages.some((page) => page > totalPages)) {
        throw new Error(`Page order exceeds the ${totalPages}-page source.`);
    }
    return pages;
}

function base64UrlEncode(value) {
    const text = JSON.stringify(value);
    if (typeof Buffer !== "undefined") {
        return Buffer.from(text, "utf8").toString("base64url");
    }
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
    if (typeof Buffer !== "undefined") {
        return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    }
    const padded = String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value).length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

function normalizeMarkerToken(value) {
    return String(value || "default").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "default";
}

function pdfMarker(data, token = "default") {
    const safeToken = normalizeMarkerToken(token);
    return `\n<!--DPE_PDF:${safeToken}:${base64UrlEncode(data)}-->\n`;
}

function splitPdfMarkers(markdown, token = "default") {
    const text = String(markdown || "");
    const safeToken = normalizeMarkerToken(token);
    const escapedToken = safeToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`<!--DPE_PDF:${escapedToken}:([A-Za-z0-9_-]+)-->`, "g");
    const parts = [];
    let cursor = 0;
    for (const match of text.matchAll(regex)) {
        const before = text.slice(cursor, match.index);
        if (before.trim()) parts.push({ kind: "markdown", markdown: before.trim() });
        parts.push({ kind: "pdf", ...base64UrlDecode(match[1]) });
        cursor = match.index + match[0].length;
    }
    const after = text.slice(cursor);
    if (after.trim()) parts.push({ kind: "markdown", markdown: after.trim() });
    return parts;
}

function extensionOf(pathValue) {
    const clean = String(pathValue || "").split(/[?#]/, 1)[0];
    const match = clean.match(/\.([^.\\/]+)$/);
    return match ? match[1].toLowerCase() : "";
}

function kindFromPath(pathValue) {
    const extension = extensionOf(pathValue);
    if (extension === NOTE_EXTENSION) return "note";
    if (extension === PDF_EXTENSION) return "pdf";
    if (IMAGE_EXTENSIONS.has(extension)) return "image";
    return "unsupported";
}

function mimeForPath(pathValue) {
    return MIME_TYPES[extensionOf(pathValue)] || "application/octet-stream";
}

function titleFromPath(pathValue) {
    const clean = String(pathValue || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const name = clean.split("/").pop() || "Untitled";
    return name.replace(/\.[^.]+$/, "") || name;
}

function safeFilename(value, fallback = "manifest") {
    const cleaned = String(value || "")
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/g, "");
    return cleaned || fallback;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function moveItem(items, fromIndex, toIndex) {
    const copy = [...items];
    if (fromIndex < 0 || fromIndex >= copy.length || toIndex < 0 || toIndex >= copy.length || fromIndex === toIndex) return copy;
    const [item] = copy.splice(fromIndex, 1);
    copy.splice(toIndex, 0, item);
    return copy;
}

function uniqueId(prefix = "source") {
    const random = typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${random}`;
}

function normalizeSource(source) {
    const kind = source.kind || kindFromPath(source.path);
    return {
        id: source.id || uniqueId(kind),
        kind,
        location: source.location || "vault",
        path: String(source.path || ""),
        title: String(source.title || titleFromPath(source.path)),
        enabled: source.enabled !== false,
        excludedSections: Array.isArray(source.excludedSections) ? [...source.excludedSections] : [],
        sectionOrder: Array.isArray(source.sectionOrder) ? [...source.sectionOrder] : [],
        includePreamble: source.includePreamble !== false,
        includeFrontmatter: source.includeFrontmatter === true,
        pageRange: String(source.pageRange || "all"),
        imageFit: ["contain", "cover", "actual"].includes(source.imageFit) ? source.imageFit : "contain",
        caption: String(source.caption || ""),
        showImageCaption: source.showImageCaption !== false,
        showSourceHeader: source.showSourceHeader !== false,
        startOnNewPage: source.startOnNewPage !== false,
    };
}

function pageSizeDimensions(name) {
    return PAGE_SIZES[name] || PAGE_SIZES.Letter;
}

function groupRows(items, rowsPerPage) {
    const size = Math.max(1, Number(rowsPerPage) || 1);
    const pages = [];
    for (let index = 0; index < items.length; index += size) pages.push(items.slice(index, index + size));
    return pages.length ? pages : [[]];
}

function buildPageMap(segments, prefixPages = 0) {
    let cursor = Number(prefixPages) || 0;
    return segments.map((segment) => {
        const pageCount = Number(segment.pageCount) || 0;
        const startPage = pageCount ? cursor + 1 : cursor;
        const endPage = cursor + pageCount;
        cursor = endPage;
        return { ...segment, startPage, endPage, pageCount };
    });
}


return {
    CORE_VERSION,
    IMAGE_EXTENSIONS,
    MIME_TYPES,
    PAGE_SIZES,
    normalizeNewlines,
    stripFrontmatter,
    slugify,
    scanHeadings,
    orderedHeadings,
    reorderSections,
    mergeRanges,
    removeRanges,
    filterSections,
    sliceAnchor,
    splitFencedSegments,
    splitInlineCodeSegments,
    replaceAsync,
    parseWikiEmbed,
    parsePdfPageRangeFromAnchor,
    parsePageRange,
    base64UrlEncode,
    base64UrlDecode,
    pdfMarker,
    splitPdfMarkers,
    extensionOf,
    kindFromPath,
    mimeForPath,
    titleFromPath,
    safeFilename,
    escapeHtml,
    formatBytes,
    moveItem,
    uniqueId,
    normalizeSource,
    pageSizeDimensions,
    groupRows,
    buildPageMap,
};
