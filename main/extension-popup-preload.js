"use strict";

/*
 * Runs inside an extension's popup page.
 *
 * Two things a real browser does for a popup that Electron does not:
 *
 * 1. It does not count the popup as a tab. Here every WebContentsView is one,
 *    and `active` follows keyboard focus - which the popup necessarily has
 *    while it is open. An extension that asks "which tab is the user looking
 *    at?" would get the popup itself and conclude the user is looking at
 *    nothing fillable. So tabs.query is rewritten to answer about the page
 *    behind the popup: extension pages and the chrome window are dropped, and
 *    the app's active tab is the one marked active.
 *
 * 2. It sizes the popup to its content. We measure and tell the main process.
 *
 * 3. It opens a tab when the popup asks for one. Electron has no tab strip for
 *    extension pages: `runtime.openOptionsPage()` rejects with "Could not
 *    create an options page." and `tabs.create` is not implemented at all, so
 *    an extension's own settings button silently does nothing. Both are routed
 *    to the main process, which opens the page in a window.
 *
 * The page keeps Node out (nodeIntegration is off); what this script leaves
 * behind on the page is the patched function and nothing else.
 */

const { ipcRenderer } = require("electron");

function patchTabsQuery() {
  if (!globalThis.chrome || !chrome.tabs || typeof chrome.tabs.query !== "function") return false;
  if (chrome.tabs.query.__mvmosPatched) return true;

  const original = chrome.tabs.query.bind(chrome.tabs);

  // The callback form works in both manifest versions; the promise form does
  // not exist in manifest v2, so everything is normalised to a callback.
  const queryAll = (info) =>
    new Promise((resolve) => {
      try {
        const maybe = original(info, (tabs) => resolve(tabs || []));
        if (maybe && typeof maybe.then === "function") maybe.then((tabs) => resolve(tabs || []));
      } catch {
        resolve([]);
      }
    });

  const patched = function query(info, callback) {
    const filter = info && typeof info === "object" ? info : {};
    // Chromium applies these before we see the result, and its idea of which
    // window and which tab is current is the one being corrected here.
    const relaxed = { ...filter };
    delete relaxed.active;
    delete relaxed.currentWindow;
    delete relaxed.lastFocusedWindow;
    delete relaxed.highlighted;
    delete relaxed.windowId;

    const promise = (async () => {
      const [all, activeId] = await Promise.all([queryAll(relaxed), ipcRenderer.invoke("extension-popup:active-tab")]);
      let tabs = all
        .filter((tab) => /^https?:/i.test(tab.url || ""))
        .map((tab) => ({ ...tab, active: tab.id === activeId, highlighted: tab.id === activeId, selected: tab.id === activeId }));
      if (filter.active === true) tabs = tabs.filter((tab) => tab.active);
      if (filter.active === false) tabs = tabs.filter((tab) => !tab.active);
      return tabs;
    })();

    if (typeof callback === "function") {
      promise.then(callback);
      return undefined;
    }
    return promise;
  };
  patched.__mvmosPatched = true;
  chrome.tabs.query = patched;
  return true;
}

// The extension APIs may be installed a moment after the preload's first run,
// so it is tried again once the page context is up.
if (!patchTabsQuery()) {
  process.once("loaded", patchTabsQuery);
  document.addEventListener("DOMContentLoaded", patchTabsQuery, { once: true });
}

/*
 * The callback form is what a manifest v2 extension uses and the promise form
 * what v3 does, and the popup templates out there use either - so both are
 * answered, the same way the tabs.query patch above does it.
 */
function settle(promise, callback) {
  if (typeof callback === "function") {
    promise.then((value) => callback(value));
    return undefined;
  }
  return promise;
}

function patchOpeners() {
  if (!globalThis.chrome) return false;
  let done = true;

  const existing = chrome.runtime && chrome.runtime.openOptionsPage;
  if (chrome.runtime && !(existing && existing.__mvmosPatched)) {
    const open = function openOptionsPage(callback) {
      return settle(ipcRenderer.invoke("extension-popup:open-options").then(() => undefined), callback);
    };
    open.__mvmosPatched = true;
    try {
      chrome.runtime.openOptionsPage = open;
    } catch {
      done = false;
    }
  }

  // Not a patch but an addition: without it the extension sees no tabs.create
  // at all and either throws or falls back to telling the user to paste a URL.
  if (chrome.tabs && typeof chrome.tabs.create !== "function") {
    const create = function create(properties, callback) {
      const url = properties && typeof properties === "object" ? properties.url : properties;
      // An extension expects a tab object back; nothing here has a tab id to
      // give it, and the callers only ever check that they got something.
      return settle(ipcRenderer.invoke("extension-popup:open-url", url).then((ok) => (ok ? { url } : null)), callback);
    };
    try {
      chrome.tabs.create = create;
    } catch {
      done = false;
    }
  }

  return done;
}

if (!patchOpeners()) {
  process.once("loaded", patchOpeners);
  document.addEventListener("DOMContentLoaded", patchOpeners, { once: true });
}

function reportSize() {
  const root = document.documentElement;
  const body = document.body;
  if (!root) return;
  const width = Math.max(root.scrollWidth, body ? body.scrollWidth : 0, body ? body.offsetWidth : 0);
  const height = Math.max(root.scrollHeight, body ? body.scrollHeight : 0, body ? body.offsetHeight : 0);
  ipcRenderer.send("extension-popup:size", { width, height });
}

window.addEventListener("DOMContentLoaded", () => {
  reportSize();
  // Popups grow as their own script fills them in - a password list arrives
  // well after the first paint.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(reportSize).observe(document.documentElement);
    if (document.body) new ResizeObserver(reportSize).observe(document.body);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") ipcRenderer.send("extension-popup:close");
  });
});

window.addEventListener("load", reportSize);

// The popup is kept hidden until its first measurement, and a page that fills
// itself in while hidden gets no layout callbacks - so the main process asks
// for a fresh measurement once it is on screen.
ipcRenderer.on("extension-popup:measure", reportSize);
