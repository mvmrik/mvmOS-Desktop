"use strict";

/*
 * Window layout.
 *
 * The window's own web contents render the chrome (sidebar plus the status
 * area next to it) across the whole window, and every open installation is a
 * `WebContentsView` laid on top of the right-hand part of it. Only the active
 * tab is attached, so switching tabs is an attach/detach rather than a
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
  shell,
} = require("electron");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const store = require("./store");
const { normalizeAddress, originOf, isReachable } = require("./net");

const SIDEBAR_WIDTH = 260;

let win = null;
let installations = [];

/** tabId -> { view, info, origin, attached } */
const tabs = new Map();
let activeTabId = null;
let sidebarVisible = true;
// Raised while the chrome shows a dialog of its own: the tab is detached so the
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
  if (win && !win.isDestroyed()) {
    win.webContents.send("sidebar:changed", sidebarVisible);
  }
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

function createTab({ installationId, kind, parentId, url }) {
  const installation = installations.find((i) => i.id === installationId);
  if (!installation) throw new Error("Installation not found");

  const targetUrl = url || `${installation.address}${kind === "apphub" ? "/pub/apphub/" : ""}`;
  const origin = originOf(targetUrl);
  const tabId = randomUUID();

  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  view.setBackgroundColor("#1e1f22");

  const info = {
    id: tabId,
    installationId,
    installationName: installation.name,
    kind,
    parentId: parentId || null,
    title: kind === "apphub" ? `${installation.name} — Public` : installation.name,
  };

  const wc = view.webContents;

  // Anything outside the installation's own origin belongs in the user's real
  // browser, not in a tab of this app.
  wc.setWindowOpenHandler(({ url: openUrl }) => {
    if (originOf(openUrl) === origin) {
      win.webContents.send("tab:new-child", { parentId: tabId, url: openUrl });
    } else {
      shell.openExternal(openUrl);
    }
    return { action: "deny" };
  });

  wc.on("will-navigate", (event, navUrl) => {
    if (originOf(navUrl) !== origin) {
      event.preventDefault();
      shell.openExternal(navUrl);
    }
  });

  wc.on("page-title-updated", (_event, title) => {
    if (!title) return;
    info.title = title;
    win.webContents.send("tab:title", { tabId, title });
  });

  wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is an aborted load, which every normal in-page navigation produces.
    if (!isMainFrame || errorCode === -3) return;
    win.webContents.send("tab:failed", { tabId, message: errorDescription || String(errorCode) });
  });

  wc.on("context-menu", () => tabContextMenu(tabId));

  const tab = { view, info, origin, visible: false };
  tabs.set(tabId, tab);
  win.contentView.addChildView(view);
  view.setBounds(contentBounds());
  setViewVisible(tab, false);
  wc.loadURL(targetUrl);
  return info;
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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
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

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.on("resize", applyLayout);
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

/* --------------------------------------------------------------------- ipc */

ipcMain.handle("installations:list", () => installations);

ipcMain.handle("installations:add", async (_event, { name, address }) => {
  const normalized = normalizeAddress(address);
  if (!(await isReachable(normalized))) {
    throw new Error(`Could not reach "${normalized}". Check the address and make sure the server is running.`);
  }
  const installation = {
    id: randomUUID(),
    name: String(name || "").trim() || normalized,
    address: normalized,
  };
  installations.push(installation);
  store.save(installations);
  return installation;
});

ipcMain.handle("installations:update", async (_event, { id, name, address }) => {
  const installation = installations.find((i) => i.id === id);
  if (!installation) throw new Error("Installation not found");
  const normalized = normalizeAddress(address);
  const addressChanged = normalized !== installation.address;
  if (addressChanged && !(await isReachable(normalized))) {
    throw new Error(`Could not reach "${normalized}". Check the address and make sure the server is running.`);
  }
  installation.name = String(name || "").trim() || normalized;
  installation.address = normalized;
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
});

ipcMain.handle("tabs:close", (_event, tabId) => {
  closeTabTree(tabId);
});

ipcMain.handle("chrome:overlay", (_event, open) => {
  overlayOpen = Boolean(open);
  applyLayout();
});

ipcMain.handle("chrome:sidebar", (_event, visible) => setSidebarVisible(visible));

ipcMain.handle("shell:open-external", (_event, url) => shell.openExternal(url));

/* -------------------------------------------------------------------- boot */

app.whenReady().then(() => {
  installations = store.load();
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
