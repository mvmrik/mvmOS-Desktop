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
  Tray,
  WebContentsView,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  session: electronSession,
  shell,
} = require("electron");
const path = require("node:path");
const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require("node:crypto");

const store = require("./store");
const favicon = require("./favicon");
const extensions = require("./extensions");
const cookies = require("./cookies");
const { checkForUpdate } = require("./update");
const { normalizeAddress, originOf, sameSite, isReachable, upgradeScheme } = require("./net");

const SIDEBAR_WIDTH = 260;
const DEFAULT_BOUNDS = { width: 1280, height: 800 };
const BASE_TITLE = "mvmOS Desktop";
// Loaded in the content area whenever no tab is active, in place of the old
// "select or open an installation" placeholder.
const HOME_URL = "https://mvmos.org";
// Packed with the app rather than looked up by name, so it is there whatever
// the platform's installer did or did not put in an icon theme. The tray gets
// the mark on its own: a status icon is drawn at about twenty pixels, and the
// wordmark under the mark is a smudge at that size - and the count is drawn
// over the bottom corner anyway.
const APP_ICON_PATH = path.join(__dirname, "..", "build", "tray.png");
// The popup an extension button opens, in device-independent pixels like every
// other bound here.
// A popup is measured by what it draws, and a page can only report a size at
// least as big as the view it is in - so it starts smaller than any real popup
// and is shown once it has grown into itself.
const POPUP_START = { width: 240, height: 120 };
const POPUP_DEFAULT = { width: 360, height: 480 };
const POPUP_MAX = { width: 800, height: 600 };

let win = null;
let installations = [];
let session = {};
let settings = { pin: null, extensions: [], showTray: true, closeToTray: false };
// Set the moment quitting begins, so the window's close handler can tell a real
// close from the one it turns into a hide; see createWindow().
let quitting = false;

/** tabId -> { view, info, origin, url, visible } */
const tabs = new Map();
/** tabId -> iconUrl most recently requested, so a slow reply can't overwrite a newer one */
const pendingIconUrl = new Map();
/** tabId -> Notifications the page raised since this tab was last looked at */
const tabUnread = new Map();
let activeTabId = null;
let sidebarVisible = true;
// Raised while the chrome shows a dialog of its own: the tab is hidden so the
// dialog is centred on the whole window instead of being clipped by the strip.
let overlayOpen = false;
// While locked nothing at all is shown: the tab views are hidden here and the
// chrome renderer covers the sidebar with the PIN prompt.
let locked = false;

/** The mvmos.org view shown in the content area while no tab is active. */
let homeView = null;
let homeVisible = false;

/** What the toolbar draws, refreshed whenever an extension loads or goes. */
let extensionActions = [];
/** The open popup: { id, view, anchor, shown } - at most one, as in a browser. */
let extensionPopup = null;

/* ------------------------------------------------------------------ layout */

function contentBounds() {
  const { width, height } = win.getContentBounds();
  // The extension buttons live in the sidebar, so the page still owns
  // everything to the right of it.
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
  // Anything that relays the views - a resize, a tab switch, the sidebar, the
  // lock - has moved the button the popup was pinned to, so it goes.
  closeExtensionPopup();
  const bounds = contentBounds();
  for (const [id, tab] of tabs) {
    const shouldShow = id === activeTabId && !overlayOpen && !locked;
    if (shouldShow) tab.view.setBounds(bounds);
    setViewVisible(tab, shouldShow);
  }
  if (homeView) {
    const shouldShowHome = homeVisible && !activeTabId && !overlayOpen && !locked;
    if (shouldShowHome) homeView.setBounds(bounds);
    if (typeof homeView.setVisible === "function") homeView.setVisible(shouldShowHome);
  }
  markActiveTabSeen();
}

/*
 * The active tab only counts as "seen" once it is both the one on screen and
 * the window has real focus - a tab switch made while the app sits unfocused
 * in the background should not silently clear the badge before the user has
 * actually looked at it.
 */
function markActiveTabSeen() {
  if (!activeTabId || !win || win.isDestroyed() || !win.isFocused()) return;
  if (overlayOpen || locked) return;
  if (!tabUnread.get(activeTabId)) return;
  tabUnread.set(activeTabId, 0);
  win.webContents.send("tab:unread", { tabId: activeTabId, count: 0 });
}

/*
 * Created the first time it is needed rather than eagerly, so an install that
 * never sees the empty state never opens a network connection for it either.
 */
function ensureHomeView() {
  if (homeView) return homeView;
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor("#1e1f22");
  const wc = view.webContents;
  wc.on("input-event", () => noteActivity());
  // Same rule a website tab follows: stay inside for the site's own pages,
  // send anything else to the user's real browser.
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, navUrl) => {
    if (!sameSite(navUrl, HOME_URL)) {
      event.preventDefault();
      shell.openExternal(navUrl);
    }
  });
  win.contentView.addChildView(view);
  if (typeof view.setVisible === "function") view.setVisible(false);
  wc.loadURL(HOME_URL);
  homeView = view;
  return view;
}

function setHomeVisible(visible) {
  homeVisible = Boolean(visible);
  if (homeVisible) ensureHomeView();
  applyLayout();
}

function setSidebarVisible(visible) {
  sidebarVisible = Boolean(visible);
  applyLayout();
  persistSession();
  if (win && !win.isDestroyed()) {
    win.webContents.send("sidebar:changed", sidebarVisible);
  }
}

/* ------------------------------------------------------- extension toolbar */

/*
 * Electron loads extensions but draws none of their UI, so the toolbar is the
 * chrome renderer's and the popup is a `WebContentsView` we put over the page
 * the way a browser hangs one under its button. Only one is ever open, it is
 * dismissed by anything that would take focus away, and it is sized by what
 * the page inside it reports.
 */

function popupHost() {
  return extensionPopup ? extensionPopup.view.webContents : null;
}

