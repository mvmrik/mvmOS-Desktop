"use strict";

/*
 * Site icons for the sidebar.
 *
 * The chrome renderer runs under a strict content policy and has no network of
 * its own, so an icon is fetched here and handed over as a data URL. Icons are
 * small and rarely change, which is why a plain in-memory cache is enough for
 * one run of the app; the icon of an installation is also kept in the settings
 * file, so the sidebar is not blank on the next start.
 */

const { httpGet } = require("./net");

const MAX_ICON_BYTES = 128 * 1024;
const MAX_PAGE_BYTES = 256 * 1024;

/** iconUrl -> data URL or null when that address has nothing usable. */
const cache = new Map();

function isImage(res) {
  const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return true;
  // Some servers hand out favicon.ico as application/octet-stream; accept it
  // when the bytes themselves start with an ICO or PNG signature.
  const b = res.body;
  if (b.slice(0, 200).toString("utf8").includes("<svg")) return true;
  return (b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0)
    || (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47);
}

function mimeOf(res) {
  const b = res.body;
  // The bytes win over the header: servers routinely hand out a PNG under the
  // .ico name and its content type, and the declared one is what a data URL
  // would carry into the page.
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.slice(0, 200).toString("utf8").includes("<svg")) return "image/svg+xml";
  const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return type;
  return "image/x-icon";
}

async function fetchIcon(iconUrl, { bypassCache = false } = {}) {
  if (!bypassCache && cache.has(iconUrl)) return cache.get(iconUrl);
  let result = null;
  try {
    const res = await httpGet(iconUrl, { maxBytes: MAX_ICON_BYTES });
    if (res.status >= 200 && res.status < 300 && res.body.length && isImage(res)) {
      result = `data:${mimeOf(res)};base64,${res.body.toString("base64")}`;
    }
  } catch {
    result = null;
  }
  cache.set(iconUrl, result);
  return result;
}

/*
 * Icons declared in the page win over /favicon.ico, because an mvmOS
 * installation serves its own logo through a <link rel="icon"> and only some
 * servers answer on the well-known path at all.
 */
function declaredIcons(html, baseUrl) {
  const urls = [];
  const linkTag = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkTag.exec(html)) !== null) {
    const tag = match[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag);
    if (!rel || !/\bicon\b/i.test(rel[1])) continue;
    const href = /\bhref\s*=\s*["']([^"']+)/i.exec(tag);
    if (!href) continue;
    try {
      urls.push(new URL(href[1], baseUrl).toString());
    } catch {
      /* a href we cannot resolve is simply skipped */
    }
  }
  return urls;
}

/** Best icon for a site, or null when it has none we can use. */
async function discover(siteUrl) {
  let candidates = [];
  let base = siteUrl;
  try {
    const res = await httpGet(siteUrl, { maxBytes: MAX_PAGE_BYTES });
    base = res.url || siteUrl;
    if (res.status >= 200 && res.status < 400) {
      candidates = declaredIcons(res.body.toString("utf8"), base);
    }
  } catch {
    /* an unreachable page still gets the well-known path tried below */
  }

  try {
    candidates.push(new URL("/favicon.ico", base).toString());
  } catch {
    /* nothing to add */
  }

  for (const candidate of candidates) {
    const icon = await fetchIcon(candidate);
    if (icon) return icon;
  }
  return null;
}

module.exports = { discover, fetchIcon };
