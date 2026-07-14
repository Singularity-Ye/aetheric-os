# Aetheric OS · 松果天工台

Aetheric OS is an Obsidian-based personal knowledge and agent operations workspace. It combines workspace-first Vault navigation, knowledge context, scoped relationship graphs, task and log observability, and adapters for existing automation systems in one persistent shell.

## Current capabilities

- Persistent Aetheric shell with safe restoration of the native Obsidian UI
- Workspace-first navigation, virtualized file lists, recent items, and favorites
- Knowledge-node metadata, backlinks, outgoing links, and Markdown preview
- Five graph scopes backed by `MetadataCache`, with an embedded native local graph
- Command Center for Vault search, commands, and workspace switching
- Hamasxiang health/task adapter and unified live log dock

## Development

Requirements:

- Node.js 20 or newer
- Obsidian desktop

Install and build:

```powershell
npm install
npm run build
```

The build runs TypeScript validation and bundles the plugin with esbuild. By default, artifacts are copied to the local development Vault configured in `esbuild.config.mjs`. Set `OBSIDIAN_PLUGIN_DIR` in a local `.env` file to use another plugin directory.

## Source of truth

- `src/`, `styles.css`, and `src/styles/` are authoritative source files.
- The Obsidian plugin directory contains generated deployment artifacts and should not be edited directly.
- `_baseline/` is a local pre-Git recovery snapshot and is intentionally excluded from the repository.

## Status

The project is under active development. The current focus is Phase 5 graph stability and in-place scope transitions. See [walkthrough.md](./walkthrough.md) for the implementation record and current boundaries.

## License

MIT

