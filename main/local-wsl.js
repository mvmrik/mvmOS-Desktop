"use strict";

/*
 * mvmOS on a Windows computer. mvmOS needs Linux - systemd, root, a real
 * terminal - so on Windows it lives in a Linux that Windows itself runs with
 * WSL: a distribution of its own named "mvmOS", made from the official
 * Ubuntu 24.04 WSL image, so the user's own WSL distributions are never
 * touched. Inside it every installation is exactly what it is on Linux: the
 * project's own install.sh, a folder /opt/<service>, a systemd service and a
 * port. Windows forwards that port to its own 127.0.0.1, which is where the
 * tab opens it.
 *
 * WSL stops a distribution shortly after the last Windows program using it
 * goes away, services or not, so this app keeps one idle process in it while
 * it runs: mvmOS on Windows runs while mvmOS Desktop is open.
 *
 * Nothing here needs a terminal. Turning WSL on in Windows is the one step
 * that needs administrator rights; it shows the normal Windows permission
 * prompt, and may need a restart, after which Install continues.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const DISTRO = "mvmOS";
// Written into the distribution when this app creates it; a distribution of
// the same name without it belongs to someone else and is left alone.
const MARKER = "/etc/mvmos-desktop";
const ROOTFS_BASE = "https://cloud-images.ubuntu.com/wsl/releases/noble/current/";
// Windows 10 version 2004 is the first that runs WSL 2.
const MIN_BUILD = 19041;
// Ubuntu, Python packages and mvmOS itself, with room for its data.
const MIN_FREE_BYTES = 4 * 1024 ** 3;
// The exit code of a Windows permission prompt that was answered with No.
const ERROR_CANCELLED = 1223;
const RESTART_REQUIRED = 3010;

const SYSTEM32 = path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32");
const WSL = path.join(SYSTEM32, "wsl.exe");
const POWERSHELL = path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");
const SC = path.join(SYSTEM32, "sc.exe");

const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
// Accounts every Ubuntu already has; a new user cannot take their names.
const SYSTEM_USERS = new Set([
  "root", "daemon", "bin", "sys", "sync", "games", "man", "lp", "mail", "news", "uucp", "proxy",
  "www-data", "backup", "list", "irc", "gnats", "nobody", "systemd-network", "systemd-resolve",
  "messagebus", "systemd-timesync", "syslog", "uuidd", "tcpdump", "sshd", "polkitd", "ubuntu",
  "admin", "sudo", "users", "mvmos",
]);

function dataDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "mvmOS Desktop", "wsl");
}

function distroDir() {
  return path.join(dataDir(), DISTRO);
}

/*
 * A distribution is this app's when it carries the marker, or when its disk
 * is in this app's own folder - which also covers one whose setup was cut
 * short before the marker was written.
 */
function ownsDisk() {
  return fs.existsSync(path.join(distroDir(), "ext4.vhdx"));
}

/*
 * wsl.exe writes its own messages in UTF-16 unless WSL_UTF8 is set, which
 * older versions ignore; what Linux programs print is UTF-8. Both turn up.
 */
function decode(buffer) {
  if (!buffer.length) return "";
  let zeros = 0;
  for (let i = 1; i < buffer.length; i += 2) if (buffer[i] === 0) zeros += 1;
  const text = zeros > buffer.length / 4 ? buffer.toString("utf16le") : buffer.toString("utf8");
  return text.replace(/^\uFEFF/, "").replace(/\0/g, "");
}

/**
 * Runs a Windows program without a console window and resolves with its exit
 * code and output; it never rejects. `input` is written to its stdin, and
 * `onLine` receives every line as it arrives.
 */
function exec(file, args, { input, timeout = 0, onLine } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: -1, out: e.message });
      return;
    }
    const chunks = [];
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const take = (chunk) => {
      chunks.push(chunk);
      if (!onLine) return;
      pending += decoder.write(chunk).replace(/\0/g, "");
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop();
      for (const line of lines) if (line.trim()) onLine(line.replace(/\s+$/, ""));
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timer = null;
    if (timeout) timer = setTimeout(() => child.kill(), timeout);
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, out: e.message });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (onLine && pending.trim()) onLine(pending.trim());
      resolve({ code: code === null ? -1 : code, out: decode(Buffer.concat(chunks)) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input === undefined ? "" : input);
  });
}

