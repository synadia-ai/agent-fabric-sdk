#!/usr/bin/env node
// Consume published releases. This loader has no compiler or source-checkout path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const TARGETS = [
  "darwin/arm64",
  "darwin/amd64",
  "linux/arm64",
  "linux/amd64",
];
export const MEMBERS = [
  "BUILD.json",
  "LICENSE",
  "README.md",
  "SKILL.md",
  "SOURCE",
  "THIRD_PARTY_NOTICES",
  "sp",
];
const REPOSITORY = "synadia-ai/agent-fabric-sdk";
const MODULE = "github.com/synadia-ai/agent-fabric-sdk/sp";
const MAX_BYTES = 64 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const encoded = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const archiveName = (manifest, target) =>
  `${manifest.release}-${target.replace("/", "-")}.tar.gz`;
export const binaryName = (target) => `sp-${target.replace("/", "-")}`;
const sameKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

export function readManifest(path = join(HERE, "release.json")) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  check(
    sameKeys(value, [
      "schema",
      "release",
      "repository",
      "source_commit",
      "go_version",
      "targets",
    ]),
    "release manifest fields differ",
  );
  check(
    value.schema === 1 && /^sp-v\d+\.\d+\.\d+$/.test(value.release),
    "invalid release manifest version",
  );
  check(value.repository === REPOSITORY, "unexpected distribution repository");
  check(
    /^[0-9a-f]{40}$/.test(value.source_commit),
    "invalid release source identifier",
  );
  check(
    /^go\d+\.\d+\.\d+$/.test(value.go_version),
    "invalid release toolchain",
  );
  check(sameKeys(value.targets, TARGETS), "unsupported release targets");
  for (const target of TARGETS) {
    const pin = value.targets[target];
    check(
      sameKeys(pin, ["archive_sha256", "binary_sha256"]),
      `invalid target pin: ${target}`,
    );
    check(
      HASH.test(pin.archive_sha256) && HASH.test(pin.binary_sha256),
      `invalid target checksum: ${target}`,
    );
    check(
      pin.archive_sha256 !== "0".repeat(64) &&
        pin.binary_sha256 !== "0".repeat(64),
      `release hashes are not populated: ${target}`,
    );
  }
  return value;
}

function octal(header, start, length) {
  const text = header
    .subarray(start, start + length)
    .toString("ascii")
    .replace(/\0.*$/s, "")
    .trim();
  check(/^[0-7]+$/.test(text), "invalid archive numeric field");
  const value = Number.parseInt(text, 8);
  check(Number.isSafeInteger(value), "archive numeric field is too large");
  return value;
}

// Releases use USTAR with seven top-level regular files. Read those bytes in
// memory; never ask an archive extractor to write untrusted paths or links.
export function readArchive(compressed) {
  check(compressed.length <= MAX_BYTES, "archive exceeds size limit");
  const tar = gunzipSync(compressed, { maxOutputLength: MAX_BYTES });
  check(tar.length % 512 === 0, "archive is not block aligned");
  const files = {};
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expected = octal(header, 148, 8);
    let sum = 0;
    for (let index = 0; index < 512; index++)
      sum += index >= 148 && index < 156 ? 32 : header[index];
    check(sum === expected, "archive header checksum differs");
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    check(
      MEMBERS.includes(name) && !Object.hasOwn(files, name),
      "archive file allowlist differs",
    );
    check(
      header[156] === 48 || header[156] === 0,
      "archive contains a non-regular member",
    );
    check(
      header.subarray(157, 257).every((byte) => byte === 0),
      "archive member has a link target",
    );
    check(
      header.subarray(345, 500).every((byte) => byte === 0),
      "archive member has a path prefix",
    );
    check(
      header.subarray(257, 263).toString("ascii") === "ustar\0",
      "archive is not USTAR",
    );
    const size = octal(header, 124, 12);
    check(
      size > 0 && offset + 512 + size <= tar.length,
      "archive member is empty or truncated",
    );
    check(
      octal(header, 100, 8) === (name === "sp" ? 0o755 : 0o644),
      "archive file mode differs",
    );
    const end = offset + 512 + size;
    files[name] = tar.subarray(offset + 512, end);
    offset += 512 + Math.ceil(size / 512) * 512;
    check(
      tar.subarray(end, offset).every((byte) => byte === 0),
      "archive member padding differs",
    );
  }
  check(
    tar.length - offset >= 1024 &&
      tar.subarray(offset).every((byte) => byte === 0),
    "archive end markers differ",
  );
  check(sameKeys(files, MEMBERS), "archive file allowlist differs");
  return files;
}