function closeExtensionPopup() {
  if (!extensionPopup) return;
  const { view, settle } = extensionPopup;
  extensionPopup = null;
  clearTimeout(settle);
  if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
  if (win && !win.isDestroyed()) win.webContents.send("extensions:popup-closed");
}

/*
 * The button is in the sidebar, so the popup opens beside it rather than under
 * it: level with the button, just past the sidebar's edge, over the page. That
 * keeps the tab list the user clicked from in view, and a popup taller than
 * the room below it is pulled up rather than cut off. Anchor is the button's
 * rectangle in the renderer's own coordinates, which are the window's content
 * coordinates too.
 */
function placeExtensionPopup(anchor, size) {
  if (!win || win.isDestroyed() || !extensionPopup) return;
  const content = win.getContentBounds();
  const left = (sidebarVisible ? SIDEBAR_WIDTH : 0) + 4;
  const available = Math.max(content.width - left - 8, 160);
  const width = Math.min(Math.max(Math.round(size.width), 160), POPUP_MAX.width, available);
  const height = Math.min(Math.max(Math.round(size.height), 80), POPUP_MAX.height, Math.max(content.height - 16, 80));
  const x = Math.max(left, Math.min(anchor.x + anchor.width + 4, content.width - width - 8));
  const y = Math.max(8, Math.min(anchor.y, content.height - height - 8));
  extensionPopup.view.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
}

/** First measurement in, or none coming: put it where it belongs and show it. */
function revealExtensionPopup(size) {
  if (!extensionPopup || extensionPopup.shown) return;
  extensionPopup.shown = true;
  placeExtensionPopup(extensionPopup.anchor, size);
  const { view } = extensionPopup;
  if (typeof view.setVisible === "function") view.setVisible(true);
  view.webContents.focus();
  // Whatever the popup drew while it was hidden has not been measured yet.
  const remeasure = () => {
    if (!view.webContents.isDestroyed()) view.webContents.send("extension-popup:measure");
  };
  remeasure();
  setTimeout(remeasure, 400);
}

