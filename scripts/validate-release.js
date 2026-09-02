const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const pkg = JSON.parse(read("package.json"));
const versions = JSON.parse(read("versions.json"));

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const full = path.join(root, file);
  if (!fs.existsSync(full) || fs.statSync(full).size === 0) throw new Error(`Missing release file: ${file}`);
}

nonEmpty(manifest.id, "manifest id");
nonEmpty(manifest.name, "manifest name");
const description = nonEmpty(manifest.description, "manifest description");
nonEmpty(manifest.author, "manifest author");
nonEmpty(manifest.minAppVersion, "minimum Obsidian version");
if (!/^[a-z0-9-]+$/.test(manifest.id) || manifest.id.includes("obsidian")) throw new Error("Plugin id must be lowercase and must not contain obsidian.");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Plugin version must use x.y.z.");
if (!/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion)) throw new Error("Minimum Obsidian version must use x.y.z.");
if (description.length > 250 || /[\r\n]/.test(description)) throw new Error("Manifest description must be one line and 250 characters or fewer.");
if (manifest.version !== pkg.version) throw new Error("manifest.json and package.json versions do not match.");
if (pkg.name !== manifest.id) throw new Error("package.json name must match the plugin id.");
if (versions[manifest.version] !== manifest.minAppVersion) throw new Error("versions.json does not match manifest.json.");
if (manifest.isDesktopOnly !== true) throw new Error("This plugin must remain desktop-only because it uses Electron PDF output.");

const bundle = read("main.js");
for (const forbidden of ["child_process", "python", "sourceMappingURL", "sourcesContent", "requestUrl", "XMLHttpRequest", "fetch("]) {
  if (bundle.includes(forbidden)) throw new Error(`Runtime bundle contains forbidden behavior: ${forbidden}`);
}
for (const required of ['require("obsidian")', "loadPdfJs", "printToPDF"]) {
  if (!bundle.includes(required)) throw new Error(`Runtime bundle is missing ${required}.`);
}

const settingsSource = read("src/plugin.js");
if (/class\s+ManifestExporterSettingTab[\s\S]*?createEl\(\s*["']h[1-6]["']/.test(settingsSource)) {
  throw new Error("Settings headings must use Setting.setHeading().");
}
if (/\bdocument\.createElement\(/.test(settingsSource)) {
  throw new Error("Use Obsidian activeDocument instead of the global document.");
}
if (/(^|[^.\w])navigator\.clipboard\b/m.test(settingsSource)) {
  throw new Error("Use Obsidian activeWindow for clipboard access.");
}

console.log(`Validated ${manifest.name} ${manifest.version}.`);
