"use strict";

/*
 * Update check.
 *
 * The app only looks up the newest published release and says so; downloading
 * and installing stays the user's decision, because the three platforms are
 * packaged differently and a silent replacement is not something a .deb or an
 * unsigned macOS build can do honestly.
 */

const { httpGet } = require("./net");

const LATEST_RELEASE_URL = "https://api.github.com/repos/mvmrik/mvmOS-Desktop/releases/latest";
// Where the user is sent to get it: the site reads the same release and offers
// the one file that fits the browser it is opened from, which is a better
// landing than a list of every artefact the build produced.
const DOWNLOAD_PAGE = "https://mvmos.org/download";

function parseVersion(raw) {
  const cleaned = String(raw || "").trim().replace(/^v/i, "");
  const parts = cleaned.split(/[.\-+]/);
  const numbers = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) break;
    numbers.push(parseInt(part, 10));
  }
  return numbers;
}

/** True when `candidate` is a later version than `current`. */
function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left > right;
  }
  return false;
}

/** { version, url } when a newer release exists, otherwise null. */
async function checkForUpdate(currentVersion) {
  try {
    const res = await httpGet(LATEST_RELEASE_URL, {
      headers: { "User-Agent": "mvmOS-Desktop", Accept: "application/vnd.github+json" },
      maxBytes: 256 * 1024,
    });
    if (res.status !== 200) return null;
    const release = JSON.parse(res.body.toString("utf8"));
    if (release.draft || release.prerelease) return null;
    const version = String(release.tag_name || release.name || "").replace(/^v/i, "");
    if (!isNewer(version, currentVersion)) return null;
    return { version, url: DOWNLOAD_PAGE };
  } catch {
    // No network, a rate limit or a malformed answer all mean the same thing
    // here: nothing to tell the user about.
    return null;
  }
}

module.exports = { checkForUpdate, isNewer };