/** A command inside the mvmOS distribution, as root. */
function inDistro(args, options) {
  return exec(WSL, ["-d", DISTRO, "-u", "root", "--exec", ...args], options);
}

/*
 * A script is copied into the distribution and run from there rather than fed
 * to bash on stdin, where apt and the installer would read it as their input.
 * Its arguments are plain names, numbers and addresses, never user text.
 */
async function runScript(name, text, args = [], options = {}) {
  const file = `/root/.mvmos-desktop-${name}.sh`;
  const put = await inDistro(["/usr/bin/tee", file], { input: text, timeout: 60000 });
  if (put.code !== 0) return { code: put.code, out: put.out };
  const result = await inDistro(["/bin/bash", file, ...args], options);
  await inDistro(["/bin/rm", "-f", file], { timeout: 30000 });
  return result;
}

function lastError(out, fallback) {
  const lines = String(out || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const marked = [...lines].reverse().find((l) => /ERROR/.test(l));
  const line = marked || lines[lines.length - 1];
  return line ? line.replace(/^\s*ERROR:\s*/, "") : fallback;
}

/*
 * WSL's own error messages are in the language of Windows, but they carry an
 * error code that is not. The common ones get a sentence the user can act on.
 */
function explainWslError(out, fallback) {
  const text = String(out || "");
  if (/0x80370102|HCS_E_HYPERV_NOT_INSTALLED/i.test(text)) {
    return "Windows cannot start the Linux part of WSL because virtualization is turned off. Turn on virtualization (often called Intel VT-x, AMD-V or SVM) in this computer's BIOS or UEFI settings, then click Install again. In a virtual machine, nested virtualization has to be enabled.";
  }
  if (/0x80370114|0x8007019e|0x80070422/i.test(text)) {
    return "A part of Windows that WSL needs is turned off. Click Install again to turn it on, then restart the computer.";
  }
  if (/0x800701bc/i.test(text)) {
    return "WSL needs an update. Click Install again to update it.";
  }
  if (/0x80070070|ERROR_DISK_FULL/i.test(text)) {
    return "There is not enough free disk space for the mvmOS Linux.";
  }
  return lastError(text, fallback);
}

function windowsBuild() {
  return Number(String(os.release()).split(".")[2]) || 0;
}

/** The processor of Windows itself, also when this app runs emulated on ARM. */
function nativeArch() {
  const values = [process.env.PROCESSOR_ARCHITEW6432, process.env.PROCESSOR_ARCHITECTURE];
  try {
    values.push(os.machine());
  } catch {}
  if (values.some((v) => /arm64|aarch64/i.test(String(v || "")))) return "arm64";
  if (values.some((v) => /amd64|x86_64|x64/i.test(String(v || "")))) return "amd64";
  return null;
}

async function serviceExists(name) {
  return (await exec(SC, ["query", name], { timeout: 15000 })).code === 0;
}

/*
 * The current WSL - the one from the Microsoft Store, which runs systemd -
 * knows --version; the old one built into Windows 10 does not. Virtual
 * Machine Platform, which WSL 2 runs on, shows up as the vmcompute service.
 */
async function wslState() {
  const hasExe = fs.existsSync(WSL);
  const modern = hasExe && (await exec(WSL, ["--version"], { timeout: 20000 })).code === 0;
  const platform = await serviceExists("vmcompute");
  return { ready: modern && platform, modern, platform };
}

async function distroNames() {
  if (!fs.existsSync(WSL)) return [];
  const r = await exec(WSL, ["--list", "--quiet"], { timeout: 20000 });
  if (r.code !== 0) return [];
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function distroExists() {
  return (await distroNames()).some((n) => n.toLowerCase() === DISTRO.toLowerCase());
}

/*
 * Everything this app needs to know from inside the distribution in one
 * call: whether it is ours, whether systemd runs, its people, the mvmOS
 * services with their ports and the ports in use.
 */
const STATE_SCRIPT = `
[ -e ${MARKER} ] && echo "marker=1"
[ "$(ps -o comm= -p 1 2>/dev/null)" = systemd ] && echo "systemd=1"
getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 { print "user=" $1 }'
for f in /etc/systemd/system/mvmos*.service; do
  [ -e "$f" ] || continue
  p=$(sed -nE 's/.*--port ([0-9]+).*/\\1/p' "$f" | head -n 1)
  echo "service=$(basename "$f" .service):$p"
done
for d in /opt/mvmos*; do [ -e "$d" ] && echo "dir=$(basename "$d")"; done
for p in $(sed -nE 's/^port *= *([0-9]+).*/\\1/p' /opt/mvmos*/config.ini 2>/dev/null); do echo "port=$p"; done
ss -Hltn 2>/dev/null | awk '{ n = split($4, a, ":"); print "port=" a[n] }'
exit 0
`;

async function distroState() {
  const r = await runScript("state", STATE_SCRIPT, [], { timeout: 120000 });
  const state = { ok: r.code === 0, ours: false, systemd: false, users: [], services: [], dirs: [], ports: new Set() };
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\w+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "marker") state.ours = true;
    else if (key === "systemd") state.systemd = true;
    else if (key === "user") state.users.push(value);
    else if (key === "dir") state.dirs.push(value);
    else if (key === "service") {
      const [name, port] = value.split(":");
      state.services.push(name);
      if (Number(port)) state.ports.add(Number(port));
    } else if (key === "port" && Number(value)) state.ports.add(Number(value));
  }
  return state;
}