export function verifyArchive(bytes, manifest, target) {
  check(TARGETS.includes(target), `unsupported target: ${target}`);
  const pin = manifest.targets[target];
  check(
    digest(bytes) === pin.archive_sha256,
    `archive checksum differs: ${target}`,
  );
  const files = readArchive(bytes);
  check(
    digest(files.sp) === pin.binary_sha256,
    `binary checksum differs: ${target}`,
  );
  const source = {};
  const sourceFields = [
    "release",
    "source_commit",
    "go_version",
    "target",
    "binary_sha256",
  ];
  check(
    files.SOURCE.toString("utf8").endsWith("\n"),
    "SOURCE needs a final newline",
  );
  for (const line of files.SOURCE.toString("utf8").trimEnd().split("\n")) {
    const split = line.indexOf("=");
    const key = line.slice(0, split);
    check(
      split > 0 && sourceFields.includes(key) && !Object.hasOwn(source, key),
      "invalid or duplicate SOURCE field",
    );
    source[key] = line.slice(split + 1);
  }
  const identity = {
    release: manifest.release,
    source_commit: manifest.source_commit,
    go_version: manifest.go_version,
    target,
    binary_sha256: pin.binary_sha256,
  };
  assert.deepEqual(source, identity, "archive SOURCE identity differs");
  const build = JSON.parse(files["BUILD.json"].toString("utf8"));
  check(
    sameKeys(build, [
      "schema",
      ...Object.keys(identity),
      "binary_bytes",
      "build_info",
      "generic_skill_sha256",
      "license",
      "distribution_repository",
    ]),
    "archive BUILD fields differ",
  );
  for (const [key, value] of Object.entries(identity))
    check(build[key] === value, `archive BUILD ${key} differs`);
  check(
    build.schema === 1 && build.binary_bytes === files.sp.length,
    "archive BUILD size or schema differs",
  );
  check(
    build.license === "Apache-2.0" &&
      build.distribution_repository === REPOSITORY,
    "archive license or distribution differs",
  );
  check(
    HASH.test(build.generic_skill_sha256),
    "archive generic skill hash is invalid",
  );
  check(
    files.LICENSE.equals(readFileSync(join(HERE, "../../LICENSE"))),
    "archive must include the full Apache-2.0 LICENSE",
  );
  const info = build.build_info;
  check(
    info?.GoVersion === manifest.go_version &&
      info.Path === `${MODULE}/cmd/sp` &&
      info.Main?.Path === MODULE,
    "archive public module or toolchain differs",
  );
  check(Array.isArray(info.Settings), "archive build settings are missing");
  const settings = Object.fromEntries(
    info.Settings.map(({ Key, Value }) => [Key, Value]),
  );
  const [os, arch] = target.split("/");
  check(
    settings.GOOS === os &&
      settings.GOARCH === arch &&
      settings.CGO_ENABLED === "0" &&
      settings["-trimpath"] === "true",
    "archive build target or settings differ",
  );
  return { files, build };
}

function regularFile(path) {
  check(lstatSync(path).isFile(), `expected a regular file: ${path}`);
  return readFileSync(path);
}

