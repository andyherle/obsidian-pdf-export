const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");

test("release contains the three required Obsidian assets", () => {
  const release = path.join(root, "dist", "document-pdf-exporter");
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    assert.ok(fs.statSync(path.join(release, file)).size > 0, `${file} is missing`);
  }
  for (const forbidden of [".py", ".command", "runtime.js"]) {
    assert.equal(fs.readdirSync(release).some((name) => name.toLowerCase().endsWith(forbidden)), false);
  }
});

test("release UI styles are generated from src/styles.css", () => {
  const source = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
  const rootStyles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const releaseStyles = fs.readFileSync(path.join(root, "dist", "document-pdf-exporter", "styles.css"), "utf8");
  assert.equal(rootStyles, source);
  assert.equal(releaseStyles, source);
});

test("main.js has no legacy runtime dependencies", () => {
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  assert.doesNotMatch(main, /require\(["']\.\.?\//);
  assert.doesNotMatch(main, /child_process|Install\.command|Diagnose\.command|runtime\.js/);
  assert.match(main, /loadPdfJs/);
  assert.match(main, /printToPDF/);
});

test("plugin entry loads with the public Obsidian surface mocked", () => {
  const originalLoad = Module._load;
  class Plugin {}
  class Modal {}
  class PluginSettingTab {}
  class TFile {}
  Module._load = function(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Plugin, Modal, PluginSettingTab, TFile,
        parseYaml: () => ({}),
        loadPdfJs: async () => ({}),
        normalizePath: (value) => value,
        setIcon: () => {},
        Notice: class {},
        Setting: class {},
        apiVersion: "test",
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(path.join(root, "main.js"))];
    const Exporter = require(path.join(root, "main.js"));
    assert.equal(typeof Exporter, "function");
    assert.ok(Exporter.prototype instanceof Plugin);
  } finally {
    Module._load = originalLoad;
  }
});


test("plugin registers its UI without an external runtime", async () => {
  const originalLoad = Module._load;
  const commands = [];
  let ribbon = null;
  let settingsTab = null;
  class Plugin {
    async loadData() { return { onboardingComplete: true }; }
    async saveData() {}
    addRibbonIcon(icon, title, callback) { ribbon = { icon, title, callback }; }
    addCommand(command) { commands.push(command); }
    addSettingTab(tab) { settingsTab = tab; }
  }
  class Modal {}
  class PluginSettingTab {
    constructor(app, plugin) { this.app = app; this.plugin = plugin; }
  }
  class TFile {}
  Module._load = function(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Plugin, Modal, PluginSettingTab, TFile,
        parseYaml: () => ({}),
        loadPdfJs: async () => ({}),
        normalizePath: (value) => value,
        setIcon: () => {},
        Notice: class {},
        Setting: class {},
        apiVersion: "test",
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(path.join(root, "main.js"))];
    const Exporter = require(path.join(root, "main.js"));
    const plugin = new Exporter();
    plugin.app = {
      workspace: {
        getActiveFile: () => null,
        onLayoutReady: (callback) => callback(),
      },
      vault: {},
    };
    await plugin.onload();
    assert.equal(ribbon.title, "Open Document PDF Exporter");
    assert.deepEqual(commands.map((command) => command.id), ["open-document-builder", "export-active-note"]);
    assert.ok(settingsTab instanceof PluginSettingTab);
  } finally {
    Module._load = originalLoad;
  }
});

test("plugin does not invoke Obsidian Markdown post-processors", () => {
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  assert.doesNotMatch(main, /MarkdownRenderer/);
  assert.doesNotMatch(main, /registerMarkdownPostProcessor/);
});

test("export UI does not add a technical source manifest", () => {
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  assert.doesNotMatch(main, /SHA-256|Source manifest|renderSourceManifest/);
});

test("new exports default to no cover and PDF page labels do not repeat titles", () => {
  const source = fs.readFileSync(path.join(root, "src", "plugin.js"), "utf8");
  assert.match(source, /cover: false/);
  assert.doesNotMatch(source, /pdf-export-pdf-page-label[^`]*\$\{core\.escapeHtml\(source\.title\)\}/);
  assert.doesNotMatch(source, /pdf-export-pdf-page-label[^`]*titleFromPath\(target\.path\)/);
  assert.match(source, /pdf-export-pdf-page-label\">Page \${page\.pageNumber} of \${page\.totalPages}/);
});

test("Electron PDF rendering is sandboxed and uses current printToPDF margins", async () => {
  const originalLoad = Module._load;
  class Plugin {}
  class Modal {}
  class PluginSettingTab {}
  class TFile {}
  Module._load = function(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Plugin, Modal, PluginSettingTab, TFile,
        parseYaml: () => ({}),
        loadPdfJs: async () => ({}),
        normalizePath: (value) => value,
        setIcon: () => {},
        Notice: class {},
        Setting: class {},
        apiVersion: "test",
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let browserOptions = null;
  let printOptions = null;
  let closed = false;
  class BrowserWindow {
    constructor(options) {
      browserOptions = options;
      this.webContents = {
        setWindowOpenHandler() {},
        on() {},
        executeJavaScript: async () => true,
        printToPDF: async (optionsValue) => {
          printOptions = optionsValue;
          return Buffer.from("%PDF-1.7\nmock\n%%EOF");
        },
      };
    }
    async loadFile() {}
    isDestroyed() { return false; }
    close() { closed = true; }
  }

  try {
    delete require.cache[require.resolve(path.join(root, "main.js"))];
    const Exporter = require(path.join(root, "main.js"));
    const plugin = new Exporter();
    plugin.getElectronApi = () => ({ BrowserWindow });
    const result = await plugin.renderPdf("/tmp/manifest.html", { pageSize: "A4", pageNumbers: true });
    assert.match(result.toString(), /^%PDF-/);
    assert.equal(browserOptions.show, false);
    assert.equal(browserOptions.webPreferences.sandbox, true);
    assert.equal(browserOptions.webPreferences.contextIsolation, true);
    assert.equal(browserOptions.webPreferences.nodeIntegration, false);
    assert.equal(browserOptions.webPreferences.webSecurity, true);
    assert.equal(browserOptions.webPreferences.backgroundThrottling, false);
    assert.equal(printOptions.pageSize, "A4");
    assert.equal(printOptions.preferCSSPageSize, true);
    assert.deepEqual(printOptions.margins, { top: 0, bottom: 0, left: 0, right: 0 });
    assert.equal(closed, true);
  } finally {
    Module._load = originalLoad;
  }
});

test("the Node-only packager creates a portable install ZIP", () => {
  const { execFileSync } = require("node:child_process");
  execFileSync(process.execPath, [path.join(root, "scripts", "package.js")], { cwd: root });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const archivePath = path.join(root, "dist", `document-pdf-exporter-${manifest.version}.zip`);
  const archive = fs.readFileSync(archivePath);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.ok(archive.includes(Buffer.from("document-pdf-exporter/main.js")));
  assert.ok(archive.includes(Buffer.from("document-pdf-exporter/manifest.json")));
  assert.ok(archive.includes(Buffer.from("document-pdf-exporter/styles.css")));
  assert.ok(archive.includes(Buffer.from("document-pdf-exporter/README.md")));
  assert.ok(archive.includes(Buffer.from("document-pdf-exporter/LICENSE")));
  assert.ok(archive.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])));
});