function openExtensionPopup(id, anchor) {
  const action = extensionActions.find((item) => item.id === id);
  closeExtensionPopup();
  if (!action || !action.popupUrl || !win || win.isDestroyed()) return false;

  const view = new WebContentsView({
    webPreferences: {
      session: electronSession.defaultSession,
      // The popup is an extension page, so it needs the extension world rather
      // than an isolated one; the preload only corrects what Electron gets
      // wrong about tabs and reports the size back.
      preload: path.join(__dirname, "extension-popup-preload.js"),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor("#ffffff");
  extensionPopup = { id, view, anchor, shown: false };
  win.contentView.addChildView(view);
  if (typeof view.setVisible === "function") view.setVisible(false);
  placeExtensionPopup(anchor, POPUP_START);
  // The popup's first act is usually to ask its background worker something,
  // and a stopped worker never answers.
  extensions.wake(electronSession.defaultSession);
  view.webContents.loadURL(action.popupUrl);

  // An extension page that never reports - one that fails to load, or whose
  // popup is an empty shell - still has to appear, or the click did nothing.
  const fallback = setTimeout(() => revealExtensionPopup(POPUP_DEFAULT), 700);
  view.webContents.once("destroyed", () => clearTimeout(fallback));
  extensionPopup.settle = fallback;

  // Clicking the page, the sidebar or another window is how a popup is
  // dismissed everywhere else.
  view.webContents.on("blur", () => {
    if (extensionPopup && extensionPopup.view === view) closeExtensionPopup();
  });
  // Links out of a popup ("open my vault") belong in a real window - the
  // extension's own pages in one of ours, everything else in the browser.
  view.webContents.setWindowOpenHandler(({ url }) => {
    const title = action.name;
    closeExtensionPopup();
    if (url.startsWith("chrome-extension://")) openExtensionPage(url, title);
    else shell.openExternal(url);
    return { action: "deny" };
  });
  return true;
}

/*
 * The options page is a normal extension page, so it can simply be a tab -
 * which is where an extension's own settings belong anyway.
 */
function optionsUrlOf(id) {
  const extension = electronSession.defaultSession.extensions
    .getAllExtensions()
    .find((item) => item.id === id);
  if (!extension) return null;
  const manifest = extension.manifest || {};
  const page = manifest.options_page || (manifest.options_ui && manifest.options_ui.page);
  return page ? new URL(page, extension.url).href : null;
}

/*
 * An options page is a whole page of its own and belongs to no installation,
 * so it gets a plain window rather than a tab in the sidebar's tree.
 */
function openExtensionPage(url, title) {
  const page = new BrowserWindow({
    width: 900,
    height: 700,
    parent: win || undefined,
    title,
    backgroundColor: "#ffffff",
    webPreferences: { session: electronSession.defaultSession, backgroundThrottling: false },
  });
  page.setMenuBarVisibility(false);
  page.loadURL(url);
  return page;
}

/*
 * Two of the ways a browser opens an extension's popup are missing here: the
 * icon an extension draws on a login field, which asks for the popup through
 * `chrome.action.openPopup()`, and the keyboard shortcut it declares through
 * `chrome.commands`. Electron implements neither, and both calls are made
 * where we cannot reach them, so the app opens the popup itself instead.
 *
 * Which extension's popup, when the page did not say: the one with a content
 * script on this page, since that is the only kind that can have drawn an icon
 * on it. With a single extension loaded the question does not arise, and with
 * several that all inject here there is nothing left to go on.
 */
function extensionForPage(url) {
  const withPopup = extensionActions.filter((item) => item.popupUrl);
  if (withPopup.length < 2) return withPopup[0] || null;
  return withPopup.find((item) => extensions.injectsInto(item.id, url)) || withPopup[0];
}

/*
 * The icon's rectangle arrives in the page's own coordinates; the popup is
 * placed in the window's, which the page is inset into and may be zoomed
 * against. Without a rectangle - the click came from an iframe - the popup
 * opens at the top of the page, the way the shortcut opens it.
 */
function fieldAnchor(tab, rect) {
  const content = contentBounds();
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    return { x: content.x - 4, y: 8, width: 0, height: 0 };
  }
  const zoom = tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents.zoomFactor || 1 : 1;
  return {
    x: content.x + rect.x * zoom,
    y: content.y + rect.y * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom,
  };
}

function openPopupForActiveTab(rect) {
  if (locked) return false;
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  const action = extensionForPage(tab ? tab.url : "");
  if (!action) return false;
  // A second press on the same icon closes it again, like the toolbar button.
  if (extensionPopup && extensionPopup.id === action.id) {
    closeExtensionPopup();
    return true;
  }
  return openExtensionPopup(action.id, fieldAnchor(tab, rect));
}

/*
 * Content scripts are injected as a page loads, so an extension added while
 * tabs are open does nothing in them until they come round again.
 */
function reloadTabsForExtensions() {
  for (const tab of tabs.values()) {
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
  }
}

let wakeTimer = null;

/*
 * Chromium idles a background worker out after about half a minute, and
 * nothing here starts it again on demand - so it is kept up while extensions
 * are loaded, and left alone entirely when none are.
 */
function keepExtensionWorkersAwake() {
  if (wakeTimer) clearInterval(wakeTimer);
  wakeTimer = null;
  if (!settings.extensions.length) return;
  extensions.wake(electronSession.defaultSession);
  wakeTimer = setInterval(() => extensions.wake(electronSession.defaultSession), 20000);
}

function refreshExtensionActions() {
  extensionActions = extensions.actions(settings.extensions);
  keepExtensionWorkersAwake();
  if (extensionPopup && !extensionActions.some((item) => item.id === extensionPopup.id)) {
    closeExtensionPopup();
  }
  if (win && !win.isDestroyed()) win.webContents.send("extensions:actions", extensionActions);
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
  pendingIconUrl.delete(tabId);
  tabUnread.delete(tabId);
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
  const installation = installations.find((i) => i.id === tab.info.installationId);
  Menu.buildFromTemplate([
    { label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: "Reload", click: () => wc.reload() },
    // A page that navigates deep with no way back (an internal page with its own
    // "back" disabled, an OAuth detour) still has an installation address it was
    // opened with - this is a way back to it regardless of where the tab ended up.
    {
      label: "Home",
      enabled: Boolean(installation),
      click: () => { if (installation) wc.loadURL(startUrlFor(installation, tab.info.kind)); },
    },
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

const HOUR_MS = 60 * 60000;

function isMuted(installation) {
  if (!installation) return false;
  const until = installation.muteUntil;
  if (until === "forever") return true;
  return typeof until === "number" && Date.now() < until;
}

/*
 * `duration` is a number of ms, the string "forever", or null to unmute.
 * Persisted on the installation itself, so it survives closing the tab and
 * restarting the app - the whole point of the longer durations.
 */
function setMute(installationId, duration) {
  const installation = installations.find((i) => i.id === installationId);
  if (!installation) return;
  if (duration === null) delete installation.muteUntil;
  else if (duration === "forever") installation.muteUntil = "forever";
  else installation.muteUntil = Date.now() + duration;
  store.save(installations);
  if (win && !win.isDestroyed()) {
    win.webContents.send("installation:mute", { id: installationId, muteUntil: installation.muteUntil || null });
  }
}

// A timed mute that has run out is worth exactly as much as no mute at all,
// but nothing else touches it again until the next badge-affecting event, so
// it would otherwise stay silenced until the page happens to update its title.
function sweepExpiredMutes() {
  const now = Date.now();
  let changed = false;
  for (const installation of installations) {
    if (typeof installation.muteUntil !== "number" || installation.muteUntil > now) continue;
    delete installation.muteUntil;
    changed = true;
    if (win && !win.isDestroyed()) {
      win.webContents.send("installation:mute", { id: installation.id, muteUntil: null });
    }
  }
  if (changed) store.save(installations);
}

/*
 * Right-clicking a row in the sidebar - an open tab, or a website that may not
 * be open at all - rather than the page content itself, which is what
 * tabContextMenu() above is for.
 */
function showRowContextMenu({ installationId, tabId }) {
  const installation = installations.find((i) => i.id === installationId);
  if (!installation) return;
  const tab = tabId ? tabs.get(tabId) : null;
  const muted = isMuted(installation);

  const muteFor = (label, duration) => ({ label, click: () => setMute(installationId, duration) });

  const muteSubmenu = [];
  if (muted) {
    muteSubmenu.push({ label: "Unmute", click: () => setMute(installationId, null) }, { type: "separator" });
  }
  muteSubmenu.push(
    muteFor("For 1 hour", HOUR_MS),
    muteFor("For 3 hours", 3 * HOUR_MS),
    muteFor("For 6 hours", 6 * HOUR_MS),
    muteFor("For 12 hours", 12 * HOUR_MS),
    muteFor("For 24 hours", 24 * HOUR_MS),
    { label: "Forever", click: () => setMute(installationId, "forever") },
  );

  Menu.buildFromTemplate([
    { label: muted ? "Muted" : "Mute", submenu: muteSubmenu },
    {
      label: "Reload",
      enabled: Boolean(tab),
      click: () => {
        if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
      },
    },
    {
      label: "Home",
      enabled: Boolean(tab),
      click: () => {
        if (tab && !tab.view.webContents.isDestroyed()) {
          tab.view.webContents.loadURL(startUrlFor(installation, tab.info.kind));
        }
      },
    },
    { type: "separator" },
    {
      label: sidebarVisible ? "Hide sidebar" : "Show sidebar",
      accelerator: "CmdOrCtrl+B",
      click: () => setSidebarVisible(!sidebarVisible),
    },
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
function installationIdForWebContents(wc) {
  for (const tab of tabs.values()) {
    if (tab.view.webContents === wc) return tab.info.installationId;
  }
  return null;
}

function tabIdForWebContents(wc) {
  for (const [tabId, tab] of tabs) {
    if (tab.view.webContents === wc) return tabId;
  }
  return null;
}

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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Watches for a click on an icon an extension drew on a login field:
      // the extension cannot open its own popup here, so we do it for it.
      preload: path.join(__dirname, "tab-preload.js"),
      // A hidden tab is still a live page: a chat that is not on screen has to
      // keep its socket open, or its notification arrives whenever the user
      // happens to look at it rather than when it was sent.
      backgroundThrottling: false,
    },
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
  wc.on("input-event", () => noteActivity());

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
  // page-favicon-updated fires because the page's own favicon changed - a site
  // that flips a notification badge often does so at the very same URL, so the
  // in-memory cache in favicon.js (meant for the one-off discover() lookups)
  // has to be skipped here or the badge would never show up.
  pendingIconUrl.set(tabId, iconUrl);
  const dataUrl = await favicon.fetchIcon(iconUrl, { bypassCache: true });
  // A site that flips its favicon back and forth (blinking a notification
  // badge) can fire this twice before the first fetch returns; if a newer
  // request has since been made for this tab, this reply is stale - applying
  // it would flash the icon back to an outdated state.
  if (pendingIconUrl.get(tabId) !== iconUrl) return;
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

let lastBadgeCount = 0;
// Kept so a tray icon that appears mid-session - the setting switched on, or
// the icon image only reaching the renderer later - can be given the count that
// is already showing everywhere else.
let lastTrayIcon = null;

/*
 * A tab whose page reports unread items puts the total on the app's own icon.
 * macOS and the Linux desktops that implement the Unity protocol take a plain
 * number; Windows wants a picture, which the chrome renderer draws for us,
 * since only it has a canvas to draw on.
 *
 * Not every Linux panel implements the Unity protocol, and the ones that do
 * only look up the badge by the .desktop file the app was launched from - so a
 * build started from a terminal has no icon to draw on at all. Two things work
 * everywhere instead, and both are done alongside the badge: the count goes in
 * front of the window title, which every task list shows, and the taskbar entry
 * is flashed when the count goes up while the window is not the one in front.
 */
function applyBadge(count, overlayDataUrl, trayDataUrl) {
  if (!app.isReady()) return;
  const total = count > 0 ? count : 0;

  if (process.platform === "win32" && win && !win.isDestroyed()) {
    const image = total > 0 && overlayDataUrl ? nativeImage.createFromDataURL(overlayDataUrl) : null;
    win.setOverlayIcon(image, total > 0 ? `${total} unread` : "");
  } else {
    app.setBadgeCount(total);
  }
  lastTrayIcon = total > 0 ? trayDataUrl || null : null;
  applyTrayBadge(total, lastTrayIcon);

  if (win && !win.isDestroyed()) {
    win.setTitle(total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE);
    if (total > lastBadgeCount && !win.isFocused()) win.flashFrame(true);
    // Read somewhere else - on a phone, in another browser - while the window
    // was never looked at: there is nothing left to point the user at.
    if (total === 0) win.flashFrame(false);
  }
  lastBadgeCount = total;
  scheduleBadgeReassert(total);
}

/*
 * The Unity protocol is a broadcast with no state behind it: the panel keeps
 * what it last heard, and anything that rebuilds its task model - the panel
 * restarting, the window being remapped, the entry being matched to a launcher
 * only after the fact - leaves it with nothing, while we sit there believing
 * we have already said it. The count then quietly falls off the icon although
 * the title still carries it.
 *
 * So on Linux, while there is a count to show, it is said again every so often
 * and whenever the window itself is mapped anew. Saying it twice costs a signal
 * nobody reads; saying it once costs the badge. The macOS dock tile and the
 * Windows taskbar overlay are both properties that stay set until they are
 * changed, so there is nothing to repeat there.
 */
let badgeTimer = null;

/*
 * The highlight stays lit until the window is looked at, rather than fading on
 * its own after a while. It is the only part of "something arrived" that can be
 * relied on to appear: the count is a request the launcher may refuse, so a
 * highlight that had already faded would leave an unread message showing
 * nowhere but in the window title.
 *
 * Which colour it is drawn in is the window manager's to choose - flashFrame
 * only raises the window's urgency flag, and every desktop paints that its own
 * way - and so is when it goes out, since some of them clear it on focus and
 * on nothing else.
 */
function scheduleBadgeReassert(total) {
  if (badgeTimer) clearInterval(badgeTimer);
  badgeTimer = null;
  if (process.platform !== "linux" || total <= 0) return;
  badgeTimer = setInterval(() => reassertBadge(), 15000);
}

function reassertBadge() {
  if (process.platform !== "linux") return;
  if (lastBadgeCount <= 0 || !app.isReady()) return;
  app.setBadgeCount(lastBadgeCount);
}

/* ------------------------------------------------------------------- tray */

/*
 * The count on the app's own icon is the launcher's to draw, and on Linux that
 * is a request rather than an instruction: the number is broadcast over the
 * Unity protocol and a panel is free to ignore it. Several do - the signal
 * goes out with the right name and the right number and simply lands nowhere,
 * which leaves an unread message visible in the window title and nowhere else.
 *
 * A status icon is the one place the app draws the pixels itself. It is asked
 * for, not matched by name against a desktop entry, so what it shows is what
 * the app put there.
 *
 * Linux and Windows get one, and it can be turned off. macOS gets none at all:
 * a status item there sits in the menu bar with no badge of its own, while the
 * dock icon it would duplicate already carries the count - and closing a window
 * on macOS leaves the app running anyway, which is the whole of what a tray is
 * wanted for on the other two.
 */
let tray = null;
let trayBaseIcon = null;

function baseTrayIcon() {
  if (!trayBaseIcon) {
    const icon = nativeImage.createFromPath(APP_ICON_PATH);
    trayBaseIcon = icon.isEmpty() ? null : icon.resize({ width: 64, height: 64 });
  }
  return trayBaseIcon;
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayPlatform() {
  return process.platform === "linux" || process.platform === "win32";
}

/** True while the icon exists and can be relied on to bring the window back. */
function trayLive() {
  return Boolean(tray) && !tray.isDestroyed();
}

/* Brings the icon in line with the setting, either way, and puts the count back
   on it: an icon created mid-session has missed everything said so far. */
function syncTray() {
  if (trayPlatform() && settings.showTray) {
    createTray();
  } else if (trayLive()) {
    tray.destroy();
    tray = null;
  }
  applyTrayBadge(lastBadgeCount, lastTrayIcon);
}

function createTray() {
  if (!trayPlatform() || trayLive()) return;
  const icon = baseTrayIcon();
  if (!icon) return;
  tray = new Tray(icon);
  tray.setToolTip(BASE_TITLE);
  // An indicator has no click of its own on most panels - the menu is all of
  // it - so what the click does is in the menu as well.
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Show ${BASE_TITLE}`, click: () => showWindow() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );
  tray.on("click", () => showWindow());
}

/* The icon with the count drawn into it, or the plain one when there is none. */
function applyTrayBadge(total, trayDataUrl) {
  if (!trayLive()) return;
  const image = total > 0 && trayDataUrl ? nativeImage.createFromDataURL(trayDataUrl) : baseTrayIcon();
  if (image && !image.isEmpty()) tray.setImage(image);
  tray.setToolTip(total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE);
}

/* -------------------------------------------------------------- fullscreen */

// Restored when full screen is left again, so a window that was maximised when
// F11 was pressed does not come back as a small floating one.
let wasMaximizedBeforeFullScreen = false;

/*
 * GTK reports the new size late - and, for a window that was maximised when it
 * was fullscreened, sometimes not at all - which leaves the page drawn at its
 * old size in the corner of an otherwise black screen. Asking for the size of
 * the display the window is on, and pushing it onto the window when the two
 * disagree, is what makes F11 land on Linux.
 */
function syncFullScreenSize() {
  if (!win || win.isDestroyed()) return;
  applyLayout();
  if (process.platform !== "linux" || !win.isFullScreen()) return;
  const target = screen.getDisplayMatching(win.getBounds()).bounds;
  const content = win.getContentBounds();
  if (content.width !== target.width || content.height !== target.height) {
    win.setBounds(target);
  }
}

function toggleFullScreen() {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen()) {
    win.setFullScreen(false);
    if (wasMaximizedBeforeFullScreen) win.maximize();
    wasMaximizedBeforeFullScreen = false;
    return;
  }
  wasMaximizedBeforeFullScreen = win.isMaximized();
  // A maximised GTK window fullscreened in place keeps the maximised geometry;
  // dropping out of maximised first is what lets the WM resize it properly.
  if (wasMaximizedBeforeFullScreen) {
    win.unmaximize();
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.setFullScreen(true);
    }, 30);
    return;
  }
  win.setFullScreen(true);
}

/* -------------------------------------------------------------------- lock */

function hashPin(pin, salt) {
  return scryptSync(String(pin), salt, 32).toString("hex");
}

function pinMatches(pin) {
  if (!settings.pin) return true;
  const expected = Buffer.from(settings.pin.hash, "hex");
  const actual = Buffer.from(hashPin(pin, settings.pin.salt), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function setLocked(value) {
  locked = Boolean(value) && Boolean(settings.pin);
  applyLayout();
  if (win && !win.isDestroyed()) win.webContents.send("lock:changed", locked);
  if (locked) {
    stopAutoLockTimer();
    autoLockDeadline = null;
    sendLockDeadline();
  } else {
    startAutoLockCountdown();
  }
}

/* -------------------------------------------------------------- auto-lock */

// null while there is nothing counting down; otherwise the epoch ms it fires.
let autoLockDeadline = null;
let autoLockTimer = null;
// Real activity comes in bursts of many events at once; only the first one in
// a burst has to move the deadline.
let lastActivityNote = 0;

function autoLockEnabled() {
  return Boolean(settings.pin) && Number(settings.lockTimeoutMinutes) > 0;
}

function sendLockDeadline() {
  if (win && !win.isDestroyed()) win.webContents.send("lock:deadline", autoLockDeadline);
}

function stopAutoLockTimer() {
  if (autoLockTimer) clearInterval(autoLockTimer);
  autoLockTimer = null;
}

function checkAutoLock() {
  if (autoLockDeadline && Date.now() >= autoLockDeadline) setLocked(true);
}

/*
 * Called on unlock and whenever the PIN or the timeout settings change while
 * unlocked: whatever was counting down no longer applies, so it starts over
 * from whatever the current settings say - which may be "not at all".
 */
function startAutoLockCountdown() {
  stopAutoLockTimer();
  if (!autoLockEnabled() || locked) {
    autoLockDeadline = null;
    sendLockDeadline();
    return;
  }
  // -1000ms so the displayed countdown never touches the round minute the
  // user picked - without it, IPC/render latency made it flicker between
  // e.g. "30m" and "29m" on every activity reset.
  autoLockDeadline = Date.now() + settings.lockTimeoutMinutes * 60000 - 1000;
  sendLockDeadline();
  autoLockTimer = setInterval(checkAutoLock, 1000);
}

/*
 * Real input to the chrome window, a tab, or the home page - not merely the
 * app being open, which is the distinction the user asked for. Silently does
 * nothing unless reset-on-activity is actually on, so it is safe to call from
 * every input source without checking the setting at each call site.
 */
function noteActivity() {
  if (!autoLockEnabled() || locked || !settings.lockResetOnActivity) return;
  const now = Date.now();
  if (now - lastActivityNote < 2000) return;
  lastActivityNote = now;
  autoLockDeadline = now + settings.lockTimeoutMinutes * 60000 - 1000;
  sendLockDeadline();
}

/* ------------------------------------------------------------------ window */

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Add mvmOS installation…", accelerator: "CmdOrCtrl+N", click: () => win.webContents.send("menu:add-installation") },
        { label: "Add Website…", accelerator: "CmdOrCtrl+Shift+N", click: () => win.webContents.send("menu:add-website") },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => win.webContents.send("menu:settings") },
        {
          label: "Lock now",
          accelerator: "CmdOrCtrl+L",
          click: () => {
            if (settings.pin) setLocked(true);
            else win.webContents.send("menu:settings");
          },
        },
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
        {
          // The shortcut extensions ask for through chrome.commands, which
          // Electron does not implement; see openPopupForActiveTab().
          label: "Extension popup",
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => openPopupForActiveTab(null),
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
        {
          // Not role: "togglefullscreen" - entering full screen needs a little
          // help on Linux, see toggleFullScreen().
          label: "Toggle full screen",
          accelerator: isMac ? "Ctrl+Cmd+F" : "F11",
          click: () => toggleFullScreen(),
        },
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
    win.webContents.send("extensions:actions", extensionActions);
  });
  // The chrome page has a fixed title; the badge count is what changes it, so
  // the page is not allowed to overwrite it back.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.setTitle(BASE_TITLE);

  win.on("resize", applyLayout);
  win.on("resize", persistSession);
  win.on("move", persistSession);
  win.on("enter-full-screen", () => {
    syncFullScreenSize();
    setTimeout(syncFullScreenSize, 150);
  });
  win.on("leave-full-screen", () => {
    applyLayout();
    setTimeout(applyLayout, 150);
  });
  win.on("focus", () => {
    win.flashFrame(false);
    noteActivity();
    markActiveTabSeen();
  });
  win.webContents.on("input-event", () => noteActivity());
  // A window that is mapped again arrives in the task list as a new entry, so
  // whatever count it carried has to be said over; see reassertBadge().
  win.on("show", () => reassertBadge());
  win.on("restore", () => reassertBadge());
  win.on("maximize", persistSession);
  win.on("unmaximize", persistSession);
  win.on("close", (event) => {
    /*
     * Closing into the tray is only allowed while there is an icon to close
     * into: with the setting on but the icon missing - a desktop with no status
     * area, an image that would not load - hiding the window would leave the
     * app running with no way back to it. Quitting comes through here as well,
     * hence the flag: that close is the real one.
     */
    if (!quitting && settings.closeToTray && trayLive()) {
      event.preventDefault();
      persistSessionNow();
      win.hide();
      return;
    }
    persistSessionNow();
    sessionFrozen = true;
  });
  win.on("closed", () => {
    extensionPopup = null;
    win = null;
    tabs.clear();
    activeTabId = null;
    homeView = null;
    homeVisible = false;
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

/*
 * The sidebar owns the order tabs are shown in; the map here owns the order
 * they are written to the session file in, so the two have to be told to agree
 * whenever the user moves one.
 */
ipcMain.handle("tabs:reorder", (_event, orderedIds) => {
  const remaining = new Map(tabs);
  const reordered = [];
  for (const id of orderedIds) {
    if (!remaining.has(id)) continue;
    reordered.push([id, remaining.get(id)]);
    remaining.delete(id);
  }
  tabs.clear();
  for (const [id, tab] of [...reordered, ...remaining]) tabs.set(id, tab);
  persistSession();
});

ipcMain.handle("tabs:context-menu", (_event, { installationId, tabId }) => {
  showRowContextMenu({ installationId, tabId });
});

ipcMain.handle("session:restore", () => restoreSessionTabs());

ipcMain.handle("chrome:overlay", (_event, open) => {
  overlayOpen = Boolean(open);
  applyLayout();
});

ipcMain.handle("chrome:sidebar", (_event, visible) => setSidebarVisible(visible));

ipcMain.handle("home:show", () => setHomeVisible(true));
ipcMain.handle("home:hide", () => setHomeVisible(false));

ipcMain.handle("chrome:badge", (_event, { count, overlay, trayIcon }) =>
  applyBadge(Number(count) || 0, overlay, trayIcon)
);
// The chrome renderer draws the count into the icon and needs the icon itself
// to draw on; the main process is the only side that can read it off disk.
ipcMain.handle("chrome:app-icon", () => {
  const icon = baseTrayIcon();
  return icon ? icon.toDataURL() : null;
});

ipcMain.handle("update:check", () => runUpdateCheck(true));

/* ----------------------------------------------------------- ipc: settings */

/*
 * What the settings dialog draws: `supported` is false on macOS, where there is
 * nothing to offer - the dock keeps the app and its badge after the window is
 * closed, which is what the other two need a tray for.
 */
ipcMain.handle("tray:state", () => ({
  supported: trayPlatform(),
  showTray: settings.showTray,
  closeToTray: settings.closeToTray,
}));

ipcMain.handle("tray:set", (_event, { showTray, closeToTray }) => {
  settings.showTray = showTray !== false;
  // Without an icon there is nowhere for a closed window to go, so the two are
  // saved as a pair rather than left to contradict each other.
  settings.closeToTray = settings.showTray && closeToTray === true;
  store.saveSettings(settings);
  syncTray();
  return { supported: trayPlatform(), showTray: settings.showTray, closeToTray: settings.closeToTray };
});

ipcMain.handle("lock:state", () => ({
  locked,
  hasPin: Boolean(settings.pin),
  lockTimeoutMinutes: settings.lockTimeoutMinutes,
  lockResetOnActivity: settings.lockResetOnActivity,
  deadline: autoLockDeadline,
}));

ipcMain.handle("lock:set-timeout", (_event, { minutes, resetOnActivity }) => {
  const parsed = Math.round(Number(minutes));
  settings.lockTimeoutMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  settings.lockResetOnActivity = resetOnActivity !== false;
  store.saveSettings(settings);
  if (!locked) startAutoLockCountdown();
  return { lockTimeoutMinutes: settings.lockTimeoutMinutes, lockResetOnActivity: settings.lockResetOnActivity };
});

ipcMain.handle("lock:unlock", (_event, pin) => {
  if (!settings.pin) {
    setLocked(false);
    return true;
  }
  if (!pinMatches(pin)) return false;
  setLocked(false);
  return true;
});

ipcMain.handle("lock:lock", () => setLocked(true));

ipcMain.handle("pin:set", (_event, { currentPin, pin }) => {
  if (settings.pin && !pinMatches(currentPin)) throw new Error("The current PIN is not correct.");
  const digits = String(pin || "").trim();
  if (!/^\d{4,12}$/.test(digits)) throw new Error("A PIN is 4 to 12 digits.");
  const salt = randomBytes(16).toString("hex");
  settings.pin = { salt, hash: hashPin(digits, salt) };
  store.saveSettings(settings);
  if (!locked) startAutoLockCountdown();
  return { hasPin: true };
});

ipcMain.handle("pin:clear", (_event, currentPin) => {
  if (settings.pin && !pinMatches(currentPin)) throw new Error("The current PIN is not correct.");
  settings.pin = null;
  store.saveSettings(settings);
  setLocked(false);
  return { hasPin: false };
});

function extensionList() {
  return extensions.list(settings.extensions, app.getPath("userData"));
}

ipcMain.handle("extensions:list", () => extensionList());

/*
 * An extension already on disk can be pointed at directly; a download is
 * unpacked into the user data directory first, because Chromium loads folders
 * and nothing else.
 */
ipcMain.handle("extensions:add", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Add a Chrome extension",
    message: "Pick an unpacked extension folder, or a .zip / .crx you downloaded.",
    properties: process.platform === "darwin" ? ["openDirectory", "openFile"] : ["openFile"],
    filters: [{ name: "Extension archive", extensions: ["zip", "crx"] }, { name: "All files", extensions: ["*"] }],
    buttonLabel: "Add",
  });
  if (result.canceled || !result.filePaths.length) return { list: extensionList() };

  let dir;
  try {
    dir = extensions.install(result.filePaths[0], app.getPath("userData"));
  } catch (error) {
    return { list: extensionList(), message: error.message };
  }

  if (!settings.extensions.includes(dir)) {
    const loadResult = await extensions.loadOne(electronSession.defaultSession, dir);
    settings.extensions.push(dir);
    store.saveSettings(settings);
    refreshExtensionActions();
    if (!loadResult.ok) return { list: extensionList(), message: loadResult.message };
    // Content scripts only reach pages loaded after the extension was; without
    // this the user has to reload every open tab by hand to see it work.
    reloadTabsForExtensions();
  }
  return { list: extensionList() };
});

/*
 * The folder dialog is a separate button on Linux and Windows: GTK and the
 * Windows common dialog each pick one mode, so asking for both in one dialog
 * silently drops the other.
 */
ipcMain.handle("extensions:add-folder", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Choose an unpacked extension folder",
    message: "Pick the folder that contains the extension's manifest.json.",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return { list: extensionList() };
  const dir = result.filePaths[0];
  if (!settings.extensions.includes(dir)) {
    const loadResult = await extensions.loadOne(electronSession.defaultSession, dir);
    settings.extensions.push(dir);
    store.saveSettings(settings);
    refreshExtensionActions();
    if (!loadResult.ok) return { list: extensionList(), message: loadResult.message };
    reloadTabsForExtensions();
  }
  return { list: extensionList() };
});

ipcMain.handle("extensions:remove", (_event, dir) => {
  extensions.unload(electronSession.defaultSession, dir);
  settings.extensions = settings.extensions.filter((p) => p !== dir);
  store.saveSettings(settings);
  // Only folders we unpacked ourselves are ours to delete; one the user picked
  // stays exactly where they put it.
  extensions.forget(dir, app.getPath("userData"));
  refreshExtensionActions();
  return { list: extensionList() };
});

/* -------------------------------------------------- ipc: extension toolbar */

ipcMain.handle("extensions:actions", () => extensionActions);

ipcMain.handle("extensions:popup", (_event, { id, anchor, toggle }) => {
  if (locked) return false;
  const same = extensionPopup && extensionPopup.id === id;
  if (same && toggle !== false) {
    closeExtensionPopup();
    return false;
  }
  const action = extensionActions.find((item) => item.id === id);
  if (action && action.popupUrl) return openExtensionPopup(id, anchor);

  // No popup declared: the options page is the only thing left worth opening,
  // and an extension with neither is one whose button is a status light.
  const options = optionsUrlOf(id);
  if (options) {
    openExtensionPage(options, action ? action.name : "Extension");
    return true;
  }
  return false;
});

ipcMain.handle("extensions:popup-close", () => closeExtensionPopup());

/* A login field's own icon was clicked, in whichever page the user is on. */
ipcMain.on("tab:extension-icon", (event, rect) => {
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  if (!tab || tab.view.webContents !== event.sender) return;
  openPopupForActiveTab(rect);
});

/*
 * A tab's page raised a browser Notification - see tab-preload.js. Counted
 * only while that tab is not the one actually being looked at, so switching
 * to it clears the count instead of racing a notification that arrives at
 * the same moment.
 */
ipcMain.on("tab:notification", (event) => {
  const tabId = tabIdForWebContents(event.sender);
  if (!tabId) return;
  const seen = tabId === activeTabId && win && !win.isDestroyed() && win.isFocused()
    && !overlayOpen && !locked;
  if (seen) return;
  const count = (tabUnread.get(tabId) || 0) + 1;
  tabUnread.set(tabId, count);
  if (win && !win.isDestroyed()) win.webContents.send("tab:unread", { tabId, count });
});

ipcMain.handle("extensions:menu", (_event, id) => {
  const action = extensionActions.find((item) => item.id === id);
  if (!action) return;
  const options = optionsUrlOf(id);
  const dir = settings.extensions.find((p) => {
    const listed = extensionList().find((item) => item.path === p);
    return listed && listed.id === id;
  });
  Menu.buildFromTemplate([
    { label: action.name, enabled: false },
    { type: "separator" },
    {
      label: "Options",
      enabled: Boolean(options),
      click: () => openExtensionPage(options, action.name),
    },
    {
      label: "Remove extension",
      enabled: Boolean(dir),
      click: () => {
        extensions.unload(electronSession.defaultSession, dir);
        settings.extensions = settings.extensions.filter((p) => p !== dir);
        store.saveSettings(settings);
        extensions.forget(dir, app.getPath("userData"));
        refreshExtensionActions();
      },
    },
  ]).popup({ window: win });
});

/*
 * From the popup preload: which tab the user is actually looking at. Electron
 * counts the popup itself as a tab and calls it active because it has focus,
 * which is the one thing an extension must not believe.
 */
ipcMain.handle("extension-popup:active-tab", () => {
  const tab = activeTabId ? tabs.get(activeTabId) : null;
  return tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents.id : -1;
});

/*
 * A browser answers `runtime.openOptionsPage()` and `tabs.create()` by opening
 * a tab. Electron has no tab strip for extension pages, so it answers the
 * first with "Could not create an options page." and does not implement the
 * second at all - which is why an extension's own settings button did nothing.
 * They come here instead: the options page opens in the same window the
 * right-click menu uses, and any other address goes to the browser.
 */
function popupOwner(event) {
  const host = popupHost();
  if (!extensionPopup || !host || event.sender !== host) return null;
  const { id } = extensionPopup;
  return { id, name: (extensionActions.find((item) => item.id === id) || {}).name || "Extension" };
}

ipcMain.handle("extension-popup:open-options", (event) => {
  const owner = popupOwner(event);
  if (!owner) return false;
  const options = optionsUrlOf(owner.id);
  // The popup goes either way: a browser's closes the moment it loses focus.
  closeExtensionPopup();
  if (!options) return false;
  openExtensionPage(options, owner.name);
  return true;
});

ipcMain.handle("extension-popup:open-url", (event, url) => {
  const owner = popupOwner(event);
  if (!owner) return false;
  const target = typeof url === "string" ? url : "";
  closeExtensionPopup();
  if (target.startsWith("chrome-extension://")) {
    openExtensionPage(target, owner.name);
    return true;
  }
  if (/^https?:/i.test(target)) {
    shell.openExternal(target);
    return true;
  }
  return false;
});

ipcMain.on("extension-popup:size", (event, size) => {
  const host = popupHost();
  if (!host || event.sender !== host || !extensionPopup) return;
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
  if (!extensionPopup.shown) {
    clearTimeout(extensionPopup.settle);
    revealExtensionPopup(size);
    return;
  }
  placeExtensionPopup(extensionPopup.anchor, size);
});

ipcMain.on("extension-popup:close", (event) => {
  const host = popupHost();
  if (host && event.sender === host) closeExtensionPopup();
});

ipcMain.handle("shell:open-external", (_event, url) => shell.openExternal(url));

/* -------------------------------------------------------------------- boot */

// What the Linux panels that implement the Unity badge protocol look the app up
// by: it has to match the installed .desktop file, which electron-builder names
// after the executable rather than after the product. The app's own name is
// deliberately left alone - it is what the user data directory is named after.
if (process.platform === "linux") app.desktopName = "mvmos-desktop.desktop";

/*
 * A page only gets what a browser would grant it without a prompt being useful:
 * these are sites the user added themselves, and there is no permission UI in
 * this app to ask through. Location and raw device access are not on the list.
 */
const GRANTED_PERMISSIONS = new Set([
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "media",
  "audioCapture",
  "videoCapture",
  "background-sync",
  "midi",
  "midiSysex",
]);

app.whenReady().then(async () => {
  installations = store.load();
  session = store.loadSession();
  settings = store.loadSettings();
  sidebarVisible = session.sidebarVisible !== false;
  // A PIN means the app starts covered; nothing is shown until it is entered.
  locked = Boolean(settings.pin);

  // A timed mute set before the app was last closed may already be over.
  sweepExpiredMutes();
  setInterval(sweepExpiredMutes, 30000);

  const defaultSession = electronSession.defaultSession;
  defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(GRANTED_PERMISSIONS.has(permission));
  });
  // Chromium re-checks this every time a page is about to show a notification,
  // not just once at the initial permission prompt - so a muted installation's
  // notifications can be blocked here without the page ever finding out.
  defaultSession.setPermissionCheckHandler((wc, permission) => {
    if (permission === "notifications") {
      const installationId = installationIdForWebContents(wc);
      if (isMuted(installations.find((i) => i.id === installationId))) return false;
    }
    return GRANTED_PERMISSIONS.has(permission);
  });

  // Both have to be done before the first page loads: a cookie put back after
  // the page asked for it is a login the user still had to repeat.
  await cookies.restore(defaultSession);
  await extensions.loadAll(defaultSession, settings.extensions);

  extensionActions = extensions.actions(settings.extensions);
  keepExtensionWorkersAwake();

  buildMenu();
  createWindow();
  syncTray();

  // Late enough that neither the check nor the icon lookups delay the first
  // paint, early enough that the answer is there before the user has finished
  // looking around.
  setTimeout(() => runUpdateCheck(false), 4000);
  setTimeout(() => { void backfillIcons(); }, 1500);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/*
 * Quitting waits for one thing: the session cookies being written out. Without
 * it the app comes back logged out of everything, which is the one part of a
 * restored session Chromium does not restore by itself.
 */
let cookiesSaved = false;
app.on("before-quit", (event) => {
  quitting = true;
  persistSessionNow();
  if (cookiesSaved) return;
  event.preventDefault();
  cookies.save(electronSession.defaultSession).finally(() => {
    cookiesSaved = true;
    app.quit();
  });
});

app.on("will-quit", () => {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
