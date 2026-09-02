const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadReturnedModule(file) {
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  return vm.runInNewContext(`(() => {${source}\n})()`, { crypto: globalThis.crypto, Buffer });
}

const core = loadReturnedModule("src/core.js");

test("supports JPG, JPEG, WebP, PDFs, and notes", () => {
  assert.equal(core.kindFromPath("photo.jpg"), "image");
  assert.equal(core.kindFromPath("photo.JPEG"), "image");
  assert.equal(core.kindFromPath("photo.webp"), "image");
  assert.equal(core.kindFromPath("document.pdf"), "pdf");
  assert.equal(core.kindFromPath("note.md"), "note");
  assert.equal(core.mimeForPath("photo.jpeg"), "image/jpeg");
  assert.equal(core.mimeForPath("photo.webp"), "image/webp");
});

test("scans headings outside fenced code", () => {
  const headings = core.scanHeadings("# One\n\n```md\n# Not a heading\n```\n\n## Two\nText");
  assert.deepEqual(Array.from(headings, (heading) => heading.title), ["One", "Two"]);
  assert.equal(headings[1].parentId, headings[0].id);
});

test("turning off a parent removes its child tree", () => {
  const text = "Intro\n\n# Keep\nA\n\n# Remove\nB\n\n## Child\nC\n\n# End\nD";
  const headings = core.scanHeadings(text);
  const remove = headings.find((heading) => heading.title === "Remove");
  const result = core.filterSections(text, [remove.id], true).markdown;
  assert.match(result, /# Keep/);
  assert.doesNotMatch(result, /# Remove|## Child|\nC/);
  assert.match(result, /# End/);
});

test("keeps explicit PDF page order and supports reverse ranges", () => {
  assert.deepEqual(Array.from(core.parsePageRange("3,1,2,5-7", 10)), [3, 1, 2, 5, 6, 7]);
  assert.deepEqual(Array.from(core.parsePageRange("5-3", 7)), [5, 4, 3]);
  assert.deepEqual(Array.from(core.parsePageRange("5-", 7)), [5, 6, 7]);
  assert.deepEqual(Array.from(core.parsePageRange("all", 3)), [1, 2, 3]);
  assert.throws(() => core.parsePageRange("8", 7));
});

test("reorders sibling heading sections while keeping child sections with their parent", () => {
  const text = "Intro\n\n# Alpha\nA\n\n## A child\nAC\n\n# Beta\nB\n\n## B child\nBC";
  const headings = core.scanHeadings(text);
  const alpha = headings.find((heading) => heading.title === "Alpha");
  const beta = headings.find((heading) => heading.title === "Beta");
  const reordered = core.reorderSections(text, [beta.id, alpha.id]);
  assert.ok(reordered.indexOf("# Beta") < reordered.indexOf("# Alpha"));
  assert.ok(reordered.indexOf("## B child") < reordered.indexOf("# Alpha"));
  assert.ok(reordered.indexOf("## A child") > reordered.indexOf("# Alpha"));
});

test("normalizes source rendering options", () => {
  const source = core.normalizeSource({ path: "x.webp", startOnNewPage: false });
  assert.equal(source.kind, "image");
  assert.equal(source.startOnNewPage, false);
  assert.equal(source.imageFit, "contain");
  assert.deepEqual(Array.from(source.sectionOrder), []);
});
