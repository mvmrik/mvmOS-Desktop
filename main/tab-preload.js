"use strict";

/*
 * Runs in every page a tab shows.
 *
 * A password manager decorates a login field with a small icon of its own and
 * opens its popup when that icon is clicked - by asking the browser for it,
 * through `chrome.action.openPopup()` from its background worker. Electron
 * ships that function only as a stub ("chrome.action.openPopup is not
 * supported in Electron") and the call is made inside a service worker, where
 * nothing of ours can run, so the click reaches nobody and the icon looks
 * broken.
 *
 * The icon itself is an ordinary element in the page's DOM, though - a content
 * script has nowhere else to put it - and a click on it passes us like any
 * other. So we recognise it and ask the main process for the popup the
 * extension could not open for itself.
 */

const { ipcRenderer } = require("electron");

// An affordance drawn on a field is icon-sized; anything bigger is page UI.
const MAX_SIDE = 64;
const MIN_SIDE = 8;
// The rectangle only means something in the frame the viewport belongs to.
const isTopFrame = (() => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
})();

/*
 * Through an open shadow root, `composedPath()` hands us the inner element,
 * whose position in the document is really its host's.
 */
function outermost(node) {
  let element = node;
  while (element) {
    const root = element.getRootNode ? element.getRootNode() : null;
    if (!root || !root.host) return element;
    element = root.host;
  }
  return null;
}

/*
 * A content script hangs its element off <html> rather than the page's <body>,
 * so that it survives the page rewriting the body under it. That is the one
 * thing that separates an injected icon from the page's own furniture; the
 * rest - fixed to the viewport, icon-sized, sitting on a login field - is what
 * separates it from an extension's other injected UI. An extension that
 * instead appends into <body> is not recognised, which is the price of not
 * opening a popup over somebody's cookie banner.
 */
function isFieldIcon(element) {
  if (!element || element.nodeType !== 1 || element === document.documentElement) return false;
  if (document.body && document.body.contains(element)) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) return false;
  if (rect.width > MAX_SIDE || rect.height > MAX_SIDE) return false;
  if (getComputedStyle(element).position !== "fixed") return false;
  return overlapsLoginField(rect);
}

function overlapsLoginField(rect) {
  for (const field of document.querySelectorAll("input, textarea")) {
    const box = field.getBoundingClientRect();
    // The same "is this field real" test the extensions themselves apply, so a
    // hidden or collapsed input cannot vouch for an icon.
    if (box.width < 40 || box.height < 14) continue;
    if (rect.right < box.left || rect.left > box.right) continue;
    if (rect.bottom < box.top || rect.top > box.bottom) continue;
    return true;
  }
  return false;
}

/*
 * Capture, so the extension's own handler still runs afterwards: its
 * openPopup() does nothing here, but nothing says it will always be the only
 * thing that click does.
 */
window.addEventListener(
  "click",
  (event) => {
    if (!event.isTrusted) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    for (const node of path) {
      if (node === document || node === window) break;
      const element = outermost(node);
      if (!isFieldIcon(element)) continue;
      const rect = element.getBoundingClientRect();
      // From an iframe the rectangle is measured against the wrong origin, so
      // the popup is asked for without one and opens where it can.
      ipcRenderer.send(
        "tab:extension-icon",
        isTopFrame ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null
      );
      return;
    }
  },
  true
);
