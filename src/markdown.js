const STATIC_MARKDOWN_VERSION = "2.0.0";

function renderStaticMarkdown(markdown, options = {}) {
    const htmlTokens = options.htmlTokens || [];
    const text = stripObsidianComments(String(markdown || "").replace(/\r\n?/g, "\n"));
    const lines = text.split("\n");
    const output = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();

        if (!trimmed) {
            index += 1;
            continue;
        }

        const token = trimmed.match(/^@@DPE_HTML_(\d+)@@$/);
        if (token) {
            const value = htmlTokens[Number(token[1])];
            if (typeof value === "string") output.push(value);
            index += 1;
            continue;
        }

        const fence = line.match(/^\s{0,3}(`{3,}|~{3,})([^`]*)$/);
        if (fence) {
            const marker = fence[1][0];
            const length = fence[1].length;
            const language = fence[2].trim().split(/\s+/)[0] || "";
            const body = [];
            index += 1;
            while (index < lines.length) {
                const close = lines[index].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
                if (close && close[1][0] === marker && close[1].length >= length) {
                    index += 1;
                    break;
                }
                body.push(lines[index]);
                index += 1;
            }
            const languageClass = language ? ` class="language-${escapeAttribute(language)}"` : "";
            output.push(`<pre><code${languageClass}>${escapeHtml(body.join("\n"))}</code></pre>`);
            continue;
        }

        const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (heading) {
            const level = heading[1].length;
            const title = heading[2].trim();
            const id = slugify(title);
            output.push(`<h${level} id="${escapeAttribute(id)}">${renderInline(title)}</h${level}>`);
            index += 1;
            continue;
        }

        if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
            output.push("<hr>");
            index += 1;
            continue;
        }

        if (isTableStart(lines, index)) {
            const rendered = renderTable(lines, index);
            output.push(rendered.html);
            index = rendered.nextIndex;
            continue;
        }

        if (/^\s*>/.test(line)) {
            const block = [];
            while (index < lines.length && (/^\s*>/.test(lines[index]) || !lines[index].trim())) {
                if (!lines[index].trim()) block.push("");
                else block.push(lines[index].replace(/^\s*>\s?/, ""));
                index += 1;
            }
            output.push(renderQuoteOrCallout(block));
            continue;
        }

        if (isListLine(line)) {
            const rendered = renderList(lines, index);
            output.push(rendered.html);
            index = rendered.nextIndex;
            continue;
        }

        if (/^\s{4,}\S/.test(line)) {
            const body = [];
            while (index < lines.length && (/^\s{4,}/.test(lines[index]) || !lines[index].trim())) {
                body.push(lines[index].replace(/^\s{4}/, ""));
                index += 1;
            }
            output.push(`<pre><code>${escapeHtml(body.join("\n").trimEnd())}</code></pre>`);
            continue;
        }

        const paragraph = [line.trim()];
        index += 1;
        while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
            paragraph.push(lines[index].trim());
            index += 1;
        }
        output.push(`<p>${renderInline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
    }

    return output.join("\n");
}


function stripObsidianComments(text) {
    const lines = String(text || "").split("\n");
    const output = [];
    let fenceChar = null;
    let fenceLength = 0;
    let inComment = false;

    for (const line of lines) {
        const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (!inComment && fence) {
            const token = fence[1];
            if (!fenceChar) {
                fenceChar = token[0];
                fenceLength = token.length;
            } else if (token[0] === fenceChar && token.length >= fenceLength) {
                fenceChar = null;
                fenceLength = 0;
            }
            output.push(line);
            continue;
        }
        if (fenceChar) {
            output.push(line);
            continue;
        }

        let rendered = "";
        let index = 0;
        let codeRun = "";
        while (index < line.length) {
            if (!inComment && line[index] === "`") {
                let end = index + 1;
                while (end < line.length && line[end] === "`") end += 1;
                const run = line.slice(index, end);
                if (!codeRun) codeRun = run;
                else if (run === codeRun) codeRun = "";
                rendered += run;
                index = end;
                continue;
            }
            if (!codeRun && line.slice(index, index + 2) === "%%") {
                inComment = !inComment;
                index += 2;
                continue;
            }
            if (!inComment) rendered += line[index];
            index += 1;
        }
        output.push(rendered);
    }
    return output.join("\n");
}

function startsBlock(lines, index) {
    const line = lines[index] || "";
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^@@DPE_HTML_\d+@@$/.test(trimmed)) return true;
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) return true;
    if (/^(#{1,6})\s+/.test(line)) return true;
    if (/^\s*>/.test(line)) return true;
    if (isListLine(line)) return true;
    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) return true;
    if (isTableStart(lines, index)) return true;
    return false;
}

function isListLine(line) {
    return /^(\s*)([-+*]|\d+[.)])\s+/.test(line || "");
}