async function publicDownload(url, redirects = 0) {
  check(new URL(url).protocol === "https:", "download requires HTTPS");
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(60000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    check(
      redirects < 5 && response.headers.has("location"),
      "download redirect limit exceeded",
    );
    await response.body?.cancel();
    return publicDownload(
      new URL(response.headers.get("location"), url).href,
      redirects + 1,
    );
  }
  check(
    response.ok,
    `download failed (${response.status}); use --download gh for an authenticated release`,
  );
  const chunks = [];
  let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    check(count <= MAX_BYTES, "download exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function loadRelease(manifest, options = {}) {
  const sourceDir = options.sourceDir && resolve(options.sourceDir);
  const cache = resolve(
    options.cacheDir || join(HERE, "downloads"),
    manifest.release,
  );
  const mode = options.download || "public";
  check(mode === "public" || mode === "gh", "--download must be public or gh");
  if (sourceDir)
    check(
      lstatSync(sourceDir).isDirectory(),
      "archive source must be a directory",
    );
  else {
    mkdirSync(dirname(cache), { recursive: true });
    check(
      lstatSync(dirname(cache)).isDirectory(),
      "cache parent must be a directory",
    );
    if (existsSync(cache))
      check(lstatSync(cache).isDirectory(), "cache must be a directory");
  }
  const lock = `${cache}.lock`;
  if (!sourceDir) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(
          `cache lock exists: ${lock}. If no packaging process is running, remove this lock directory and retry.`,
        );
      }
      throw error;
    }
  }
  try {
    if (!sourceDir) {
      mkdirSync(cache, { recursive: true });
      const expected = TARGETS.map((target) => archiveName(manifest, target));
      check(
        readdirSync(cache).every((name) => expected.includes(name)),
        "cache file allowlist differs",
      );
    }
    const result = {};
    for (const target of TARGETS) {
      const name = archiveName(manifest, target);
      const path = join(sourceDir || cache, name);
      let bytes;
      if (sourceDir || existsSync(path)) bytes = regularFile(path);
      else if (mode === "gh") {
        const stage = mkdtempSync(join(dirname(cache), ".sp-download-"));
        try {
          execFileSync(
            "gh",
            [
              "release",
              "download",
              manifest.release,
              "--repo",
              REPOSITORY,
              "--pattern",
              name,
              "--dir",
              stage,
            ],
            { env: { ...process.env, GH_HOST: "github.com" }, stdio: "pipe" },
          );
          bytes = regularFile(join(stage, name));
        } finally {
          rmSync(stage, { recursive: true, force: true });
        }
      } else
        bytes = await publicDownload(
          `https://github.com/${REPOSITORY}/releases/download/${manifest.release}/${name}`,
        );
      result[target] = verifyArchive(bytes, manifest, target);
      if (!sourceDir && !existsSync(path)) {
        const stage = mkdtempSync(join(dirname(cache), ".sp-cache-write-"));
        try {
          const staged = join(stage, "archive");
          writeFileSync(staged, bytes, { flag: "wx", mode: 0o644 });
          renameSync(staged, path);
        } finally {
          rmSync(stage, { recursive: true, force: true });
        }
      }
    }
    const first = result[TARGETS[0]].files;
    for (const target of TARGETS.slice(1)) {
      for (const name of ["SKILL.md", "THIRD_PARTY_NOTICES", "LICENSE"]) {
        check(
          result[target].files[name].equals(first[name]),
          `release ${name} differs between targets`,
        );
      }
    }
    return result;
  } finally {
    if (!sourceDir) rmSync(lock, { recursive: true, force: true });
  }
}

export function recoveryContract(skill) {
  const heading = "### Remove an unprepared upload\n";
  check(
    skill.split(heading).length === 2,
    "skill must contain one upload-abandonment contract",
  );
  return skill.split(heading)[1].split("\n## ")[0].trim();
}

export function packagedBuild(manifest, artifacts) {
  return {
    schema: 1,
    config: {
      schema: 1,
      release: manifest.release,
      source_commit: manifest.source_commit,
      go_version: manifest.go_version,
      targets: TARGETS,
    },
    distribution_repository: manifest.repository,
    license: "Apache-2.0",
    files: Object.fromEntries(
      TARGETS.map((target) => [
        binaryName(target),
        {
          sha256: manifest.targets[target].binary_sha256,
          bytes: artifacts[target].files.sp.length,
        },
      ]),
    ),
    build_info: Object.fromEntries(
      TARGETS.map((target) => [target, artifacts[target].build.build_info]),
    ),
    archives: manifest.targets,
  };
}