function suggestedUser() {
  let name = "";
  try {
    name = os.userInfo().username;
  } catch {}
  name = String(name || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9_-]+/g, "").replace(/^[^a-z_]+/, "").slice(0, 32);
  return name && !SYSTEM_USERS.has(name) ? name : "";
}

function freeBytes(dir) {
  try {
    let probe = dir;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const s = fs.statfsSync(probe);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

/**
 * What stops an installation (`problems`), what it will do first (`notes`)
 * and whether a Linux user has to be created for signing in.
 */
async function check() {
  const problems = [];
  const notes = [];
  if (windowsBuild() < MIN_BUILD) {
    problems.push("mvmOS on this computer needs Windows 10 version 2004 or newer, or Windows 11. Update Windows first with Windows Update.");
    return { problems, notes, needUser: false, users: [] };
  }
  if (!nativeArch()) {
    problems.push("mvmOS on this computer needs a 64-bit Windows.");
    return { problems, notes, needUser: false, users: [] };
  }
  const wsl = await wslState();
  const exists = wsl.modern && (await distroExists());
  let users = [];
  if (exists) {
    const state = await distroState();
    if (!state.ours && !ownsDisk()) {
      problems.push(`A WSL Linux named ${DISTRO} already exists that this app did not create. Remove or rename it in WSL first.`);
    }
    users = state.users;
  } else if (freeBytes(dataDir()) < MIN_FREE_BYTES) {
    problems.push("mvmOS needs about 4 GB of free disk space on the drive with your user folder.");
  }
  if (!wsl.ready) {
    notes.push("First Windows turns on WSL, the part of Windows that runs Linux. Windows asks for permission, and you may have to restart the computer and click Install again.");
  }
  if (!exists) {
    notes.push("The first installation also downloads Ubuntu Linux, about 360 MB, for mvmOS to run in.");
  }
  return { problems, notes, needUser: users.length === 0, users, suggestedUser: suggestedUser() };
}

/* ------------------------------------------------- Windows administrator */

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/*
 * Runs a PowerShell script as administrator behind the normal Windows
 * permission prompt. Its output goes to a file, since an elevated process has
 * no way back into this one, and is passed on once it has finished.
 */
async function runElevated(script, onLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mvmos-elevated-"));
  const log = path.join(dir, "log.txt");
  const inner = [
    "$global:mvmosExit = 0",
    "$env:WSL_UTF8 = '1'",
    `& { ${script} } *>&1 | Out-File -FilePath ${psString(log)} -Encoding utf8 -Append`,
    "exit $global:mvmosExit",
  ].join("\n");
  const outer = [
    "try {",
    `  $p = Start-Process -FilePath ${psString(POWERSHELL)} -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand','${encodePowerShell(inner)}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    "  exit $p.ExitCode",
    `} catch { exit ${ERROR_CANCELLED} }`,
  ].join("\n");
  try {
    const r = await exec(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(outer)]);
    let text = "";
    try {
      text = decode(fs.readFileSync(log));
    } catch {}
    for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    if (r.code === ERROR_CANCELLED) {
      throw new Error("Windows did not get permission, so nothing was changed.");
    }
    return { code: r.code, out: text };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/*
 * Turns on what WSL 2 needs and brings WSL up to the current version, the one
 * that runs systemd. A Windows feature that was just turned on, or one that
 * was turned on earlier without the restart it asked for, only works after a
 * restart, so the update waits for the next attempt in that case.
 *
 * `wsl --update` needs a WSL that is already fairly new; the one built into
 * older Windows 10 does not know it. The installer that Microsoft publishes
 * for WSL on GitHub is then installed directly.
 */
const ENABLE_WSL_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$restart = $false
foreach ($feature in @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux')) {
  $state = (Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction SilentlyContinue).State
  if ("$state" -eq 'Enabled') { continue }
  if ("$state" -eq 'EnablePending') { $restart = $true; continue }
  Write-Output "Turning on $feature..."
  & dism.exe /online /enable-feature /featurename:$feature /all /norestart /quiet
  if ($LASTEXITCODE -eq 3010) { $restart = $true }
  elseif ($LASTEXITCODE -ne 0) { Write-Output "ERROR: Windows could not turn on $feature (code $LASTEXITCODE). Run Windows Update, restart the computer, then try again."; $global:mvmosExit = 1; return }
}
if ($restart) { $global:mvmosExit = 3010; return }
Write-Output "Updating WSL..."
& wsl.exe --update
if ($LASTEXITCODE -ne 0) { & wsl.exe --update --web-download }
if ($LASTEXITCODE -ne 0) {
  Write-Output "Downloading WSL from Microsoft..."
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }
    $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/microsoft/WSL/releases/latest' -Headers @{ 'User-Agent' = 'mvmOS-Desktop' }
    $asset = $release.assets | Where-Object { $_.name -like "*.$arch.msi" } | Select-Object -First 1
    if (-not $asset) { throw 'No WSL installer for this processor.' }
    $msi = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $msi
    Write-Output "Installing WSL..."
    $p = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', ('"' + $msi + '"'), '/qn', '/norestart') -Wait -PassThru
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    if ($p.ExitCode -eq 3010) { $global:mvmosExit = 3010; return }
    if ($p.ExitCode -ne 0) { throw "The WSL installer ended with code $($p.ExitCode)." }
  } catch {
    Write-Output "$_"
    Write-Output "ERROR: WSL could not be installed or updated. Run Windows Update, restart the computer, then click Install again."
    $global:mvmosExit = 2
    return
  }
}
`;

/** Resolves true when WSL is ready, false when Windows has to restart first. */
async function ensureWsl(onLine) {
  if ((await wslState()).ready) return true;
  onLine("Turning on WSL in Windows. Windows asks for permission…");
  const r = await runElevated(ENABLE_WSL_SCRIPT, onLine);
  if (r.code === RESTART_REQUIRED) return false;
  if (r.code !== 0) throw new Error(lastError(r.out, `Turning on WSL failed with code ${r.code}.`));
  // The script has checked the Windows features itself, so a current WSL is
  // all that is left to see.
  if ((await wslState()).modern) return true;
  throw new Error("WSL is still not ready. Run Windows Update, restart the computer, then click Install again.");
}

/* ------------------------------------------------------ the mvmOS Linux */

async function downloadUbuntu(dir, onLine) {
  const arch = nativeArch();
  const name = `ubuntu-noble-wsl-${arch}-wsl.rootfs.tar.gz`;
  const sumsRes = await fetch(`${ROOTFS_BASE}SHA256SUMS`, { cache: "no-store" });
  if (!sumsRes.ok) throw new Error(`Could not download Ubuntu (HTTP ${sumsRes.status}).`);
  const line = (await sumsRes.text()).split(/\r?\n/).find((l) => l.trim().endsWith(` ${name}`)) || "";
  const expected = line.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("Could not find the Ubuntu image to download.");

  const res = await fetch(`${ROOTFS_BASE}${name}`, { cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`Could not download Ubuntu (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const file = path.join(dir, "ubuntu.rootfs.tar.gz");
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(file);
  let got = 0;
  let shown = -1;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await once(out, "drain");
      const step = total ? Math.floor((got / total) * 10) : -1;
      if (step > shown) {
        shown = step;
        onLine(`Downloading Ubuntu… ${step * 10}%`);
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  if (hash.digest("hex") !== expected) {
    fs.rmSync(file, { force: true });
    throw new Error("The Ubuntu download was damaged. Click Install to try again.");
  }
  return file;
}

const WSL_CONF = `[boot]
systemd=true

[user]
default=root

[interop]
appendWindowsPath=false
`;

/*
 * Idempotent: also repairs a distribution whose earlier preparation was cut
 * short. It prints RESTART when wsl.conf changed, which only takes effect
 * after the distribution starts again.
 */
const PREPARE_SCRIPT = `
touch ${MARKER}
want='${WSL_CONF}'
if [ "$(cat /etc/wsl.conf 2>/dev/null)" != "$(printf '%s' "$want")" ]; then
  printf '%s' "$want" > /etc/wsl.conf
  echo RESTART
fi
# Nothing for cloud-init to set up here, and it slows down every start.
[ -d /etc/cloud ] && touch /etc/cloud/cloud-init.disabled
exit 0
`;

const WAIT_SYSTEMD_SCRIPT = `
for i in $(seq 1 120); do
  if [ "$(ps -o comm= -p 1 2>/dev/null)" = systemd ]; then
    case "$(systemctl is-system-running 2>/dev/null)" in
      running|degraded) exit 0 ;;
    esac
  fi
  sleep 1
done
[ "$(ps -o comm= -p 1 2>/dev/null)" = systemd ] && exit 0
echo "ERROR: systemd did not start in the mvmOS Linux. Update WSL with Windows Update and try again."
exit 1
`;

// Ubuntu keeps venv and ensurepip in a package of their own, which install.sh
// installs without refreshing the package lists that a new image lacks.
const PACKAGES_SCRIPT = `
export DEBIAN_FRONTEND=noninteractive
systemctl mask --now snapd.service snapd.socket snapd.seeded.service >/dev/null 2>&1 || true
if ! python3 -c 'import ensurepip, venv' >/dev/null 2>&1; then
  echo "Installing Python tools in the mvmOS Linux…"
  if ! apt-get update -q </dev/null; then
    echo "ERROR: The mvmOS Linux could not reach the internet to download packages. A VPN, proxy or firewall may be blocking WSL."
    exit 1
  fi
  apt-get install -y -q python3-venv </dev/null || { echo "ERROR: Python tools could not be installed in the mvmOS Linux."; exit 1; }
fi
exit 0
`;

async function terminate() {
  await exec(WSL, ["--terminate", DISTRO], { timeout: 60000 });
}

async function createDistro(onLine) {
  const base = dataDir();
  fs.mkdirSync(base, { recursive: true });
  // Not registered, so whatever is left there is from an attempt that failed.
  fs.rmSync(distroDir(), { recursive: true, force: true });
  fs.mkdirSync(distroDir(), { recursive: true });
  const download = fs.mkdtempSync(path.join(base, "download-"));
  try {
    const file = await downloadUbuntu(download, onLine);
    onLine("Setting up Ubuntu in WSL…");
    const r = await exec(WSL, ["--import", DISTRO, distroDir(), file, "--version", "2"], { onLine });
    if (r.code !== 0) throw new Error(explainWslError(r.out, `Ubuntu could not be set up in WSL (code ${r.code}).`));
    await inDistro(["/usr/bin/touch", MARKER], { timeout: 120000 });
  } finally {
    fs.rmSync(download, { recursive: true, force: true });
  }
}

/** Creates or repairs the distribution until systemd runs in it. */
async function prepareDistro(onLine) {
  if (!(await distroExists())) await createDistro(onLine);
  const state = await distroState();
  if (!state.ok) throw new Error(explainWslError("", "The mvmOS Linux does not start."));
  if (!state.ours && !ownsDisk()) throw new Error(`A WSL Linux named ${DISTRO} already exists that this app did not create.`);
  const prepared = await runScript("prepare", PREPARE_SCRIPT, [], { timeout: 120000 });
  if (prepared.code !== 0) throw new Error(explainWslError(prepared.out, "The mvmOS Linux could not be prepared."));
  if (/RESTART/.test(prepared.out) || !state.systemd) {
    onLine("Starting the mvmOS Linux…");
    await terminate();
  }
  const waited = await runScript("wait", WAIT_SYSTEMD_SCRIPT, [], { timeout: 180000 });
  if (waited.code !== 0) throw new Error(explainWslError(waited.out, "systemd did not start in the mvmOS Linux."));
  const packages = await runScript("packages", PACKAGES_SCRIPT, [], { timeout: 900000, onLine });
  if (packages.code !== 0) throw new Error(lastError(packages.out, "Python tools could not be installed in the mvmOS Linux."));
}

function validateUser(name, password) {
  if (!USER_PATTERN.test(name || "")) {
    return "The Linux user name may contain small letters a-z, digits, - and _, and has to start with a letter.";
  }
  if (SYSTEM_USERS.has(name)) return `"${name}" is already used by Linux itself. Choose another user name.`;
  if (!password) return "Choose a password for the Linux user.";
  if (/[\r\n]/.test(password)) return "The password cannot contain line breaks.";
  return null;
}

/*
 * The first person of the mvmOS Linux, in the sudo group, which makes them an
 * administrator in mvmOS. The password goes to chpasswd on its stdin, never
 * into a command line.
 */
async function createUser(name, password, onLine) {
  onLine(`Creating the Linux user ${name}…`);
  const added = await inDistro(["/usr/sbin/useradd", "-m", "-s", "/bin/bash", "-G", "sudo", name], { timeout: 60000 });
  if (added.code !== 0) throw new Error(lastError(added.out, `The Linux user ${name} could not be created.`));
  const set = await inDistro(["/usr/sbin/chpasswd"], { input: `${name}:${password}\n`, timeout: 60000 });
  if (set.code !== 0) throw new Error(lastError(set.out, "The password could not be set."));
}

/* ------------------------------------------------------------ keep alive */

let keeper = null;
let keepWanted = false;
let keepTimer = null;

function keepAlive() {
  keepWanted = true;
  if (keeper || keepTimer) return;
  try {
    keeper = spawn(WSL, ["-d", DISTRO, "-u", "root", "--exec", "/bin/sleep", "infinity"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    keeper = null;
    return;
  }
  keeper.on("error", () => {});
  keeper.on("exit", () => {
    keeper = null;
    // `wsl --shutdown` or a WSL update ends it too; the installations come
    // back once it runs again.
    if (keepWanted) {
      keepTimer = setTimeout(() => {
        keepTimer = null;
        if (keepWanted) keepAlive();
      }, 10000);
    }
  });
}

function release() {
  keepWanted = false;
  if (keepTimer) clearTimeout(keepTimer);
  keepTimer = null;
  if (keeper) keeper.kill();
  keeper = null;
}

/* --------------------------------------------------------- installations */

function portFree(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function freePort(firstPort, used) {
  for (let port = firstPort; port < firstPort + 1000; port += 1) {
    if (used.has(port)) continue;
    if ((await portFree(port, "127.0.0.1")) && (await portFree(port, "0.0.0.0"))) return port;
  }
  throw new Error("Could not find a free port on this computer.");
}

async function writeInstaller(text) {
  const r = await inDistro(["/usr/bin/tee", "/root/.mvmos-desktop-install.sh"], { input: text, timeout: 60000 });
  if (r.code !== 0) throw new Error(lastError(r.out, "The installer could not be copied into the mvmOS Linux."));
}

async function runInstaller(args, onLine) {
  const r = await inDistro(["/bin/bash", "/root/.mvmos-desktop-install.sh", ...args], { onLine });
  await inDistro(["/bin/rm", "-f", "/root/.mvmos-desktop-install.sh"], { timeout: 30000 });
  if (r.code !== 0) throw new Error(lastError(r.out, `Failed with exit code ${r.code}.`));
}

/**
 * Resolves with { service, port } once install.sh has finished, or with
 * { restart: true } when Windows has to restart before WSL works.
 */
async function install({ serviceFor, firstPort, used, user, password, installerText, host, onLine }) {
  const checked = await check();
  if (checked.problems.length) throw new Error(checked.problems.join(" "));
  if (checked.needUser) {
    const invalid = validateUser(user, password);
    if (invalid) throw new Error(invalid);
  }
  if (!(await ensureWsl(onLine))) return { restart: true };
  await prepareDistro(onLine);
  keepAlive();

  const state = await distroState();
  if (!state.users.length) {
    const invalid = validateUser(user, password);
    if (invalid) throw new Error(invalid);
    await createUser(user, password, onLine);
  }
  const taken = new Set([...state.services, ...state.dirs]);
  const service = serviceFor((candidate) => taken.has(candidate));
  const port = await freePort(firstPort, new Set([...used, ...state.ports]));
  onLine(`Installing ${service} on port ${port}…`);
  await writeInstaller(installerText);
  await runInstaller(["--name", service, "--port", String(port), "--host", host, "--yes"], onLine);
  return { service, port };
}

/*
 * The installation's own install.sh is used when it knows how to uninstall.
 * When the last one is gone the whole mvmOS Linux goes too, so nothing of it
 * is left on the computer.
 */
async function uninstall(service, { installerText, last, onLine }) {
  if (!(await distroExists())) {
    onLine("The mvmOS Linux is no longer on this computer.");
    return;
  }
  const copied = await inDistro(["/bin/cp", `/opt/${service}/install.sh`, "/root/.mvmos-desktop-install.sh"], { timeout: 60000 });
  const knows = copied.code === 0
    && (await inDistro(["/bin/grep", "-q", "UNINSTALL", "/root/.mvmos-desktop-install.sh"], { timeout: 30000 })).code === 0;
  if (!knows) await writeInstaller(await installerText());
  await runInstaller(["--uninstall", "--name", service, "--yes"], onLine);

  if (!last) return;
  const state = await distroState();
  if (!(state.ours || ownsDisk()) || state.services.length || state.dirs.length) return;
  onLine("Removing the mvmOS Linux from this computer…");
  release();
  await terminate();
  const r = await exec(WSL, ["--unregister", DISTRO], { timeout: 180000 });
  if (r.code !== 0) {
    onLine(`The mvmOS Linux could not be removed: ${lastError(r.out, `code ${r.code}`)}`);
    return;
  }
  fs.rmSync(distroDir(), { recursive: true, force: true });
}

async function status(service) {
  if (!(await distroExists())) return "unknown";
  const r = await inDistro(["/usr/bin/systemctl", "is-active", `${service}.service`], { timeout: 60000 });
  return r.out.trim().split(/\s+/).pop() || "unknown";
}

async function setRunning(service, running) {
  if (!(await distroExists())) throw new Error("The mvmOS Linux is no longer on this computer.");
  if (running) keepAlive();
  const r = await inDistro(["/usr/bin/systemctl", running ? "start" : "stop", `${service}.service`], { timeout: 120000 });
  if (r.code !== 0) throw new Error(lastError(r.out, `Failed with exit code ${r.code}.`));
}

/** Starts the mvmOS Linux when the app starts, if there is anything in it. */
async function startup() {
  if (await distroExists()) keepAlive();
}

module.exports = {
  check, install, uninstall, status, setRunning, startup, release, keepAlive, validateUser,
};
