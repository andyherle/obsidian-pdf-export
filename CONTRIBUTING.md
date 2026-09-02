# Contributing

## Before a change

1. Open an issue for a large behavior change.
2. Keep the plugin local-first and dependency-free.
3. Do not add telemetry, remote code, runtime downloads, shell commands, or hidden file access.
4. Keep user-facing text in simple, direct English.
5. Keep raw note HTML escaped unless a reviewed parser handles it.

## Development

```bash
npm test
npm run package
```

`npm test` builds `main.js` and runs the JavaScript test suite. `npm run package` creates the manual-install ZIP without a platform-specific `zip` command.

## Pull request checks

- `manifest.json`, `package.json`, and `versions.json` use the same version.
- `main.js` has no relative runtime imports.
- `main.js` is not committed.
- The required release assets are `main.js`, `manifest.json`, and `styles.css`.
- JPEG, JPG, WebP, PNG, note embeds, PDF embeds, section exclusion, source order, and nested lists are tested.
- The print window stays sandboxed and has no Node integration.
- No private Vault content is committed.
