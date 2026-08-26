"use strict";

// Installations live in a single JSON file in the per-user app data directory,
// the same shape the Tauri build used, so an existing file is picked up as is.
// What was open last time is kept apart from them, in session.json, so a
// corrupted session can never cost the user their list of installations.

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
    .map((i) => ({ ...i, type: i.type === "site" ? "site" : "mvmos" }));
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

module.exports = { load, save, loadSession, saveSession };
