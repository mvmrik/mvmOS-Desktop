"use strict";

const http = require("node:http");
const https = require("node:https");

const PROBE_TIMEOUT_MS = 5000;

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

module.exports = { normalizeAddress, originOf, isReachable };
