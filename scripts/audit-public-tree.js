const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ignored = new Set(["node_modules", "dist", ".git", ".bundle-smoke", ".test-build", ".build-local"]);
const forbiddenNames = [/^\.env(?:\.|$)/i, /\.(?:pem|p12|pfx)$/i, /^id_(?:rsa|dsa|ecdsa|ed25519)$/i, /credentials?/i];
const privacyLeakPatterns = [
  /\/Users\/[^/\s]+\//,
  /[A-Z]:\\Users\\[^\\\s]+\\/i,
  /https?:\/\/[^\s"']+\.ts\.net\b/i,
  /https?:\/\/[^\s"']+\.local\b/i,
];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(?:api[_-]?key|client[_-]?secret|private[_-]?key|password|passwd)\s*[:=]\s*["'][^"'\r\n]{8,}["']/i,
];

const files = [];
function walk(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files.push(full);
  }
}
walk(root);

const problems = [];
for (const file of files) {
  const rel = path.relative(root, file);
  if (forbiddenNames.some((pattern) => pattern.test(path.basename(file)))) problems.push(`${rel}: secret-like filename`);
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const pattern of privacyLeakPatterns) if (pattern.test(text)) problems.push(`${rel}: local/private path or host detected`);
  for (const pattern of secretPatterns) if (pattern.test(text)) problems.push(`${rel}: possible credential detected`);
}

if (problems.length) throw new Error(`Public tree audit failed:\n${problems.join("\n")}`);
console.log(`Public tree audit passed (${files.length} files checked).`);
