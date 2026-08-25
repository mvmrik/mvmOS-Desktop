# mvmOS Desktop

Native desktop client for [mvmOS](https://mvmos.org). Lets you add one or more mvmOS installations, then open and switch between their internal desktop and public Apps Hub as persistent, independently-loaded tabs — without a browser.

## Development

Prerequisites: Node.js 22+, Rust (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev
```

## Building

```sh
npm run tauri build
```

Cross-platform builds (Linux, Windows, macOS universal) run automatically via GitHub Actions on every push to `main`; grab the installers from the workflow run's artifacts.