function renderList(lines, startIndex) {
    const items = [];
    let index = startIndex;
    while (index < lines.length) {
        const match = lines[index].match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
        if (!match) break;
        const indent = Math.floor(match[1].replace(/\t/g, "    ").length / 2);
        const ordered = /^\d/.test(match[2]);
        let content = match[3];
        index += 1;
        const continuation = [];
        while (index < lines.length && lines[index].trim() && !isListLine(lines[index]) && !startsBlock(lines, index)) {
            continuation.push(lines[index].trim());
            index += 1;
        }
        if (continuation.length) content += ` ${continuation.join(" ")}`;
        items.push({ indent, ordered, content });
    }

    let cursor = 0;
    function renderLevel(indent) {
        const output = [];
        while (cursor < items.length && items[cursor].indent === indent) {
            const ordered = items[cursor].ordered;
            const tag = ordered ? "ol" : "ul";
            output.push(`<${tag}>`);
            while (cursor < items.length && items[cursor].indent === indent && items[cursor].ordered === ordered) {
                const item = items[cursor];
                cursor += 1;
                const task = item.content.match(/^\[([ xX])\]\s*(.*)$/);
                if (task) {
                    const checked = task[1].toLowerCase() === "x";
                    output.push(`<li class="task-list-item${checked ? " is-checked" : ""}"><input type="checkbox"${checked ? " checked" : ""} disabled> ${renderInline(task[2])}`);
                } else {
                    output.push(`<li>${renderInline(item.content)}`);
                }
                while (cursor < items.length && items[cursor].indent > indent) {
                    output.push(renderLevel(items[cursor].indent));
                }
                output.push("</li>");
            }
            output.push(`</${tag}>`);
        }
        return output.join("");
    }

    return { html: items.length ? renderLevel(items[0].indent) : "", nextIndex: index };
}

function isTableStart(lines, index) {
    if (index + 1 >= lines.length) return false;
    const header = lines[index];
    const separator = lines[index + 1];
    return header.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator);
}

function splitTableRow(line) {
    let value = String(line || "").trim();
    if (value.startsWith("|")) value = value.slice(1);
    if (value.endsWith("|")) value = value.slice(0, -1);
    const cells = [];
    let current = "";
    let escaped = false;
    let code = false;
    for (const char of value) {
        if (escaped) {
            current += char;
            escaped = false;
        } else if (char === "\\") {
            escaped = true;
            current += char;
        } else if (char === "`") {
            code = !code;
            current += char;
        } else if (char === "|" && !code) {
            cells.push(current.trim());
            current = "";
        } else {
            current += char;
        }
    }
    cells.push(current.trim());
    return cells;
}

function renderTable(lines, startIndex) {
    const headers = splitTableRow(lines[startIndex]);
    const separator = splitTableRow(lines[startIndex + 1]);
    const alignments = separator.map((cell) => {
        const left = cell.trim().startsWith(":");
        const right = cell.trim().endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
    });
    let index = startIndex + 2;
    const rows = [];
    while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
    }
    const renderCell = (cell) => {
        const normalized = String(cell || "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/[ \t]{2,}/g, " ")
            .trim();
        return renderInline(normalized).replace(/\n/g, '<br class="table-cell-break">');
    };
    const headerHtml = headers.map((cell, i) => `<th class="align-${alignments[i] || "left"}">${renderCell(cell)}</th>`).join("");
    const bodyHtml = rows.map((row) => `<tr>${headers.map((_, i) => `<td class="align-${alignments[i] || "left"}">${renderCell(row[i] || "")}</td>`).join("")}</tr>`).join("");
    return { html: `<div class="table-wrapper"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`, nextIndex: index };
}

function renderQuoteOrCallout(lines) {
    const clean = [...lines];
    while (clean.length && !clean[0].trim()) clean.shift();
    while (clean.length && !clean[clean.length - 1].trim()) clean.pop();
    const first = clean[0] || "";
    const callout = first.match(/^\[!([A-Za-z0-9_-]+)\]([+-])?\s*(.*)$/);
    if (!callout) {
        return `<blockquote>${renderStaticMarkdown(clean.join("\n"))}</blockquote>`;
    }
    clean.shift();
    const type = callout[1].toLowerCase();
    const title = callout[3].trim() || titleCase(type);
    return `<div class="callout" data-callout="${escapeAttribute(type)}"><div class="callout-title"><span class="callout-title-inner">${renderInline(title)}</span></div><div class="callout-content">${renderStaticMarkdown(clean.join("\n"))}</div></div>`;
}

function renderInline(input) {
    const protectedValues = [];
    let value = String(input || "");
    value = value.replace(/`([^`]+)`/g, (_, code) => {
        const id = protectedValues.length;
        protectedValues.push(`<code>${escapeHtml(code)}</code>`);
        return `@@DPE-CODE-${id}@@`;
    });
    value = escapeHtml(value);

    value = value.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt) => `<span class="missing-embed">[image: ${escapeHtml(alt || "missing")}]</span>`);
    value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a class="external-link" href="$2">$1</a>');
    value = value.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, target, alias) => `<span class="internal-link">${alias || target}</span>`);
    value = value.replace(/&lt;(https?:\/\/[^&]+)&gt;/g, '<a class="external-link" href="$1">$1</a>');
    value = value.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a class="external-link" href="$2">$2</a>');

    value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    value = value.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    value = value.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    value = value.replace(/==([^=]+)==/g, "<mark>$1</mark>");
    value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    value = value.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

    value = value.replace(/@@DPE-CODE-(\d+)@@/g, (_, rawIndex) => protectedValues[Number(rawIndex)] || "");
    return value;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
}

function slugify(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "section";
}

function titleCase(value) {
    return String(value || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

return {
    STATIC_MARKDOWN_VERSION,
    renderStaticMarkdown,
    renderInline,
    stripObsidianComments,
    renderTable,
    renderList,
    escapeHtml,
    slugify,
};
