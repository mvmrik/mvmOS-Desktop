# mvmOS Desktop

Native desktop client for [mvmOS](https://mvmos.org). Lets you add one or more mvmOS installations — and any other website you want alongside them — then open and switch between their pages as persistent, independently-loaded tabs, without a browser.

Built on Electron, so every platform runs the exact same Chromium engine and the same layout code — there is no per-OS window handling.

## Features

- Add, edit, remove and reorder installations (drag them or use the arrow buttons); the list is stored in the user data directory.
- Each installation opens its desktop and its public Apps Hub as separate tabs; links that leave the installation open in the system browser. A link opened in a new window becomes a tab nested under the one it came from.
- An entry can also be a plain website instead of an mvmOS installation. Such a tab browses freely, the way a browser window would.
- Every entry and every tab shows the site's own icon, looked up when the address is added and kept up to date from the pages themselves.
- Unread counts a page puts in its title — `(3) Inbox` — are shown next to the tab and added up on the app's own icon: a dock badge on macOS, a taskbar overlay on Windows, a launcher count on the Linux desktops that support it.
- The window's size and position, the sidebar state and every open tab come back the next time the app is started.
- A saved http address is rewritten to https once the server is seen redirecting there.
- On startup the app asks GitHub for the newest release and offers a download link when there is one; `Help → Check for updates…` asks on demand.
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
