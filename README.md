# mvmOS Desktop

Native desktop client for [mvmOS](https://mvmos.org). Lets you add one or more mvmOS installations, then open and switch between their internal desktop and public Apps Hub as persistent, independently-loaded tabs — without a browser.

Built on Electron, so every platform runs the exact same Chromium engine and the same layout code — there is no per-OS window handling.

## Features

- Add, edit, remove and reorder installations (drag them or use the arrow buttons); the list is stored in the user data directory.
- Each installation opens its desktop and its public Apps Hub as separate tabs; links that leave the installation open in the system browser.
- Hiding the sidebar removes it completely — the page takes the whole window. Toggle it with `Ctrl`/`Cmd`+`B`, the `‹` button, the View menu or the right-click menu on any page.
- Dark theme throughout, including the app's own dialogs.

## Development

Prerequisites: Node.js 20+.

```sh
npm install
npm start
```

## Building

```sh
npm run dist:linux   # .deb and .AppImage
npm run dist:win     # NSIS installer
npm run dist:mac     # universal .dmg (unsigned)
```

Cross-platform builds run automatically via GitHub Actions on every push to `main`; grab the installers from the workflow run's artifacts. The macOS build is unsigned, so the first launch needs the usual "Open anyway" from System Settings → Privacy & Security.
