"use strict";

/*
 * mvmOS installed on this very computer, for people who would rather not open
 * a terminal. Nothing here knows how to install mvmOS: it runs the project's
 * own install.sh - the same script and the same steps as a manual install -
 * with options instead of questions, and runs it again with --uninstall to
 * remove one. Each installation gets its own folder /opt/<service>, its own
 * service and its own port, so several can live side by side.
 *
 * On Linux, install.sh sets up a systemd service, and everything that needs
 * root goes through pkexec, which shows the desktop's own password prompt.
 * On Windows the same happens inside a Linux of its own that Windows runs
 * with WSL; see local-wsl.js.
 *
 * Which sidebar entries are local is kept in local-installs.json, apart from
 * installations.json, so an older version of the app still reads its own file
 * unchanged and simply sees an ordinary installation at 127.0.0.1.
 */

const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const lanProxy = require("./lan-proxy");

const IS_WINDOWS = process.platform === "win32";
// Only loaded where it is used.
const wsl = IS_WINDOWS ? require("./local-wsl") : null;

// The environment variable only exists to test an unreleased install.sh.
const INSTALLER_URL = process.env.MVMOS_INSTALLER_URL
  || "https://raw.githubusercontent.com/mvmrik/mvmOS/main/install.sh";
const FILE = "local-installs.json";
const FIRST_PORT = 2026;
// Names install.sh keeps for services an installation creates for itself.
const RESERVED = new Set(["mvmos-public", "mvmos-domains", "mvmos-display"]);
// A fresh installation needs a few seconds after its service starts before it
// answers; a slow disk on first start can take longer.
const READY_TIMEOUT_MS = 90000;
// pkexec's own exit codes for a closed or failed password prompt.
const PKEXEC_DISMISSED = new Set([126, 127]);

// Only this computer, or every device that can reach it, such as a phone on
// the same Wi-Fi. Local only is the default: a laptop also joins networks
// of strangers, who would otherwise see the sign-in page of an mvmOS that
// runs as root on it.
const LOCAL_HOST = "127.0.0.1";
const ANY_HOST = "0.0.0.0";

const SERVICE_PATTERN = /^mvmos(-[a-z0-9][a-z0-9-]{0,39})?$/;

let busy = false;

function supported() {
  return process.platform === "linux" || IS_WINDOWS;
}

function platform() {
  return IS_WINDOWS ? "windows" : "linux";
}

function filePath() {
  return path.join(app.getPath("userData"), FILE);
}

