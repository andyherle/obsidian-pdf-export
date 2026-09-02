const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");

function loadPlugin() {
  const originalLoad = Module._load;
  class Plugin {}
  class Modal {}
  class PluginSettingTab {}
  class TFile {}
  Module._load = function(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Plugin,
        Modal,
        PluginSettingTab,
        TFile,
        parseYaml: () => ({}),
        loadPdfJs: async () => ({}),
        normalizePath: (value) => String(value).replace(/\\/g, "/"),
        setIcon: () => {},
        Notice: class {},
        Setting: class {},
        apiVersion: "test",
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(path.join(root, "main.js"))];
  const Exporter = require(path.join(root, "main.js"));
  Module._load = originalLoad;
  return { Exporter, TFile };
}

test("a stale PDF Native Notes cache path becomes a missing embed instead of a file error", () => {
  const { Exporter } = loadPlugin();
  const plugin = new Exporter();
  plugin.app = {
    metadataCache: { getFirstLinkpathDest: () => null },
    vault: { getAbstractFileByPath: () => null },
  };
  const stale = "Users/admin/Library/Application_Support/PDF_Native_Notes/cache/images/page-0002.jpg";
  assert.doesNotThrow(() => plugin.resolveTarget(stale, { location: "vault", path: "Notes/source.md" }));
  assert.equal(plugin.resolveTarget(stale, { location: "vault", path: "Notes/source.md" }), null);
});

test("external note embeds resolve JPEG paths with spaces", () => {
  const { Exporter } = loadPlugin();
  const plugin = new Exporter();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dpe-media-test-"));
  try {
    const note = path.join(temporary, "source.md");
    const image = path.join(temporary, "image with space.jpeg");
    fs.writeFileSync(note, "# Source\n");
    fs.writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const result = plugin.resolveTarget("image with space.jpeg", { location: "external", path: note });
    assert.deepEqual(result, { location: "external", path: image });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("JPEG and WebP source bytes are copied into the isolated workspace", async () => {
  const { Exporter } = loadPlugin();
  const plugin = new Exporter();
  const calls = [];
  plugin.readSourceBinary = async (source) => Buffer.from(source.path.endsWith(".webp") ? "webp" : "jpeg");
  const workspace = {
    writeAsset(name, extension, bytes) {
      calls.push({ name, extension, bytes: Buffer.from(bytes).toString("utf8") });
      return `file:///workspace/${name}.${extension}`;
    },
  };
  const jpegUrl = await plugin.materializeImage({ location: "vault", path: "Media/photo.jpeg" }, workspace);
  const webpUrl = await plugin.materializeImage({ location: "vault", path: "Media/frame.webp" }, workspace);
  assert.equal(jpegUrl, "file:///workspace/photo.jpeg");
  assert.equal(webpUrl, "file:///workspace/frame.webp");
  assert.deepEqual(calls, [
    { name: "photo", extension: "jpeg", bytes: "jpeg" },
    { name: "frame", extension: "webp", bytes: "webp" },
  ]);
});
