"use strict";

/*
 * Chrome extensions.
 *
 * Electron ships Chromium's extension system but none of the browser UI around
 * it, so the parts an extension needs to be useful - the toolbar icon, the
 * popup, knowing which page the user is looking at - are ours to provide. This
 * module is the model side of that: what is installed, what icon and popup
 * each one declares, and where its files live. The window draws the toolbar
 * and hosts the popup.
 *
 * What Chromium itself gives us (verified against this Electron, not assumed):
 * manifests, content scripts, background service workers, and the runtime,
 * storage, tabs and scripting APIs - including tabs.sendMessage into a content
 * script, which is how a password manager fills a form.
 *
 * Only unpacked extensions load, so an archive is unpacked into the user data
 * directory first and the folder is what Chromium is pointed at.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const unzip = require("./unzip");

/** Absolute path -> the Extension object Chromium handed back. */
const loaded = new Map();
/** Absolute path -> why it could not be loaded. */
const failures = new Map();

const ICON_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" };

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

/*
 * Manifest v2 and v3 name the same thing differently, and either may leave out
 * the action block entirely - an extension that is only content scripts still
 * deserves a toolbar slot, so the caller can tell the user it is loaded.
 */
function actionOf(manifest) {
  return (manifest && (manifest.action || manifest.browser_action || manifest.page_action)) || {};
}

/*
 * The toolbar is drawn at a fixed size, so the icon that is least work for the
 * renderer is the smallest one that is still at least as big as the slot.
 */
function pickIconPath(dir, manifest) {
  const sources = [actionOf(manifest).default_icon, manifest && manifest.icons];
  for (const source of sources) {
    if (!source) continue;
    if (typeof source === "string") return path.join(dir, source);
    const sizes = Object.keys(source)
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    const wanted = sizes.find((n) => n >= 32) ?? sizes[sizes.length - 1];
    if (wanted !== undefined) return path.join(dir, source[String(wanted)]);
  }
  return null;
}

/*
 * The chrome renderer has a strict CSP and no file access, so icons travel to
 * it as data URLs the same way installation favicons do.
 */
function iconDataUrl(dir, manifest) {
  const file = pickIconPath(dir, manifest);
  if (!file) return null;
  try {
    const mime = ICON_TYPES[path.extname(file).slice(1).toLowerCase()];
    if (!mime) return null;
    // A toolbar icon that is megabytes big is a broken extension, not a case
    // worth serialising through IPC.
    const contents = fs.readFileSync(file);
    if (contents.length > 512 * 1024) return null;
    return `data:${mime};base64,${contents.toString("base64")}`;
  } catch {
    return null;
  }
}

async function loadOne(session, dir) {
  if (loaded.has(dir)) return { ok: true };
  if (!readManifest(dir)) {
    const message = "No readable manifest.json in that folder.";
    failures.set(dir, message);
    return { ok: false, message };
  }
  try {
    // allowFileAccess lets a filling extension act on file:// pages too; the
    // folder is one the user picked themselves, so it is no wider a trust than
    // installing it in a browser.
    const extension = await session.extensions.loadExtension(dir, { allowFileAccess: true });
    loaded.set(dir, extension);
    failures.delete(dir);
    return { ok: true };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    failures.set(dir, message);
    return { ok: false, message };
  }
}

function unload(session, dir) {
  const extension = loaded.get(dir);
  if (extension) {
    try {
      session.extensions.removeExtension(extension.id);
    } catch {
      /* already gone - the list is what matters */
    }
  }
  loaded.delete(dir);
  failures.delete(dir);
}

/*
 * Starts every loaded extension's background worker.
 *
 * Chromium stops an idle service worker after about half a minute and starts
 * it again when a message arrives - except that here nothing starts it again:
 * a popup or a content script that messages a stopped worker waits for an
 * answer that never comes. Verified against this Electron, and the reason
 * this is called on a timer rather than only when something needs it.
 */
function wake(session) {
  for (const extension of loaded.values()) {
    try {
      // The worker's scope is the extension's own origin.
      session.serviceWorkers.startWorkerForScope(extension.url).catch(() => {
        /* no background worker, or it is already going */
      });
    } catch {
      /* older runtimes without the API: the extension simply idles out */
    }
  }
}

/** Loads everything the settings file remembers, skipping folders that vanished. */
async function loadAll(session, paths) {
  for (const dir of paths) {
    if (!fs.existsSync(dir)) {
      failures.set(dir, "Folder no longer exists.");
      continue;
    }
    await loadOne(session, dir);
  }
}

/*
 * Unpacking an archive: the destination is derived from the file so that
 * re-adding the same download replaces its own folder instead of piling up
 * copies, and the hash keeps two extensions of the same name apart.
 */
function unpackedRoot(userDataPath) {
  return path.join(userDataPath, "extensions");
}

function install(source, userDataPath) {
  const stats = fs.statSync(source);
  if (stats.isDirectory()) return source;

  const extension = path.extname(source).toLowerCase();
  if (extension !== ".zip" && extension !== ".crx") {
    throw new Error("Pick an extension folder, or a .zip or .crx file.");
  }

  const slug = path.basename(source, extension).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "extension";
  const digest = createHash("sha1").update(path.resolve(source)).digest("hex").slice(0, 8);
  const dest = path.join(unpackedRoot(userDataPath), `${slug}-${digest}`);

  fs.rmSync(dest, { recursive: true, force: true });
  unzip.extract(source, dest);
  const root = unzip.findManifestRoot(dest);
  if (!root) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error("No manifest.json anywhere in that archive.");
  }
  return root;
}

/** True for a folder we unpacked ourselves, which is ours to delete again. */
function isManaged(dir, userDataPath) {
  const root = unpackedRoot(userDataPath) + path.sep;
  return path.resolve(dir).startsWith(root);
}

function forget(dir, userDataPath) {
  if (!isManaged(dir, userDataPath)) return;
  // The manifest may sit one level down inside the folder we created.
  let target = path.resolve(dir);
  const root = path.resolve(unpackedRoot(userDataPath));
  while (path.dirname(target) !== root && path.dirname(target) !== target) target = path.dirname(target);
  fs.rmSync(target, { recursive: true, force: true });
}

/** What the settings dialog shows: one row per remembered folder. */
function list(paths, userDataPath) {
  return paths.map((dir) => {
    const extension = loaded.get(dir);
    const manifest = readManifest(dir);
    return {
      path: dir,
      name: (extension && extension.name) || (manifest && manifest.name) || path.basename(dir),
      version: (extension && extension.version) || (manifest && manifest.version) || "",
      id: extension ? extension.id : null,
      managed: userDataPath ? isManaged(dir, userDataPath) : false,
      error: failures.get(dir) || null,
    };
  });
}

/*
 * What the toolbar draws, in the order the user added them. An extension with
 * no popup still gets a button: clicking it fires action.onClicked, which is
 * how the no-popup kind is meant to be triggered.
 */
function actions(paths) {
  const result = [];
  for (const dir of paths) {
    const extension = loaded.get(dir);
    if (!extension) continue;
    const manifest = extension.manifest || readManifest(dir) || {};
    const action = actionOf(manifest);
    const popup = action.default_popup || null;
    result.push({
      id: extension.id,
      name: extension.name,
      title: action.default_title || extension.name,
      icon: iconDataUrl(extension.path || dir, manifest),
      popupUrl: popup ? new URL(popup, extension.url).href : null,
    });
  }
  return result;
}

module.exports = { loadAll, loadOne, unload, list, actions, install, forget, wake };
