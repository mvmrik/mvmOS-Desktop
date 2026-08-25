"use strict";

// Installations live in a single JSON file in the per-user app data directory,
// the same shape the Tauri build used, so an existing file is picked up as is.

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function filePath() {
  return path.join(app.getPath("userData"), "installations.json");
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    // Guard against a hand-edited file: anything without the three fields we
    // rely on would break the sidebar rather than fail loudly here.
    return parsed.filter(
      (i) => i && typeof i.id === "string" && typeof i.name === "string" && typeof i.address === "string",
    );
  } catch {
    return [];
  }
}

function save(list) {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(list, null, 2), "utf8");
}

module.exports = { load, save };
