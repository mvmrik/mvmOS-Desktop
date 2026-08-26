"use strict";

/*
 * Staying logged in across restarts.
 *
 * Chromium keeps two kinds of cookies: ones with an expiry, which it writes to
 * disk, and session cookies, which it deliberately never does - they are meant
 * to die with the browser. A login that uses a session cookie therefore comes
 * back logged out, which is exactly what a browser with "continue where you
 * left off" turned on avoids, and what this app - which reopens every tab where
 * it left it - should avoid too.
 *
 * So the session cookies are written out by hand when the app quits and put
 * back before the first tab loads. Everything else (localStorage, IndexedDB,
 * expiring cookies) already persists on its own, because the default session is
 * a real on-disk profile.
 */

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const FILE = "session-cookies.json";

function filePath() {
  return path.join(app.getPath("userData"), FILE);
}

/*
 * A cookie read back from Chromium carries a domain, which may be a wildcard
 * (".example.com"); setting one needs a URL instead, and it has to match the
 * cookie's own scheme or the write is rejected.
 */
function urlFor(cookie) {
  const host = cookie.domain.replace(/^\./, "");
  const scheme = cookie.secure ? "https" : "http";
  return `${scheme}://${host}${cookie.path || "/"}`;
}

async function save(session) {
  try {
    const all = await session.cookies.get({});
    const sessionCookies = all
      .filter((c) => c.session || typeof c.expirationDate !== "number")
      .map((c) => ({
        url: urlFor(c),
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
      }));
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(sessionCookies), "utf8");
    // Persistent cookies are written lazily; a quit is the last chance to ask.
    await session.cookies.flushStore();
  } catch {
    /* a profile we cannot read is no reason to hold up the quit */
  }
}

async function restore(session) {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(filePath(), "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(saved)) return;
  for (const cookie of saved) {
    try {
      // No expirationDate: it goes back in as the session cookie it was, so the
      // site cannot tell the difference and we save it again next time.
      await session.cookies.set(cookie);
    } catch {
      /* a cookie the site has since invalidated simply does not come back */
    }
  }
}

module.exports = { save, restore };
