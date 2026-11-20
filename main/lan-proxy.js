"use strict";

/*
 * On Windows an installation in WSL is reachable only at 127.0.0.1 of this
 * computer, through WSL's own port forwarding. When the user lets phones and
 * other devices open it, this app listens on the same port at the
 * computer's network addresses and passes every request on, so the phone
 * uses the same address and port it would on Linux. Listening on those
 * addresses rather than on all of them leaves 127.0.0.1 to WSL.
 *
 * It is HTTP-aware rather than a plain TCP pipe on purpose: mvmOS sees the
 * device's own address in X-Real-IP, so failed sign-ins of one phone do not
 * lock out this computer, and a request from the network is never mistaken
 * for one that came from this computer itself.
 *
 * Windows asks once whether mvmOS Desktop may accept connections; Private
 * networks are what it offers by default.
 */

const http = require("node:http");
const net = require("node:net");
const os = require("node:os");

const RESCAN_MS = 30000;
// Whatever the device sent itself is replaced, never trusted.
const FORWARDING_HEADERS = new Set(["x-real-ip", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded"]);

// port -> Map(address -> http.Server)
const listeners = new Map();
let wanted = new Set();
let timer = null;

/** This computer's IPv4 addresses in networks a phone can be part of. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // WSL, Hyper-V, VirtualBox, VMware and VPN adapters lead to networks of
    // their own that no phone is part of.
    if (/^(docker|br-|veth|virbr|lxc|lxd|tun|tap|wg)|vEthernet|VirtualBox|VMware|Hyper-V|Loopback|Bluetooth/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
    }
  }
  return out;
}

function clientAddress(socket) {
  return String(socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function forwardedHeaders(headers, socket) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!FORWARDING_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  const ip = clientAddress(socket);
  out["x-real-ip"] = ip;
  out["x-forwarded-for"] = ip;
  out["x-forwarded-proto"] = "http";
  return out;
}

function handleRequest(port, req, res) {
  const upstream = http.request({
    host: "127.0.0.1",
    port,
    method: req.method,
    path: req.url,
    headers: forwardedHeaders(req.headers, req.socket),
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.statusMessage, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("mvmOS on this computer is not running right now.");
  });
  req.pipe(upstream);
}

/* The terminal and live updates use WebSockets, which are passed on as raw
   streams once the upgrade request has gone through with its headers. */
function handleUpgrade(port, req, socket, head) {
  const upstream = net.connect(port, "127.0.0.1", () => {
    const headers = forwardedHeaders(req.headers, socket);
    let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(headers)) {
      for (const v of Array.isArray(value) ? value : [value]) text += `${key}: ${v}\r\n`;
    }
    upstream.write(`${text}\r\n`);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
}

function listen(port, address) {
  const server = http.createServer((req, res) => handleRequest(port, req, res));
  server.on("upgrade", (req, socket, head) => handleUpgrade(port, req, socket, head));
  server.on("clientError", (_e, socket) => socket.destroy());
  // A busy or vanished address is tried again on the next scan.
  server.on("error", () => {
    const byAddress = listeners.get(port);
    if (byAddress && byAddress.get(address) === server) byAddress.delete(address);
  });
  server.listen(port, address);
  return server;
}

/* Wi-Fi changes, a cable is plugged in, DHCP hands out a new address. */
function sync() {
  const addresses = new Set(lanAddresses());
  for (const [port, byAddress] of listeners) {
    for (const [address, server] of byAddress) {
      if (!wanted.has(port) || !addresses.has(address)) {
        server.close();
        byAddress.delete(address);
      }
    }
    if (!wanted.has(port)) listeners.delete(port);
  }
  for (const port of wanted) {
    if (!listeners.has(port)) listeners.set(port, new Map());
    const byAddress = listeners.get(port);
    for (const address of addresses) {
      if (!byAddress.has(address)) byAddress.set(address, listen(port, address));
    }
  }
}

/** The ports that devices on the network may open; an empty set closes all. */
function setPorts(ports) {
  wanted = new Set(ports);
  sync();
  if (wanted.size && !timer) {
    timer = setInterval(sync, RESCAN_MS);
    timer.unref();
  } else if (!wanted.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { setPorts, lanAddresses };