/**
 * { installationId: { service, port, lan } }. `lan` is only kept on Windows,
 * where this app itself lets other devices in; on Linux the service file says.
 */
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    const out = {};
    if (parsed && typeof parsed === "object") {
      for (const [id, v] of Object.entries(parsed)) {
        if (v && SERVICE_PATTERN.test(v.service) && Number.isInteger(v.port)) {
          out[id] = { service: v.service, port: v.port, lan: v.lan === true };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function save(map) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(map, null, 2), "utf8");
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? error.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function hasCommand(name) {
  return (await run("/bin/sh", ["-c", `command -v ${name}`])).ok;
}

/**
 * What stops a local installation (`problems`, sentences the user can act
 * on), what it will do first (`notes`), and whether it has to create the Linux
 * user people sign in with - which only a new Linux on Windows needs.
 */
async function check() {
  if (IS_WINDOWS) return wsl.check();
  if (!supported()) {
    return { problems: ["Installing mvmOS on this computer is available on Linux and Windows."], notes: [], needUser: false, users: [] };
  }
  const problems = [];
  if (!(await hasCommand("systemctl"))) {
    problems.push("This Linux does not use systemd, which mvmOS needs to run as a service.");
  }
  if (!(await hasCommand("pkexec"))) {
    problems.push("pkexec (polkit) is missing, so the app cannot ask for your password. Install the polkit package.");
  }
  const py = await run("python3", ["-c", "import sys; print(sys.version_info >= (3, 10))"]);
  if (!py.ok) {
    problems.push("Python 3 is not installed. Install Python 3.10 or newer with your software manager.");
  } else if (py.stdout.trim() !== "True") {
    problems.push("Python 3.10 or newer is needed. This computer has an older Python 3.");
  }
  if (!(await hasCommand("curl")) && !(await hasCommand("wget"))) {
    problems.push("curl or wget is needed to download mvmOS. Install one of them with your software manager.");
  }
  return { problems, notes: [], needUser: false, users: [] };
}

function takenHere(service) {
  return fs.existsSync(`/opt/${service}`) || fs.existsSync(`/etc/systemd/system/${service}.service`);
}

/** "My mvmOS" -> "mvmos-my", or "mvmos-local" when nothing usable is left. */
function serviceFor(displayName, taken) {
  const slug = String(displayName || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^mvmos-?/, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  const base = slug ? `mvmos-${slug}` : "mvmos-local";
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!RESERVED.has(candidate) && !taken(candidate)) return candidate;
  }
  throw new Error("Could not find a free name for the installation.");
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

/*
 * The ports of every mvmOS service on this computer, including stopped ones,
 * which a test for a free port cannot see.
 */
function servicePorts() {
  const ports = new Set();
  try {
    for (const name of fs.readdirSync("/etc/systemd/system")) {
      if (!/^mvmos.*\.service$/.test(name)) continue;
      const unit = fs.readFileSync(path.join("/etc/systemd/system", name), "utf8");
      const m = unit.match(/--port\s+(\d+)/);
      if (m) ports.add(Number(m[1]));
    }
  } catch {}
  return ports;
}

async function freePort(used) {
  for (let port = FIRST_PORT; port < FIRST_PORT + 1000; port += 1) {
    if (used.has(port)) continue;
    if (await portFree(port)) return port;
  }
  throw new Error("Could not find a free port on this computer.");
}

/*
 * The script is downloaded into a private folder of its own: install.sh
 * deletes the folder it was started from when that folder looks like an
 * unpacked mvmOS release, and an empty temporary folder never does.
 */
async function installerText() {
  const res = await fetch(INSTALLER_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not download the mvmOS installer (HTTP ${res.status}).`);
  // Saved on Windows, it may have picked up line endings bash cannot run.
  const text = (await res.text()).replace(/\r\n/g, "\n");
  if (!text.includes("--uninstall")) {
    throw new Error("The mvmOS installer that was downloaded is older than this app expects. Try again later.");
  }
  return text;
}

async function downloadInstaller() {
  const text = await installerText();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mvmos-installer-"));
  const file = path.join(dir, "install.sh");
  fs.writeFileSync(file, text, { mode: 0o700 });
  return { dir, file };
}

/** Runs a command as root through pkexec, passing every output line on. */
function runAsRoot(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn("pkexec", args, { stdio: ["ignore", "pipe", "pipe"] });
    const tail = [];
    let pending = "";
    const take = (chunk) => {
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const raw of lines) {
        const line = raw.replace(/\s+$/, "");
        if (!line) continue;
        tail.push(line);
        if (tail.length > 20) tail.shift();
        if (onLine) onLine(line);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => reject(new Error(`Could not start pkexec: ${e.message}`)));
    child.on("close", (code) => {
      if (pending.trim()) take("\n");
      if (code === 0) {
        resolve(tail);
      } else if (PKEXEC_DISMISSED.has(code) && !tail.some((l) => /mvmOS|ERROR/.test(l))) {
        reject(new Error("The password was not entered, so nothing was changed."));
      } else {
        const reason = [...tail].reverse().find((l) => /ERROR/.test(l)) || tail[tail.length - 1];
        reject(new Error(reason ? reason.replace(/^\s*ERROR:\s*/, "") : `Failed with exit code ${code}.`));
      }
    });
  });
}

function waitUntilReady(port, isReachable) {
  const address = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      if (await isReachable(address)) return resolve(address);
      if (Date.now() > deadline) {
        return reject(new Error(`mvmOS was installed but does not answer on port ${port}.`));
      }
      setTimeout(attempt, 1500);
    };
    attempt();
  });
}

/**
 * Installs a new mvmOS and resolves with { service, port, address, lan } once
 * it answers, or with { restart: true } when Windows has to restart before it
 * can go on. `used` holds the ports of the other local installations, which
 * may be stopped and so not show up as busy.
 */
async function install({ displayName, used, lan, user, password, isReachable, onLine }) {
  if (busy) throw new Error("Another installation or removal is still running.");
  busy = true;
  let download = null;
  try {
    if (IS_WINDOWS) {
      const text = await installerText();
      const result = await wsl.install({
        serviceFor: (taken) => serviceFor(displayName, taken),
        firstPort: FIRST_PORT,
        used,
        user: String(user || "").trim(),
        password: String(password || ""),
        installerText: text,
        // Windows forwards 127.0.0.1 into WSL; other devices come in through
        // lan-proxy.js, which needs nothing from the service itself.
        host: LOCAL_HOST,
        onLine,
      });
      if (result.restart) return result;
      onLine("Waiting for mvmOS to start…");
      const address = await waitUntilReady(result.port, isReachable);
      return { service: result.service, port: result.port, address, lan: Boolean(lan) };
    }

    const { problems } = await check();
    if (problems.length) throw new Error(problems.join(" "));
    const service = serviceFor(displayName, takenHere);
    const port = await freePort(new Set([...used, ...servicePorts()]));
    onLine(`Installing ${service} on port ${port}…`);
    download = await downloadInstaller();
    await runAsRoot(
      ["/bin/bash", download.file, "--name", service, "--port", String(port), "--host", lan ? ANY_HOST : LOCAL_HOST, "--yes"],
      onLine,
    );
    onLine("Waiting for mvmOS to start…");
    const address = await waitUntilReady(port, isReachable);
    return { service, port, address, lan: false };
  } finally {
    if (download) fs.rmSync(download.dir, { recursive: true, force: true });
    busy = false;
  }
}

/*
 * The installation's own copy of install.sh is used when it knows how to
 * uninstall, since it is the one that installed it; it is copied out first,
 * because the folder it sits in is the one being deleted. `last` says no
 * other local installation is left, which on Windows removes the whole
 * Linux it lived in.
 */
async function uninstall(local, { last = false, onLine } = {}) {
  const { service } = local;
  if (!SERVICE_PATTERN.test(service)) throw new Error("Not an mvmOS installation name.");
  if (busy) throw new Error("Another installation or removal is still running.");
  busy = true;
  let download = null;
  try {
    if (IS_WINDOWS) {
      await wsl.uninstall(service, { installerText, last, onLine });
      return;
    }
    const own = `/opt/${service}/install.sh`;
    let ownText = "";
    try {
      ownText = fs.readFileSync(own, "utf8");
    } catch {}
    if (ownText.includes("--uninstall")) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mvmos-installer-"));
      const file = path.join(dir, "install.sh");
      fs.writeFileSync(file, ownText, { mode: 0o700 });
      download = { dir, file };
    } else {
      download = await downloadInstaller();
    }
    await runAsRoot(["/bin/bash", download.file, "--uninstall", "--name", service, "--yes"], onLine);
  } finally {
    if (download) fs.rmSync(download.dir, { recursive: true, force: true });
    busy = false;
  }
}

async function status(local) {
  if (!SERVICE_PATTERN.test(local.service)) return "unknown";
  if (IS_WINDOWS) return wsl.status(local.service);
  const r = await run("systemctl", ["is-active", `${local.service}.service`]);
  return r.stdout.trim() || "unknown";
}

async function setRunning(local, running) {
  if (!SERVICE_PATTERN.test(local.service)) throw new Error("Not an mvmOS installation name.");
  if (IS_WINDOWS) return wsl.setRunning(local.service, running);
  await runAsRoot(["systemctl", running ? "start" : "stop", `${local.service}.service`]);
}

/** This computer's addresses in its networks, which other devices open. */
function lanAddresses() {
  if (IS_WINDOWS) return lanProxy.lanAddresses();
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    // Containers and virtual machines have networks of their own that no
    // phone is part of.
    if (/^(docker|br-|veth|virbr|lxc|lxd|tun|tap|wg)/.test(name)) continue;
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** Whether other devices can open the installation, read from its service. */
function network(local) {
  if (!SERVICE_PATTERN.test(local.service)) throw new Error("Not an mvmOS installation name.");
  if (IS_WINDOWS) return { lan: local.lan === true, addresses: lanAddresses() };
  let unit = "";
  try {
    unit = fs.readFileSync(`/etc/systemd/system/${local.service}.service`, "utf8");
  } catch {}
  const host = (unit.match(/--host\s+(\S+)/) || [])[1] || ANY_HOST;
  return { lan: host !== LOCAL_HOST && host !== "::1", addresses: lanAddresses() };
}

/*
 * Changes the address the service listens on and restarts it if it runs; a
 * stopped installation stays stopped. The service name and the address are
 * passed as arguments, never put into the script.
 */
const SET_HOST_SCRIPT = [
  'f="/etc/systemd/system/$1.service"',
  'grep -qx "WorkingDirectory=/opt/$1" "$f" || { echo "ERROR: $1 is not an mvmOS installation."; exit 1; }',
  'sed -i -E "s/--host [^ ]+/--host $2/" "$f"',
  "systemctl daemon-reload",
  'systemctl try-restart "$1.service"',
].join("\n");

/*
 * On Windows nothing in the installation changes: this app starts or stops
 * letting other devices in, which needs no password. The caller saves `lan`
 * and calls applyNetwork() with the new list.
 */
async function setNetwork(local, lan) {
  if (!SERVICE_PATTERN.test(local.service)) throw new Error("Not an mvmOS installation name.");
  if (IS_WINDOWS) return { lan: Boolean(lan), addresses: lanAddresses() };
  if (busy) throw new Error("Another installation or removal is still running.");
  busy = true;
  try {
    await runAsRoot(["/bin/sh", "-c", SET_HOST_SCRIPT, "sh", local.service, lan ? ANY_HOST : LOCAL_HOST]);
  } finally {
    busy = false;
  }
  return network(local);
}

/** Opens the ports of the installations other devices may use (Windows). */
function applyNetwork(map) {
  if (!IS_WINDOWS) return;
  lanProxy.setPorts(Object.values(map).filter((l) => l.lan).map((l) => l.port));
}

/** When the app starts: on Windows the mvmOS Linux runs while the app does. */
function startup(map) {
  if (!IS_WINDOWS || !Object.keys(map).length) return;
  void wsl.startup();
  applyNetwork(map);
}

function shutdown() {
  if (!IS_WINDOWS) return;
  lanProxy.setPorts([]);
  wsl.release();
}

module.exports = {
  supported, platform, load, save, check, install, uninstall, status, setRunning,
  network, setNetwork, applyNetwork, startup, shutdown,
};
