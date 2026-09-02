# Community Plugins release

## Before release

1. Run `npm ci`.
2. Run `npm run validate`.
3. Run `npm run package`.
4. Install the generated ZIP in a clean test Vault.
5. Complete `docs/TEST-MATRIX.md`.

## GitHub release

The repository uses `main` as the release branch.

For each version:

1. Update `manifest.json`, `package.json`, `versions.json`, and `CHANGELOG.md`.
2. Push the tested change to `main`.
3. The release workflow creates a tag that exactly matches the version, such as `1.0.0`.
4. The release publishes `main.js`, `manifest.json`, and `styles.css`.
5. The release also includes a manual-install ZIP.

Do not add a `v` before the tag version. If a tag already exists, the workflow checks out that exact tag before rebuilding its release assets.

## Product disclosure

Document PDF Exporter is desktop-only. It reads files selected for an export and local files embedded by those notes. It can read a file outside the Vault when the user selects it. It has no telemetry and does not upload export content. PDF output is created inside Obsidian.
