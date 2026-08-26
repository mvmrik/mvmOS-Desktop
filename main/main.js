"use strict";

/*
 * Window layout.
 *
 * The window's own web contents render the chrome (sidebar plus the status
 * area next to it) across the whole window, and every open installation is a
 * `WebContentsView` laid on top of the right-hand part of it. Only the active
 * tab is visible, so switching tabs is a visibility change rather than a
 * reload, and hiding the sidebar simply moves the tab's left edge to zero.
 *
 * Bounds are in device-independent pixels on all three platforms, which is why
 * none of this needs per-OS code.
 */

const {
  app,
  BrowserWindow,
  Menu,
  WebContentsView,
  ipcMain,
  nativeImage,
  screen,
  shell,
} = require("electron");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const store = require("./store");
const favicon = require("./favicon");
const { checkForUpdate } = require("./update");
const { normalizeAddress, originOf, sameSite, isReachable, upgradeScheme } = require("./net");

const SIDEBAR_WIDTH = 260;
const DEFAULT_BOUNDS = { width: 1280, height: 800 };

let win = null;
let installations = [];
let session = {};

/** tabId -> { view, info, origin, url, visible } */
const tabs = new Map();
let activeTabId = null;
let sidebarVisible = true;
// Raised while the chrome shows a dialog of its own: the tab is hidden so the
// dialog is centred on the whole window instead of being clipped by the strip.
let overlayOpen = false;

/* ------------------------------------------------------------------ layout */

function contentBounds() {
  const { width, height } = win.getContentBounds();
  const x = sidebarVisible ? SIDEBAR_WIDTH : 0;
  return { x, y: 0, width: Math.max(width - x, 0), height };
}

/*
 * Every tab view stays attached to the window for its whole life and is only
 * toggled visible: detaching and re-attaching a `WebContentsView` leaves it
 * blank when it comes back, which is exactly the "nothing loads" symptom this
 * app is meant to be free of.
 */
function setViewVisible(tab, visible) {
  if (typeof tab.view.setVisible === "function") {
    tab.view.setVisible(visible);
  } else if (!visible) {
    // Older runtimes without setVisible: park it outside the content area.
    tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
  tab.visible = visible;
}

function applyLayout() {
  if (!win || win.isDestroyed()) return;
  const bounds = contentBounds();
  for (const [id, tab] of tabs) {
    const shouldShow = id === activeTabId && !overlayOpen;
    if (shouldShow) tab.view.setBounds(bounds);
    setViewVisible(tab, shouldShow);
  }
}

function setSidebarVisible(visible) {
  sidebarVisible = Boolean(visible);
  applyLayout();
  persistSession();
  if (win && !win.isDestroyed()) {
    win.webContents.send("sidebar:changed", sidebarVisible);
  }
}

/* ----------------------------------------------------------------- session */

let sessionTimer = null;
/*
 * Closing the window is the last moment the session is still worth writing:
 * everything after it - the views being torn down, the app quitting - would
 * only record an empty window over the one the user actually had open.
 */
let sessionFrozen = false;

/*
 * Everything the next start needs to look like this one: where the window was,
 * whether the sidebar was up, and which pages were open in which order. Writes
 * are coalesced because navigation inside a tab triggers them freely.
 */
function sessionSnapshot() {
  const openTabs = [];
  for (const [id, tab] of tabs) {
    openTabs.push({
      id,
      installationId: tab.info.installationId,
      kind: tab.info.kind,
      parentId: tab.info.parentId,
      url: tab.url,
      title: tab.info.title,
    });
  }
  const snapshot = { sidebarVisible, tabs: openTabs, activeTabId };
  if (win && !win.isDestroyed()) {
    // getNormalBounds() is the un-maximised geometry, which is the one worth
    // remembering: a window restored from a maximised state needs somewhere to
    // go when the user un-maximises it.
    snapshot.maximized = win.isMaximized();
    snapshot.bounds = win.getNormalBounds();
  } else {
    snapshot.maximized = Boolean(session.maximized);
    snapshot.bounds = session.bounds || null;
  }
  return snapshot;
}

function persistSession() {
  if (sessionFrozen) return;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    session = sessionSnapshot();
    store.saveSession(session);
  }, 400);
}