function install(manifest, artifacts, options) {
  const addon = process.cwd();
  regularFile(join(addon, "package.json"));
  const dest = resolve(addon, options.dest || "skill/scratchpad");
  const within = relative(addon, dest);
  const workName = ".scratchpad-work";
  check(
    within &&
      !within.startsWith(`..${sep}`) &&
      within !== ".." &&
      within !== workName &&
      !within.startsWith(`${workName}${sep}`) &&
      !isAbsolute(within),
    "--dest must be a directory inside this add-on",
  );
  let parent = addon;
  for (const part of within.split(sep)) {
    parent = join(parent, part);
    if (existsSync(parent))
      check(
        lstatSync(parent).isDirectory(),
        "skill destination contains a file or symbolic link",
      );
  }
  let skill = readFileSync(join(HERE, "SKILL.md"), "utf8");
  check(
    recoveryContract(skill) ===
      recoveryContract(
        artifacts[TARGETS[0]].files["SKILL.md"].toString("utf8"),
      ),
    "harness recovery instructions differ from the release skill",
  );
  if (options.allowed) {
    check(!/[\r\n]/.test(options.allowed), "--allowed-tools must be one line");
    check(
      skill.split(/^description:.*$/m).length === 2,
      "skill description must occur once",
    );
    skill = skill.replace(
      /^(description:.*)$/m,
      (description) => `${description}\nallowed-tools: ${options.allowed}`,
    );
  }
  mkdirSync(dirname(dest), { recursive: true });
  const work = join(addon, workName);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  check(
    lstatSync(work).isDirectory(),
    "packaging workspace must be a directory",
  );
  // Interrupted stages and backups stay outside the package's files roots.
  const stage = mkdtempSync(join(work, "install-"));
  let backup;
  try {
    mkdirSync(join(stage, "bin"));
    mkdirSync(join(stage, "scripts"));
    writeFileSync(join(stage, "SKILL.md"), skill);
    writeFileSync(
      join(stage, "scripts/sp"),
      regularFile(join(HERE, "scripts/sp")),
      { mode: 0o755 },
    );
    for (const target of TARGETS)
      writeFileSync(
        join(stage, "bin", binaryName(target)),
        artifacts[target].files.sp,
        { mode: 0o755 },
      );
    writeFileSync(join(stage, "bin/COMMIT"), `${manifest.source_commit}\n`);
    writeFileSync(
      join(stage, "bin/BUILD.json"),
      encoded(packagedBuild(manifest, artifacts)),
    );
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES"])
      writeFileSync(join(stage, name), artifacts[TARGETS[0]].files[name]);
    chmodSync(stage, 0o755);
    if (existsSync(dest)) {
      backup = mkdtempSync(join(work, "previous-"));
      renameSync(dest, join(backup, "skill"));
    }
    try {
      renameSync(stage, dest);
    } catch (error) {
      if (backup) renameSync(join(backup, "skill"), dest);
      throw error;
    }
    if (backup) rmSync(backup, { recursive: true });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  console.log(
    `Installed ${manifest.release}: ${TARGETS.length} verified binaries at ${dest}`,
  );
}

async function main(args) {
  check(
    Number(process.versions.node.split(".")[0]) >= 20,
    "Node 20 or newer is required",
  );
  const command = args.shift();
  check(
    command === "install" || command === "verify",
    "usage: load-sp.mjs install|verify [--dest DIR] [--allowed-tools RULE] [--source-dir DIR] [--cache-dir DIR] [--download public|gh]",
  );
  const keys = {
    "--dest": "dest",
    "--allowed-tools": "allowed",
    "--source-dir": "sourceDir",
    "--cache-dir": "cacheDir",
    "--download": "download",
  };
  const options = {};
  while (args.length) {
    const flag = args.shift();
    check(
      Object.hasOwn(keys, flag) && args.length && args[0],
      `unknown argument or missing value: ${flag}`,
    );
    check(!Object.hasOwn(options, keys[flag]), `duplicate argument: ${flag}`);
    options[keys[flag]] = args.shift();
  }
  options.sourceDir ??= process.env.SP_RELEASE_SOURCE_DIR;
  options.cacheDir ??= process.env.SP_RELEASE_CACHE_DIR;
  options.download ??= process.env.SP_RELEASE_DOWNLOAD;
  const manifest = readManifest();
  const artifacts = await loadRelease(manifest, options);
  if (command === "install") install(manifest, artifacts, options);
  else
    console.log(
      `Verified ${manifest.release}: ${TARGETS.length} archives and ${TARGETS.length * MEMBERS.length} regular files`,
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`load-sp: ${error.message}`);
    process.exitCode = 1;
  });
}
