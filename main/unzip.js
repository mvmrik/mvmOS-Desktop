"use strict";

/*
 * A zip reader, so an extension can be added from the file it was downloaded
 * as instead of from a folder the user unpacked by hand.
 *
 * Node ships the inflate half of this already; what is missing is the archive
 * index, which is about a hundred lines of fixed-width records. That is a
 * cheaper price than a dependency for something that runs a handful of times
 * in an app's life.
 *
 * .crx is the same zip with a signature glued in front: Chromium refuses to
 * install one outside a real browser, but nothing stops us from unpacking it
 * and loading the result as an unpacked extension.
 */

const fs = require("node:fs");
const path = require("node:path");
const { inflateRawSync } = require("node:zlib");

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const CRX_MAGIC = "Cr24";

/** Where the zip starts inside a .crx, or 0 for a plain zip. */
function zipStart(buffer) {
  if (buffer.length < 16 || buffer.toString("latin1", 0, 4) !== CRX_MAGIC) return 0;
  const version = buffer.readUInt32LE(4);
  if (version === 3) return 12 + buffer.readUInt32LE(8);
  if (version === 2) return 16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12);
  // Unknown revision: the payload is still a zip, so find its first record.
  const at = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (at < 0) throw new Error("That .crx has no readable archive inside it.");
  return at;
}

/** The end-of-central-directory record lives in the last 64 KB, comment and all. */
function findEocd(buffer, from) {
  const earliest = Math.max(from, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= earliest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("That file is not a zip archive.");
}

/*
 * Names come from the archive, so they get the same treatment as any other
 * untrusted path: anything that would land outside the destination is refused
 * rather than sanitised, because a zip that tries it is not one to trust with
 * code execution afterwards.
 */
function safeJoin(destDir, name) {
  const target = path.resolve(destDir, name);
  const root = path.resolve(destDir) + path.sep;
  if (target !== path.resolve(destDir) && !target.startsWith(root)) {
    throw new Error(`Refusing to unpack outside the target folder: ${name}`);
  }
  return target;
}

/** Unpacks archivePath (.zip or .crx) into destDir, which is created if needed. */
function extract(archivePath, destDir) {
  const buffer = fs.readFileSync(archivePath);
  const base = zipStart(buffer);
  const eocd = findEocd(buffer, base);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  if (entryCount === 0xffff) throw new Error("Zip64 archives are not supported.");

  let at = base + buffer.readUInt32LE(eocd + 16);
  let written = 0;
  fs.mkdirSync(destDir, { recursive: true });

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(at) !== CENTRAL_SIG) throw new Error("The archive index is damaged.");
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = base + buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    // Chrome's own packer leaves these behind; they are metadata, not code.
    if (name.startsWith("__MACOSX/") || path.basename(name) === ".DS_Store") continue;

    const target = safeJoin(destDir, name);
    if (name.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`Damaged entry: ${name}`);
    // The local header repeats the name and can carry different extra fields,
    // so its own lengths are the ones that point at the data.
    const dataStart =
      localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let contents;
    if (method === 0) contents = raw;
    else if (method === 8) contents = inflateRawSync(raw);
    else throw new Error(`Unsupported compression in ${name}.`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    written += 1;
  }

  if (!written) throw new Error("The archive is empty.");
  return destDir;
}

/*
 * Extensions are sometimes zipped with the folder included and sometimes from
 * inside it; the manifest is what we actually need to point Chromium at.
 */
function findManifestRoot(dir) {
  if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
  const children = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
  for (const child of children) {
    if (fs.existsSync(path.join(child, "manifest.json"))) return child;
  }
  return null;
}

module.exports = { extract, findManifestRoot };
