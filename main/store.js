"use strict";

// Installations live in a single JSON file in the per-user app data directory,
// the same shape the Tauri build used, so an existing file is picked up as is.
// What was open last time is kept apart from them, in session.json, so a
// corrupted session can never cost the user their list of installations.
// Preferences that are neither - the lock PIN, the loaded extensions - live in
// settings.json for the same reason.

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function filePath(name) {
  return path.join(app.getPath("userData"), name);
}

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), "utf8"));
  } catch {
    return null;
  }
}

function writeJson(name, value) {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath(name), JSON.stringify(value, null, 2), "utf8");
}

function load() {
  const parsed = readJson("installations.json");
  if (!Array.isArray(parsed)) return [];
  // Guard against a hand-edited file: anything without the three fields we
  // rely on would break the sidebar rather than fail loudly here.
  return parsed
    .filter((i) => i && typeof i.id === "string" && typeof i.name === "string" && typeof i.address === "string")
    .map((i) => ({
      ...i,
      type: i.type === "site" ? "site" : "mvmos",
      // A timestamp (ms) for a timed mute, "forever" for an indefinite one, or
      // absent - anything else from a hand-edited file is not muted.
      muteUntil: i.muteUntil === "forever" || Number.isFinite(i.muteUntil) ? i.muteUntil : undefined,
    }));
}

function save(list) {
  writeJson("installations.json", list);
}

/**
 * { bounds, maximized, tabs, activeTabId } - every field optional, since a
 * session written by an older version is still worth honouring in part.
 */
function loadSession() {
  const parsed = readJson("session.json");
  if (!parsed || typeof parsed !== "object") return {};
  return {
    bounds: parsed.bounds && typeof parsed.bounds === "object" ? parsed.bounds : null,
    maximized: Boolean(parsed.maximized),
    sidebarVisible: parsed.sidebarVisible !== false,
    tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
    activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : null,
  };
}

function saveSession(session) {
  writeJson("session.json", session);
}

/**
 * { pin, extensions, showTray, closeToTray, lockTimeoutMinutes,
 * lockResetOnActivity } - a file written by an older version simply has fewer
 * of them.
 */
const TRAY_DEFAULTS = {
  // On by default: on Linux it is the only place an unread count is sure to
  // show, and on Windows it is what a closed-away window is reached through.
  showTray: true,
  // Off by default: a window that vanishes instead of closing is not what the
  // button is expected to do, so it is asked for rather than assumed.
  closeToTray: false,
};

// 0 means auto-lock is off; it only ever does anything once a PIN exists.
// Reset-on-activity defaults on, since a fixed countdown that ignores use of
// the app is the less forgiving of the two and worth opting into instead.
const LOCK_TIMEOUT_DEFAULTS = {
  lockTimeoutMinutes: 0,
  lockResetOnActivity: true,
};

function loadSettings() {
  const parsed = readJson("settings.json");
  if (!parsed || typeof parsed !== "object") {
    return { pin: null, extensions: [], ...TRAY_DEFAULTS, ...LOCK_TIMEOUT_DEFAULTS };
  }
  const pin = parsed.pin;
  const minutes = Math.round(Number(parsed.lockTimeoutMinutes));
  return {
    pin: pin && typeof pin.salt === "string" && typeof pin.hash === "string"
      ? { salt: pin.salt, hash: pin.hash }
      : null,
    extensions: Array.isArray(parsed.extensions)
      ? parsed.extensions.filter((p) => typeof p === "string" && p)
      : [],
    showTray: parsed.showTray !== false,
    closeToTray: parsed.closeToTray === true,
    lockTimeoutMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 0,
    lockResetOnActivity: parsed.lockResetOnActivity !== false,
  };
}

function saveSettings(settings) {
  writeJson("settings.json", settings);
}

module.exports = { load, save, loadSession, saveSession, loadSettings, saveSettings };