function persistSessionNow() {
  if (sessionFrozen) return;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = null;
  session = sessionSnapshot();
  store.saveSession(session);
}

/* -------------------------------------------------------------------- tabs */

function descendantsOf(tabId) {
  const ids = new Set([tabId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, tab] of tabs) {
      if (tab.info.parentId && ids.has(tab.info.parentId) && !ids.has(id)) {
        ids.add(id);
        grew = true;
      }
    }
  }
  return ids;
}

function destroyTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  if (win && !win.isDestroyed()) {
    win.contentView.removeChildView(tab.view);
  }
  tabs.delete(tabId);
  if (!tab.view.webContents.isDestroyed()) {
    tab.view.webContents.close();
  }
}

function closeTabTree(tabId) {
  for (const id of descendantsOf(tabId)) {
    if (id === activeTabId) activeTabId = null;
    destroyTab(id);
  }
  applyLayout();
  persistSession();
}

function tabContextMenu(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const wc = tab.view.webContents;
  Menu.buildFromTemplate([
    { label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: "Reload", click: () => wc.reload() },
    { type: "separator" },
    {
      label: sidebarVisible ? "Hide sidebar" : "Show sidebar",
      accelerator: "CmdOrCtrl+B",
      click: () => setSidebarVisible(!sidebarVisible),
    },
    { type: "separator" },
    { label: "Close tab", click: () => {
      closeTabTree(tabId);
      win.webContents.send("tab:closed", tabId);
    } },
  ]).popup({ window: win });
}

function startUrlFor(installation, kind) {
  if (installation.type === "site") return installation.address;
  return `${installation.address}${kind === "apphub" ? "/pub/apphub/" : ""}`;
}

function defaultTitleFor(installation, kind) {
  if (installation.type === "site") return installation.name;
  return kind === "apphub" ? `${installation.name} — Public` : installation.name;
}

/*
 * An installation is a site we know the shape of, so its tabs are kept inside
 * it and anything foreign goes to the real browser. A plain website entry is
 * the opposite case - the user added it precisely to browse it - so it may
 * navigate wherever its links lead.
 */
function belongsInside(tab, url) {
  if (tab.info.kind === "site") return /^https?:/i.test(url);
  return sameSite(url, tab.origin);
}

function createTab({ installationId, kind, parentId, url, id }) {
  const installation = installations.find((i) => i.id === installationId);
  if (!installation) throw new Error("Installation not found");

  const tabKind = installation.type === "site" ? "site" : kind || "desktop";
  const targetUrl = url || startUrlFor(installation, tabKind);
  const tabId = id || randomUUID();

  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  view.setBackgroundColor("#1e1f22");

  const info = {
    id: tabId,
    installationId,
    installationName: installation.name,
    kind: tabKind,
    parentId: parentId || null,
    title: defaultTitleFor(installation, tabKind),
    icon: installation.icon || null,
  };

  const wc = view.webContents;
  const tab = { view, info, origin: originOf(targetUrl), url: targetUrl, visible: false };

  // Anything outside the installation's own site belongs in the user's real
  // browser, not in a tab of this app.
  wc.setWindowOpenHandler(({ url: openUrl }) => {
    if (belongsInside(tab, openUrl)) {
      win.webContents.send("tab:new-child", { parentId: tabId, url: openUrl });
    } else {
      shell.openExternal(openUrl);
    }
    return { action: "deny" };
  });

  wc.on("will-navigate", (event, navUrl) => {
    if (!belongsInside(tab, navUrl)) {
      event.preventDefault();
      shell.openExternal(navUrl);
    }
  });

  // A server that answers on http and redirects to https moves the tab to a new
  // origin the moment it loads; follow it, so later clicks are still recognised
  // as belonging to this installation.
  wc.on("did-navigate", (_event, navUrl) => {
    tab.url = navUrl;
    if (belongsInside(tab, navUrl)) tab.origin = originOf(navUrl);
    upgradeInstallationAddress(tab, navUrl);
    persistSession();
  });

  wc.on("did-navigate-in-page", (_event, navUrl, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = navUrl;
    persistSession();
  });

  wc.on("page-title-updated", (_event, title) => {
    if (!title) return;
    info.title = title;
    win.webContents.send("tab:title", { tabId, title });
    persistSession();
  });

  wc.on("page-favicon-updated", (_event, urls) => {
    if (!urls || !urls.length) return;
    applyTabIcon(tabId, urls[0]);
  });

  wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is an aborted load, which every normal in-page navigation produces.
    if (!isMainFrame || errorCode === -3) return;
    win.webContents.send("tab:failed", { tabId, message: errorDescription || String(errorCode) });
  });

  wc.on("context-menu", () => tabContextMenu(tabId));

  tabs.set(tabId, tab);
  win.contentView.addChildView(view);
  view.setBounds(contentBounds());
  setViewVisible(tab, false);
  wc.loadURL(targetUrl);
  persistSession();
  return info;
}

