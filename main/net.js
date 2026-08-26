"use strict";

const http = require("node:http");
const https = require("node:https");

const PROBE_TIMEOUT_MS = 5000;
const GET_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 5;

/** Turns "example.com", "192.168.1.10:2026" or a full URL into a bare origin. */
function normalizeAddress(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("Address is empty");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Address could not be understood");
  }
  if (!url.hostname) throw new Error("Address is missing a host");
  return url.toString().replace(/\/+$/, "");
}

function originOf(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "";
  }
}

/*
 * Whether two URLs belong to the same installation. The scheme is deliberately
 * ignored: an address typed without "https://" loads over http, the server
 * redirects to https, and a strict origin check would then treat every click on
 * the page as a link to a foreign site and push it out to the system browser.
 */
function sameSite(a, b) {
  let ua;
  let ub;
  try {
    ua = new URL(a);
    ub = new URL(b);
  } catch {
    return false;
  }
  return ua.hostname === ub.hostname && ua.port === ub.port;
}

/**
 * Any HTTP answer counts as reachable - a 401 or a 404 still proves there is a
 * server on the other end, which is all this check is for.
 */
function isReachable(address) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(address);
    } catch {
      resolve(false);
      return;
    }
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      { method: "GET", timeout: PROBE_TIMEOUT_MS },
      (res) => {
        res.destroy();
        resolve(true);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * A small GET that follows redirects and stops reading once `maxBytes` is
 * reached. Used for the two things this app fetches on its own behalf - a
 * favicon and the latest release number - so neither needs a dependency.
 */
function httpGet(rawUrl, { headers = {}, maxBytes = 512 * 1024, redirects = MAX_REDIRECTS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      reject(new Error("Bad URL"));
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new Error("Unsupported scheme"));
      return;
    }

    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, { method: "GET", timeout: GET_TIMEOUT_MS, headers }, (res) => {
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.destroy();
        if (redirects <= 0) {
          reject(new Error("Too many redirects"));
          return;
        }
        httpGet(new URL(location, url).toString(), { headers, maxBytes, redirects: redirects - 1 })
          .then(resolve, reject);
        return;
      }

      const chunks = [];
      let size = 0;
      let settled = false;
      /*
       * A page longer than the cap is answered with the part we did read: the
       * icon declarations are in the head, and a stream cut short never fires
       * "end", so the caller would otherwise wait forever.
       */
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: url.toString() });
      };

      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

/*
 * An address typed without a scheme is loaded over http, and most servers
 * answer with a redirect to https. Following that once when the address is
 * saved means every later visit starts where the server wanted it anyway.
 */
async function upgradeScheme(address) {
  if (!/^http:\/\//i.test(address)) return address;
  try {
    const res = await httpGet(address, { maxBytes: 4096 });
    if (/^https:/i.test(res.url) && sameSite(res.url, address)) {
      return address.replace(/^http:/i, "https:");
    }
  } catch {
    /* nothing to upgrade when the address does not answer */
  }
  return address;
}

module.exports = { normalizeAddress, originOf, sameSite, isReachable, httpGet, upgradeScheme };
