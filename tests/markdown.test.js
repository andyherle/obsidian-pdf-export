const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "markdown.js"), "utf8");
const md = vm.runInNewContext(`(() => {${source}\n})()`);

test("renders headings, text formatting, links, and code", () => {
  const html = md.renderStaticMarkdown("# Title\n\nA **bold** line with `code` and [site](https://example.com).\n\n```js\nconst x = 1;\n```");
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /language-js/);
});

test("preserves br tags as line breaks inside the same table cell", () => {
  const html = md.renderStaticMarkdown("| Name | Notes |\n|---|---|\n| A | first<br>second<br />third<br/>fourth | ");
  assert.match(html, /<td[^>]*>first<br class="table-cell-break">second<br class="table-cell-break">third<br class="table-cell-break">fourth<\/td>/);
  assert.doesNotMatch(html, /&lt;br/i);
});

test("does not enable raw br HTML outside tables", () => {
  const html = md.renderStaticMarkdown("Line <br> line");
  assert.match(html, /Line &lt;br&gt; line/);
});

test("renders tasks, tables, and callouts", () => {
  const html = md.renderStaticMarkdown("- [x] Done\n- [ ] Open\n\n| Name | Value |\n|---|---:|\n| A | 2 |\n\n> [!warning] Check\n> Important");
  assert.match(html, /task-list-item is-checked/);
  assert.match(html, /<table>/);
  assert.match(html, /class="align-right"/);
  assert.match(html, /data-callout="warning"/);
});

test("inserts only controlled HTML tokens and escapes user HTML", () => {
  const html = md.renderStaticMarkdown("@@DPE_HTML_0@@\n\n<script>alert(1)</script>", { htmlTokens: ["<figure>safe</figure>"] });
  assert.match(html, /<figure>safe<\/figure>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("renders nested and mixed lists with valid parent closures", () => {
  const html = md.renderStaticMarkdown("- A\n  - B\n    1. C\n- D");
  assert.equal(html, '<ul><li>A<ul><li>B<ol><li>C</li></ol></li></ul></li><li>D</li></ul>');
});

test("hides Obsidian comments but preserves comment markers inside code", () => {
  const html = md.renderStaticMarkdown("Visible %% private %% text\n\n%%\nhidden block\n%%\n\n`%% code %%`\n\n```text\n%% fenced %%\n```");
  assert.match(html, /Visible  text/);
  assert.doesNotMatch(html, /private|hidden block/);
  assert.match(html, /<code>%% code %%<\/code>/);
  assert.match(html, /%% fenced %%/);
});
