const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distRoot = path.join(root, "dist");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pluginDir = path.join(distRoot, manifest.id);

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function clean() {
  fs.rmSync(distRoot, { recursive: true, force: true });
  fs.mkdirSync(pluginDir, { recursive: true });
}

function buildMain() {
  const core = read("src/core.js");
  const markdown = read("src/markdown.js");
  const printCss = read("src/print.css");
  const plugin = read("src/plugin.js")
    .replace("__DPE_PRINT_CSS__", JSON.stringify(printCss))
    .replace("__DPE_VERSION__", JSON.stringify(manifest.version));
  const banner = `/*\n * ${manifest.name} ${manifest.version}\n * Generated from the source files in this repository.\n * PDF output uses Obsidian's desktop Electron runtime.\n */\n`;
  const output = `${banner}\nconst core = (() => {\n${core}\n})();\n\nconst staticMarkdown = (() => {\n${markdown}\n})();\n\n${plugin}\n`;
  fs.writeFileSync(path.join(root, "main.js"), output, "utf8");
  fs.writeFileSync(path.join(pluginDir, "main.js"), output, "utf8");
  return output;
}

function buildStyles() {
  const styles = read("src/styles.css");
  fs.writeFileSync(path.join(root, "styles.css"), styles, "utf8");
  fs.writeFileSync(path.join(pluginDir, "styles.css"), styles, "utf8");
}

function copyReleaseFiles() {
  for (const file of ["manifest.json", "LICENSE", "README.md"]) {
    fs.copyFileSync(path.join(root, file), path.join(pluginDir, file));
  }
}

function validateBundle(main) {
  if (!manifest.isDesktopOnly) throw new Error("The plugin must remain desktop-only.");
  if (/require\(["']\.\.?\//.test(main)) throw new Error("main.js must not use relative runtime imports.");
  for (const forbidden of ["python", "child_process", "Install.command", "Diagnose.command", "runtime.js", "registerMarkdownPostProcessor", "requestUrl", "XMLHttpRequest", "fetch("]) {
    if (main.includes(forbidden)) throw new Error(`main.js contains forbidden runtime behavior: ${forbidden}`);
  }
  for (const required of ["loadPdfJs", "printToPDF", 'require("obsidian")', manifest.name, manifest.version]) {
    if (!main.includes(required)) throw new Error(`main.js is missing: ${required}`);
  }
  if (/sourceMappingURL|sourcesContent/.test(main)) throw new Error("main.js must not contain an embedded source map.");
}

clean();
const main = buildMain();
buildStyles();
copyReleaseFiles();
validateBundle(main);
console.log(`Built ${path.relative(root, pluginDir)} (${Buffer.byteLength(main).toLocaleString()} bytes)`);