/*
 * A saved http address whose server actually serves https is rewritten once the
 * redirect is seen, so the next visit does not start with a detour.
 */
function upgradeInstallationAddress(tab, navUrl) {
  if (tab.info.parentId || !/^https:/i.test(navUrl)) return;
  const installation = installations.find((i) => i.id === tab.info.installationId);
  if (!installation || !/^http:\/\//i.test(installation.address)) return;
  if (!sameSite(navUrl, installation.address)) return;
  installation.address = installation.address.replace(/^http:/i, "https:");
  store.save(installations);
  if (win && !win.isDestroyed()) {
    win.webContents.send("installation:address", { id: installation.id, address: installation.address });
  }
}

/*
 * The page's own icon is the best one there is, so it replaces whatever the
 * installation was added with - both in the tab row and, for a tab opened
 * straight from the sidebar, in the installation's stored icon.
 */
async function applyTabIcon(tabId, iconUrl) {
  const dataUrl = await favicon.fetchIcon(iconUrl);
  if (!dataUrl) return;
  const tab = tabs.get(tabId);
  if (!tab || !win || win.isDestroyed()) return;

  tab.info.icon = dataUrl;
  win.webContents.send("tab:icon", { tabId, icon: dataUrl });

  if (tab.info.parentId) return;
  const installation = installations.find((i) => i.id === tab.info.installationId);
  if (!installation || installation.icon === dataUrl) return;
  // A website tab that has browsed away carries a foreign icon by then, and the
  // sidebar entry should keep showing the site it was added for.
  if (!sameSite(tab.url, installation.address)) return;
  installation.icon = dataUrl;
  store.save(installations);
  win.webContents.send("installation:icon", { id: installation.id, icon: dataUrl });
}

/*
 * Installations added before icons existed - or whose site simply had none the
 * last time - get one looked up in the background, so the sidebar fills in on
 * its own instead of waiting for a tab to be opened.
 */
async function backfillIcons() {
  for (const installation of installations) {
    if (installation.icon) continue;
    const icon = await favicon.discover(installation.address);
    if (!icon) continue;
    installation.icon = icon;
    store.save(installations);
    if (win && !win.isDestroyed()) {
      win.webContents.send("installation:icon", { id: installation.id, icon });
    }
  }
}

/** Re-opens what was on screen when the app was last closed. */
function restoreSessionTabs() {
  const saved = Array.isArray(session.tabs) ? session.tabs : [];
  const opened = [];
  const idMap = new Map();

  for (const entry of saved) {
    if (!entry || !installations.some((i) => i.id === entry.installationId)) continue;
    // A child whose parent could not be restored is opened as a tab of its own
    // rather than dropped, so nothing the user had open silently disappears.
    const parentId = entry.parentId ? idMap.get(entry.parentId) || null : null;
    try {
      const info = createTab({
        installationId: entry.installationId,
        kind: entry.kind,
        parentId,
        url: entry.url,
      });
      if (entry.title) {
        info.title = entry.title;
        tabs.get(info.id).info.title = entry.title;
      }
      idMap.set(entry.id, info.id);
      opened.push(info);
    } catch {
      /* an installation that vanished between runs simply has no tab */
    }
  }

  const restoredActive = session.activeTabId ? idMap.get(session.activeTabId) : null;
  activeTabId = restoredActive || (opened.length ? opened[opened.length - 1].id : null);
  applyLayout();
  return { tabs: opened, activeTabId };
}

/* ----------------------------------------------------------------- badging */

/*
 * A tab whose page reports unread items puts the total on the app's own icon.
 * macOS and the Linux desktops that implement the Unity protocol take a plain
 * number; Windows wants a picture, which the chrome renderer draws for us,
 * since only it has a canvas to draw on.
 */
function applyBadge(count, overlayDataUrl) {
  if (!app.isReady()) return;
  if (process.platform === "win32") {
    if (!win || win.isDestroyed()) return;
    const image = count > 0 && overlayDataUrl ? nativeImage.createFromDataURL(overlayDataUrl) : null;
    win.setOverlayIcon(image, count > 0 ? `${count} unread` : "");
    return;
  }
  app.setBadgeCount(count > 0 ? count : 0);
}

/* ------------------------------------------------------------------ window */

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Add installation…", accelerator: "CmdOrCtrl+N", click: () => win.webContents.send("menu:add-installation") },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle sidebar",
          accelerator: "CmdOrCtrl+B",
          click: () => setSidebarVisible(!sidebarVisible),
        },
        {
          label: "Reload tab",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            const tab = activeTabId && tabs.get(activeTabId);
            if (tab) tab.view.webContents.reload();
          },
        },
        { type: "separator" },
        {
          label: "Developer tools",
          accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: () => {
            const tab = activeTabId && tabs.get(activeTabId);
            (tab ? tab.view.webContents : win.webContents).toggleDevTools();
          },
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      label: "Help",
      submenu: [
        { label: "Check for updates…", click: () => runUpdateCheck(true) },
        { label: "mvmOS website", click: () => shell.openExternal("https://mvmos.org") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/*
 * A saved position is only honoured while it still lands on a screen that
 * exists - otherwise a window remembered from a second monitor would open off
 * the edge of a laptop that no longer has one.
 */
function savedWindowBounds() {
  const bounds = session.bounds;
  if (!bounds || typeof bounds.width !== "number" || typeof bounds.height !== "number") return DEFAULT_BOUNDS;
  const size = {
    width: Math.max(bounds.width, 800),
    height: Math.max(bounds.height, 560),
  };
  if (typeof bounds.x !== "number" || typeof bounds.y !== "number") return size;
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return bounds.x < area.x + area.width
      && bounds.x + size.width > area.x
      && bounds.y < area.y + area.height
      && bounds.y + size.height > area.y;
  });
  return visible ? { ...size, x: bounds.x, y: bounds.y } : size;
}

function createWindow() {
  sessionFrozen = false;
  win = new BrowserWindow({
    ...savedWindowBounds(),
    minWidth: 800,
    minHeight: 560,
    title: "mvmOS Desktop",
    backgroundColor: "#1e1f22",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (session.maximized) win.maximize();
  sidebarVisible = session.sidebarVisible !== false;

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  // The sidebar may have been hidden when the app was last closed, and the
  // chrome starts out assuming it is visible.
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("sidebar:changed", sidebarVisible);
  });
  win.on("resize", applyLayout);
  win.on("resize", persistSession);
  win.on("move", persistSession);
  win.on("maximize", persistSession);
  win.on("unmaximize", persistSession);
  win.on("close", () => {
    persistSessionNow();
    sessionFrozen = true;
  });
  win.on("closed", () => {
    win = null;
    tabs.clear();
    activeTabId = null;
  });

  // The chrome itself never opens OS windows; a stray link goes to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Right-clicking the chrome is the way back when the sidebar is hidden and
  // no tab is open to right-click instead.
  win.webContents.on("context-menu", () => {
    Menu.buildFromTemplate([
      {
        label: sidebarVisible ? "Hide sidebar" : "Show sidebar",
        accelerator: "CmdOrCtrl+B",
        click: () => setSidebarVisible(!sidebarVisible),
      },
    ]).popup({ window: win });
  });
}

async function runUpdateCheck(fromMenu = false) {
  const update = await checkForUpdate(app.getVersion());
  if (!win || win.isDestroyed()) return;
  if (update) {
    win.webContents.send("update:available", update);
  } else if (fromMenu) {
    win.webContents.send("update:none", { version: app.getVersion() });
  }
}

/* --------------------------------------------------------------------- ipc */

ipcMain.handle("installations:list", () => installations);

ipcMain.handle("installations:add", async (_event, { name, address, type }) => {
  const normalized = normalizeAddress(address);
  if (!(await isReachable(normalized))) {
    throw new Error(`Could not reach "${normalized}". Check the address and make sure the server is running.`);
  }
  const finalAddress = await upgradeScheme(normalized);
  const installation = {
    id: randomUUID(),
    name: String(name || "").trim() || new URL(finalAddress).hostname,
    address: finalAddress,
    type: type === "site" ? "site" : "mvmos",
    icon: await favicon.discover(finalAddress),
  };
  installations.push(installation);
  store.save(installations);
  return installation;
});

ipcMain.handle("installations:update", async (_event, { id, name, address, type }) => {
  const installation = installations.find((i) => i.id === id);
  if (!installation) throw new Error("Installation not found");
  const normalized = normalizeAddress(address);
  const addressChanged = normalized !== installation.address;
  if (addressChanged && !(await isReachable(normalized))) {
    throw new Error(`Could not reach "${normalized}". Check the address and make sure the server is running.`);
  }
  const finalAddress = addressChanged ? await upgradeScheme(normalized) : installation.address;
  installation.name = String(name || "").trim() || new URL(finalAddress).hostname;
  installation.address = finalAddress;
  installation.type = type === "site" ? "site" : "mvmos";
  if (addressChanged) installation.icon = await favicon.discover(finalAddress);
  store.save(installations);
  // Open tabs still point at the old address, so they are closed rather than
  // left showing something that no longer matches what the sidebar says.
  if (addressChanged) {
    for (const [tabId, tab] of [...tabs]) {
      if (tab.info.installationId === id) closeTabTree(tabId);
    }
  }
  return { installation, tabsClosed: addressChanged };
});

ipcMain.handle("installations:remove", (_event, id) => {
  for (const [tabId, tab] of [...tabs]) {
    if (tab.info.installationId === id) closeTabTree(tabId);
  }
  installations = installations.filter((i) => i.id !== id);
  store.save(installations);
  return installations;
});

ipcMain.handle("installations:reorder", (_event, orderedIds) => {
  const byId = new Map(installations.map((i) => [i.id, i]));
  const reordered = [];
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (item) {
      reordered.push(item);
      byId.delete(id);
    }
  }
  // Anything the renderer did not mention keeps its relative order at the end.
  installations = [...reordered, ...byId.values()];
  store.save(installations);
  return installations;
});

