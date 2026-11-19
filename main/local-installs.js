"use strict";

/*
 * mvmOS installed on this very computer, for people who would rather not open
 * a terminal. Nothing here knows how to install mvmOS: it runs the project's
 * own install.sh - the same script and the same steps as a manual install -
 * with options instead of questions, and runs it again with --uninstall to
 * remove one. Each installation gets its own folder /opt/<service>, its own
 * service and its own port, so several can live side by side.
 *
 * Only Linux for now: install.sh sets up a systemd service, and everything
 * that needs root goes through pkexec, which shows the desktop's own password
 * prompt.
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
  return process.platform === "linux";
}

function filePath() {
  return path.join(app.getPath("userData"), FILE);
}

/** { installationId: { service, port } } */
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    const out = {};
    if (parsed && typeof parsed === "object") {
      for (const [id, v] of Object.entries(parsed)) {
        if (v && SERVICE_PATTERN.test(v.service) && Number.isInteger(v.port)) {
          out[id] = { service: v.service, port: v.port };
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
 * What this computer is missing for a local installation, as sentences the
 * user can act on. An empty list means it can go ahead.
 */
async function check() {
  if (!supported()) return ["Installing mvmOS on this computer is available on Linux."];
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
  return problems;
}

function taken(service) {
  return fs.existsSync(`/opt/${service}`) || fs.existsSync(`/etc/systemd/system/${service}.service`);
}

/** "My mvmOS" -> "mvmos-my", or "mvmos-local" when nothing usable is left. */
function serviceFor(displayName) {
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
async function downloadInstaller() {
  const res = await fetch(INSTALLER_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not download the mvmOS installer (HTTP ${res.status}).`);
  const text = await res.text();
  if (!text.includes("--uninstall")) {
    throw new Error("The mvmOS installer that was downloaded is older than this app expects. Try again later.");
  }
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
 * Installs a new mvmOS and resolves with { service, port, address } once it
 * answers. `used` holds the ports of the other local installations, which may
 * be stopped and so not show up as busy.
 */
async function install({ displayName, used, lan, isReachable, onLine }) {
  if (busy) throw new Error("Another installation or removal is still running.");
  busy = true;
  let download = null;
  try {
    const problems = await check();
    if (problems.length) throw new Error(problems.join(" "));
    const service = serviceFor(displayName);
    const port = await freePort(used);
    onLine(`Installing ${service} on port ${port}…`);
    download = await downloadInstaller();
    await runAsRoot(
      ["/bin/bash", download.file, "--name", service, "--port", String(port), "--host", lan ? ANY_HOST : LOCAL_HOST, "--yes"],
      onLine,
    );
    onLine("Waiting for mvmOS to start…");
    const address = await waitUntilReady(port, isReachable);
    return { service, port, address };
  } finally {
    if (download) fs.rmSync(download.dir, { recursive: true, force: true });
    busy = false;
  }
}

/*
 * The installation's own copy of install.sh is used when it knows how to
 * uninstall, since it is the one that installed it; it is copied out first,
 * because the folder it sits in is the one being deleted.
 */
async function uninstall(service, onLine) {
  if (!SERVICE_PATTERN.test(service)) throw new Error("Not an mvmOS installation name.");
  if (busy) throw new Error("Another installation or removal is still running.");
  busy = true;
  let download = null;
  try {
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

async function status(service) {
  if (!SERVICE_PATTERN.test(service)) return "unknown";
  const r = await run("systemctl", ["is-active", `${service}.service`]);
  return r.stdout.trim() || "unknown";
}

async function setRunning(service, running) {
  if (!SERVICE_PATTERN.test(service)) throw new Error("Not an mvmOS installation name.");
  await runAsRoot(["systemctl", running ? "start" : "stop", `${service}.service`]);
}

/** This computer's addresses in its networks, which other devices open. */
function lanAddresses() {
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
function network(service) {
  if (!SERVICE_PATTERN.test(service)) throw new Error("Not an mvmOS installation name.");
  let unit = "";
  try {
    unit = fs.readFileSync(`/etc/systemd/system/${service}.service`, "utf8");
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

async function setNetwork(service, lan) {
  if (!SERVICE_PATTERN.test(service)) throw new Error("Not an mvmOS installation name.");
  if (busy) throw new Error("Another installation or removal is still running.");
  busy = true;
  try {
    await runAsRoot(["/bin/sh", "-c", SET_HOST_SCRIPT, "sh", service, lan ? ANY_HOST : LOCAL_HOST]);
  } finally {
    busy = false;
  }
  return network(service);
}

module.exports = {
  supported, load, save, check, install, uninstall, status, setRunning, network, setNetwork,
};
