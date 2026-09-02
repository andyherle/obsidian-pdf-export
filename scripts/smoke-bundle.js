const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");
const mainPath = path.join(root, "main.js");
if (!fs.existsSync(mainPath)) throw new Error("Run npm run build first.");

const originalLoad = Module._load;
class Base {}
class Plugin extends Base {}
class Modal extends Base {}
class PluginSettingTab extends Base {}
class TAbstractFile extends Base {}
class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile {}
class Setting extends Base {}
class Notice extends Base {}
class FileSystemAdapter extends Base {}

Module._load = function(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Plugin,
      Modal,
      PluginSettingTab,
      TAbstractFile,
      TFile,
      TFolder,
      Setting,
      Notice,
      FileSystemAdapter,
      parseYaml: () => ({}),
      loadPdfJs: async () => ({}),
      normalizePath: (value) => String(value),
      setIcon: () => {},
      activeDocument: { createElement: () => ({}) },
      activeWindow: { navigator: { clipboard: { writeText: async () => {} } } },
      Platform: { isMobile: false, isDesktopApp: true },
    };
  }
  if (request === "electron" || request === "@electron/remote") return {};
  return originalLoad.call(this, request, parent, isMain);
};

try {
  delete require.cache[require.resolve(mainPath)];
  const loaded = require(mainPath);
  if (typeof loaded !== "function") throw new Error("main.js does not export an Obsidian plugin class.");
  if (!(loaded.prototype instanceof Plugin)) throw new Error("main.js does not extend Obsidian Plugin.");
  console.log(`Bundle smoke test passed: ${loaded.name || "plugin class"}.`);
} finally {
  Module._load = originalLoad;
}