ipcMain.handle("installations:reachable", (_event, address) => isReachable(address));

ipcMain.handle("tabs:open", (_event, payload) => createTab(payload));

ipcMain.handle("tabs:activate", (_event, tabId) => {
  if (!tabs.has(tabId)) throw new Error("Tab not found");
  activeTabId = tabId;
  applyLayout();
  persistSession();
});

ipcMain.handle("tabs:close", (_event, tabId) => {
  closeTabTree(tabId);
});

ipcMain.handle("session:restore", () => restoreSessionTabs());

ipcMain.handle("chrome:overlay", (_event, open) => {
  overlayOpen = Boolean(open);
  applyLayout();
});

ipcMain.handle("chrome:sidebar", (_event, visible) => setSidebarVisible(visible));

ipcMain.handle("chrome:badge", (_event, { count, overlay }) => applyBadge(Number(count) || 0, overlay));

ipcMain.handle("update:check", () => runUpdateCheck(true));

ipcMain.handle("shell:open-external", (_event, url) => shell.openExternal(url));

/* -------------------------------------------------------------------- boot */

app.whenReady().then(() => {
  installations = store.load();
  session = store.loadSession();
  sidebarVisible = session.sidebarVisible !== false;
  buildMenu();
  createWindow();

  // Late enough that neither the check nor the icon lookups delay the first
  // paint, early enough that the answer is there before the user has finished
  // looking around.
  setTimeout(() => runUpdateCheck(false), 4000);
  setTimeout(() => { void backfillIcons(); }, 1500);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", persistSessionNow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
