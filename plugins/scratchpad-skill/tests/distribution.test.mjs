// Real release bytes and npm packages; doubles replace only external downloads.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  HERE,
  MEMBERS,
  TARGETS,
  archiveName,
  binaryName,
  digest,
  loadRelease,
  packagedBuild,
  readManifest,
  recoveryContract,
  verifyArchive,
} from "../load-sp.mjs";

const fakeGh = `#!/bin/sh
set -eu
printf '%s\\n' "$@" >>"$SP_TEST_LOG"
[ "$1" = release ] && [ "$2" = download ] && [ "$3" = "$SP_TEST_VERSION" ]
[ "$GH_HOST" = github.com ]
shift 3
patterns=
destination=
while [ $# -gt 0 ]; do
  case $1 in
    --repo) [ "$2" = synadia-ai/agent-fabric-sdk ] ;;
    --dir) destination=$2 ;;
    --pattern) patterns="$patterns $2" ;;
    *) exit 9 ;;
  esac
  shift 2
done
[ -n "$destination" ] && [ -n "$patterns" ]
for name in $patterns; do cp "$SP_TEST_DOWNLOADS/$name" "$destination/$name"; done
`;
const fakeCurl = `#!/bin/sh
set -eu
printf '%s\\n' "$@" >>"$SP_TEST_LOG"
output=
url=
while [ $# -gt 0 ]; do
  case $1 in
    --fail | --location | --silent | --show-error) shift ;;
    --proto | --proto-redir) [ "$2" = '=https' ]; shift 2 ;;
    --output) output=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    *) exit 9 ;;
  esac
done
prefix="https://github.com/synadia-ai/agent-fabric-sdk/releases/download/$SP_TEST_VERSION/"
case $url in "$prefix"*) ;; *) exit 8 ;; esac
cp "$SP_TEST_DOWNLOADS/\${url##*/}" "$output"
`;

let manifest, artifacts, directory, assets;
before(async () => {
  manifest = readManifest();
  artifacts = await loadRelease(manifest, {
    sourceDir: process.env.SP_RELEASE_SOURCE_DIR,
    cacheDir: process.env.SP_RELEASE_CACHE_DIR,
    download: process.env.SP_RELEASE_DOWNLOAD,
  });
  directory = mkdtempSync(join(tmpdir(), "sp-distribution-test-"));
  assets = process.env.SP_RELEASE_SOURCE_DIR
    ? resolve(process.env.SP_RELEASE_SOURCE_DIR)
    : resolve(
        process.env.SP_RELEASE_CACHE_DIR || join(HERE, "downloads"),
        manifest.release,
      );
});
after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(directory, "case-"));
  const commands = join(root, "commands");
  const downloads = join(root, "downloads");
  mkdirSync(commands);
  mkdirSync(downloads);
  for (const command of [
    "sh",
    "awk",
    "cat",
    "cp",
    "dirname",
    "mkdir",
    "mktemp",
    "rm",
    "tar",
    "gzip",
    "sort",
    "cmp",
    "chmod",
    "mv",
    "grep",
    "uname",
    "sha256sum",
    "shasum",
  ]) {
    const found = spawnSync("which", [command], { encoding: "utf8" });
    if (found.status === 0)
      symlinkSync(found.stdout.trim(), join(commands, command));
  }
  for (const [name, script] of [
    ["gh", fakeGh],
    ["curl", fakeCurl],
  ]) {
    writeFileSync(join(commands, name), script, { mode: 0o755 });
  }
  for (const target of TARGETS)
    copyFileSync(
      join(assets, archiveName(manifest, target)),
      join(downloads, archiveName(manifest, target)),
    );
  const fixture = {
    root,
    commands,
    downloads,
    env: {
      ...process.env,
      PATH: commands,
      SP_TEST_DOWNLOADS: downloads,
      SP_TEST_VERSION: manifest.release,
      SP_TEST_LOG: join(root, "download.log"),
    },
  };
  checksums(fixture);
  return fixture;
}

function checksums(fixture) {
  writeFileSync(
    join(fixture.downloads, "SHA256SUMS"),
    TARGETS.map((target) => {
      const name = archiveName(manifest, target);
      return `${digest(readFileSync(join(fixture.downloads, name)))}  ${name}\n`;
    }).join(""),
  );
}

function standalone(
  fixture,
  {
    target = "linux/amd64",
    dest = join(fixture.root, "installed"),
    mode = "public",
    script = join(HERE, "get-sp.sh"),
    version = true,
  } = {},
) {
  const args = [script, "--dest", dest, "--target", target, "--download", mode];
  if (version) args.push("--version", manifest.release);
  return spawnSync("sh", args, { env: fixture.env, encoding: "utf8" });
}

// Produce USTAR controls from the already verified release members. The
// changed checksum deliberately admits malformed metadata to the next guard.
function archive(files, change = () => {}) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const entry = {
      name,
      content,
      type: "0",
      link: "",
      mode: name === "sp" ? 0o755 : 0o644,
    };
    change(entry);
    const header = Buffer.alloc(512);
    const text = (value, offset, length) =>
      header.write(value, offset, length, "ascii");
    const octal = (value, offset, length) =>
      text(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
    text(entry.name, 0, 100);
    octal(entry.mode, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(entry.content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    text(entry.type, 156, 1);
    text(entry.link, 157, 100);
    text("ustar\0", 257, 6);
    text("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    text(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(
      header,
      entry.content,
      Buffer.alloc((512 - (entry.content.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function changed(fixture, files, change) {
  const bytes = archive(files, change);
  writeFileSync(
    join(fixture.downloads, archiveName(manifest, "linux/amd64")),
    bytes,
  );
  checksums(fixture);
  return bytes;
}

function assertPackagedSkillMembers(listing, skill) {
  const root = skill.split("/")[0];
  const expected = [
    "SKILL.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
    "scripts/sp",
    "bin/BUILD.json",
    "bin/COMMIT",
    ...TARGETS.map((target) => `bin/${binaryName(target)}`),
  ].map((name) => `package/${skill}/${name}`);
  const actual = listing
    .split("\n")
    .filter((name) => name.startsWith(`package/${root}/`));
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    "packaged skill member set differs",
  );
}

test("four pinned archives include identical full licenses, notices, and recovery guidance", () => {
  const source = readFileSync(join(HERE, "SKILL.md"), "utf8");
  for (const target of TARGETS) {
    const { files, build } = artifacts[target];
    assert.deepEqual(Object.keys(files).sort(), [...MEMBERS].sort());
    assert.equal(digest(files.sp), manifest.targets[target].binary_sha256);
    assert.equal(build.target, target);
    assert.equal(
      recoveryContract(files["SKILL.md"].toString()),
      recoveryContract(source),
    );
    assert.deepEqual(files.LICENSE, readFileSync(join(HERE, "../../LICENSE")));
  }
  assert.notEqual(
    recoveryContract(
      source.replace(
        "refuses a pending checkpoint",
        "permits a pending checkpoint",
      ),
    ),
    recoveryContract(source),
  );
});

test("standalone public downloads install all four targets without Go, Git, Python, or Node", () => {
  const fixture = setup();
  for (const command of ["go", "git", "python3", "node"])
    assert.equal(existsSync(join(fixture.commands, command)), false);
  for (const target of TARGETS) {
    const dest = join(fixture.root, target.replace("/", "-"));
    const result = standalone(fixture, { target, dest });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(dest).sort(), [...MEMBERS].sort());
    for (const name of MEMBERS)
      assert.deepEqual(
        readFileSync(join(dest, name)),
        artifacts[target].files[name],
      );
    assert.equal(statSync(join(dest, "sp")).mode & 0o777, 0o755);
  }
  const log = readFileSync(fixture.env.SP_TEST_LOG, "utf8");
  assert.equal(
    log.split(
      "https://github.com/synadia-ai/agent-fabric-sdk/releases/download/",
    ).length - 1,
    8,
  );
});

test("standalone authenticated downloads use the selected GitHub release", () => {
  const fixture = setup();
  const result = standalone(fixture, { mode: "gh" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readFileSync(join(fixture.root, "installed/sp")),
    artifacts["linux/amd64"].files.sp,
  );
  assert.match(
    readFileSync(fixture.env.SP_TEST_LOG, "utf8"),
    /synadia-ai\/agent-fabric-sdk/,
  );
});

test("archive checksum guard rejects changed bytes and its control admits that exact archive", () => {
  const fixture = setup();
  const files = {
    ...artifacts["linux/amd64"].files,
    "README.md": Buffer.from("changed after publication\n"),
  };
  const sums = readFileSync(join(fixture.downloads, "SHA256SUMS"));
  changed(fixture, files);
  writeFileSync(join(fixture.downloads, "SHA256SUMS"), sums);
  const result = standalone(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archive checksum differs/);
  assert.equal(existsSync(join(fixture.root, "installed")), false);
  const original = readFileSync(join(HERE, "get-sp.sh"), "utf8");
  const guard =
    '[ "$(hash "$archive")" = "$expected" ] || fail "archive checksum differs"';
  assert.equal(original.split(guard).length, 2);
  const mutant = join(fixture.root, "get-sp-control.sh");
  writeFileSync(mutant, original.replace(guard, "# checksum control"));
  const control = standalone(fixture, { script: mutant });
  assert.equal(control.status, 0, control.stderr);
  assert.equal(
    readFileSync(join(fixture.root, "installed/README.md"), "utf8"),
    files["README.md"].toString(),
  );
});

test("standalone target and executable checks reject internally inconsistent archives", () => {
  for (const [from, to, error] of [
    [
      "target=linux/amd64",
      "target=darwin/amd64",
      /archive release or target differs/,
    ],
    [
      manifest.targets["linux/amd64"].binary_sha256,
      "0".repeat(64),
      /binary checksum differs/,
    ],
  ]) {
    const fixture = setup();
    const files = { ...artifacts["linux/amd64"].files };
    files.SOURCE = Buffer.from(files.SOURCE.toString().replace(from, to));
    changed(fixture, files);
    const result = standalone(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(existsSync(join(fixture.root, "installed")), false);
  }
});

test("both consumers refuse unexpected paths, links, duplicates, and extra files", () => {
  for (const hazard of [
    "parent",
    "absolute",
    "symlink",
    "hardlink",
    "duplicate",
    "extra",
  ]) {
    const fixture = setup();
    const files = { ...artifacts["linux/amd64"].files };
    if (hazard === "extra")
      files["unexpected.go"] = Buffer.from("unexpected member\n");
    const bytes = changed(fixture, files, (entry) => {
      if (entry.name !== "sp") return;
      if (hazard === "parent") entry.name = "../outside";
      if (hazard === "absolute") entry.name = "/outside";
      if (hazard === "duplicate") entry.name = "README.md";
      if (hazard === "symlink" || hazard === "hardlink") {
        entry.type = hazard === "symlink" ? "2" : "1";
        entry.link = "../outside";
        entry.content = Buffer.alloc(0);
      }
    });
    const admitted = structuredClone(manifest);
    admitted.targets["linux/amd64"].archive_sha256 = digest(bytes);
    assert.throws(
      () => verifyArchive(bytes, admitted, "linux/amd64"),
      /allowlist|non-regular/,
      hazard,
    );
    const result = standalone(fixture);
    assert.notEqual(result.status, 0, hazard);
    assert.match(result.stderr, /allowlist|non-regular/, hazard);
    assert.equal(existsSync(join(fixture.root, "installed")), false);
    assert.equal(existsSync(join(fixture.root, "outside")), false);
  }
});

test("duplicate checksums and source fields cannot weaken verification", () => {
  const duplicateSums = setup();
  const sums = join(duplicateSums.downloads, "SHA256SUMS");
  writeFileSync(sums, readFileSync(sums, "utf8").repeat(2));
  assert.match(standalone(duplicateSums).stderr, /missing or duplicated/);
  const duplicateSource = setup();
  const files = { ...artifacts["linux/amd64"].files };
  files.SOURCE = Buffer.concat([
    files.SOURCE,
    Buffer.from(`target=linux/amd64\n`),
  ]);
  changed(duplicateSource, files);
  const result = standalone(duplicateSource);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate source field/);
});

test("standalone preserves existing destinations and rejects unknown targets before download", () => {
  const fixture = setup();
  const dest = join(fixture.root, "installed");
  mkdirSync(dest);
  writeFileSync(join(dest, "keep"), "existing state");
  assert.notEqual(standalone(fixture).status, 0);
  assert.equal(readFileSync(join(dest, "keep"), "utf8"), "existing state");
  assert.notEqual(
    standalone(fixture, {
      dest: join(fixture.root, "unused"),
      target: "windows/amd64",
    }).status,
    0,
  );
  assert.notEqual(
    standalone(fixture, { dest: join(fixture.root, "unused"), version: false })
      .status,
    0,
  );
  assert.equal(existsSync(fixture.env.SP_TEST_LOG), false);
});

test("new image directories permit the runtime user to reach the executable", () => {
  const fixture = setup();
  const parent = join(fixture.root, "image/scratchpad");
  const dest = join(parent, manifest.release);
  const result = standalone(fixture, { dest });
  assert.equal(result.status, 0, result.stderr);
  for (const path of [
    join(fixture.root, "image"),
    parent,
    dest,
    join(dest, "sp"),
  ])
    assert.equal(statSync(path).mode & 0o005, 0o005);
});

test("packaging rechecks cached bytes, identities, and membership before reuse", async () => {
  const fixture = setup();
  const cacheDir = join(fixture.root, "cache");
  const cache = join(cacheDir, manifest.release);
  mkdirSync(cache, { recursive: true });
  for (const target of TARGETS)
    copyFileSync(
      join(assets, archiveName(manifest, target)),
      join(cache, archiveName(manifest, target)),
    );
  const verified = await loadRelease(manifest, { cacheDir });
  assert.equal(Object.keys(verified).length, 4);
  await assert.rejects(
    loadRelease({ ...manifest, source_commit: "0".repeat(40) }, { cacheDir }),
    /SOURCE identity differs/,
  );
  const path = join(cache, archiveName(manifest, "linux/amd64"));
  const bytes = readFileSync(path);
  bytes[100] ^= 1;
  writeFileSync(path, bytes);
  await assert.rejects(
    loadRelease(manifest, { cacheDir }),
    /archive checksum differs/,
  );
  assert.deepEqual(readFileSync(path), bytes);
  copyFileSync(join(assets, archiveName(manifest, "linux/amd64")), path);
  writeFileSync(join(cache, "unexpected.go"), "unexpected cache member\n");
  await assert.rejects(
    loadRelease(manifest, { cacheDir }),
    /cache file allowlist differs/,
  );
});

test("local packaging sources retain the manifest pins and existing installation on failure", () => {
  const fixture = setup();
  symlinkSync(process.execPath, join(fixture.commands, "node"));
  const addon = join(fixture.root, "addon");
  mkdirSync(join(addon, "skill/scratchpad"), { recursive: true });
  writeFileSync(
    join(addon, "package.json"),
    '{"name":"fixture","version":"0.0.0"}\n',
  );
  writeFileSync(join(addon, "skill/scratchpad/keep"), "previous installation");
  const files = {
    ...artifacts["linux/amd64"].files,
    "README.md": Buffer.from("changed archive\n"),
  };
  changed(fixture, files);
  const result = spawnSync(
    "sh",
    [join(HERE, "install.sh"), "--source-dir", fixture.downloads],
    { cwd: addon, env: fixture.env, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archive checksum differs/);
  assert.equal(
    readFileSync(join(addon, "skill/scratchpad/keep"), "utf8"),
    "previous installation",
  );
  assert.equal(existsSync(fixture.env.SP_TEST_LOG), false);
});

test("packaging downloads exactly the pinned archives through authenticated GitHub", () => {
  const fixture = setup();
  const result = spawnSync(
    process.execPath,
    [
      join(HERE, "load-sp.mjs"),
      "verify",
      "--download",
      "gh",
      "--cache-dir",
      join(fixture.root, "cache"),
    ],
    {
      env: { ...fixture.env, SP_RELEASE_SOURCE_DIR: "" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /4 archives and 28 regular files/);
  const log = readFileSync(fixture.env.SP_TEST_LOG, "utf8");
  for (const target of TARGETS)
    assert.ok(log.includes(archiveName(manifest, target)));
});

test("an interrupted cache write requires explicit lock cleanup and cannot supply a partial archive", async () => {
  const fixture = setup();
  const cacheDir = join(fixture.root, "cache");
  const stage = join(cacheDir, ".sp-cache-write-interrupted");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "archive"), "partial download");
  const lock = join(cacheDir, `${manifest.release}.lock`);
  mkdirSync(lock);
  const run = () =>
    spawnSync(
      process.execPath,
      [
        join(HERE, "load-sp.mjs"),
        "verify",
        "--download",
        "gh",
        "--cache-dir",
        cacheDir,
      ],
      { env: { ...fixture.env, SP_RELEASE_SOURCE_DIR: "" }, encoding: "utf8" },
    );
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.ok(refused.stderr.includes(`cache lock exists: ${lock}.`));
  assert.match(
    refused.stderr,
    /If no packaging process is running, remove this lock directory/,
  );
  assert.equal(existsSync(lock), true);
  assert.equal(existsSync(fixture.env.SP_TEST_LOG), false);
  rmSync(lock, { recursive: true });
  assert.equal(existsSync(lock), false);
  const completed = run();
  assert.equal(completed.status, 0, completed.stderr);
  const cache = join(cacheDir, manifest.release);
  assert.deepEqual(
    readdirSync(cache).sort(),
    TARGETS.map((target) => archiveName(manifest, target)).sort(),
  );
  const persisted = await loadRelease(manifest, { cacheDir });
  for (const target of TARGETS)
    assert.deepEqual(persisted[target].files.sp, artifacts[target].files.sp);
  assert.equal(
    readFileSync(join(stage, "archive"), "utf8"),
    "partial download",
  );
  assert.equal(existsSync(lock), false);
});

test("packaging checks executable, source fields, build target, and complete license after archive verification", () => {
  for (const hazard of ["binary", "source", "target", "license"]) {
    const files = { ...artifacts["linux/amd64"].files };
    if (hazard === "binary") {
      files.sp = Buffer.from(files.sp);
      files.sp[0] ^= 1;
    }
    if (hazard === "source")
      files.SOURCE = Buffer.concat([
        files.SOURCE,
        Buffer.from("__proto__=unexpected\n"),
      ]);
    if (hazard === "target") {
      const build = JSON.parse(files["BUILD.json"]);
      build.target = "darwin/amd64";
      files["BUILD.json"] = Buffer.from(JSON.stringify(build));
    }
    if (hazard === "license") files.LICENSE = Buffer.from("Apache-2.0\n");
    const bytes = archive(files);
    const admitted = structuredClone(manifest);
    admitted.targets["linux/amd64"].archive_sha256 = digest(bytes);
    assert.throws(
      () => verifyArchive(bytes, admitted, "linux/amd64"),
      /binary checksum|SOURCE field|BUILD target|full Apache/,
      hazard,
    );
  }
});

test("all three real npm packages carry the same four executables, notices, license, and wrapper", () => {
  const fixture = setup();
  symlinkSync(process.execPath, join(fixture.commands, "node"));
  const npm = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
  symlinkSync(npm, join(fixture.commands, "npm"));
  const permission = "allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/sp *)\n";
  const originalSkill = readFileSync(join(HERE, "SKILL.md"), "utf8");
  const builds = [];
  for (const harness of ["pi", "openclaw", "claude-code"]) {
    const addon = resolve(HERE, "..", harness);
    const output = join(fixture.root, harness);
    mkdirSync(output);
    const work = join(addon, ".scratchpad-work");
    mkdirSync(work, { recursive: true });
    const orphans = ["install-orphan-", "previous-orphan-"].map((prefix) => {
      const orphan = mkdtempSync(join(work, prefix));
      writeFileSync(join(orphan, "SKILL.md"), "interrupted skill copy\n");
      mkdirSync(join(orphan, "bin"));
      writeFileSync(join(orphan, "bin/sp-linux-amd64"), "partial executable\n");
      return orphan;
    });
    let result;
    try {
      result = spawnSync(
        "npm",
        ["pack", "--json", "--pack-destination", output],
        {
          cwd: addon,
          env: { ...fixture.env, SP_RELEASE_SOURCE_DIR: assets },
          encoding: "utf8",
        },
      );
    } finally {
      for (const orphan of orphans) rmSync(orphan, { recursive: true });
    }
    assert.equal(result.status, 0, result.stderr);
    const archives = readdirSync(output);
    assert.equal(archives.length, 1, result.stdout);
    const path = join(output, archives[0]);
    const skill =
      harness === "claude-code" ? "skills/scratchpad" : "skill/scratchpad";
    const member = (name) =>
      execFileSync("tar", ["-xOzf", path, `package/${name}`], {
        maxBuffer: 64 * 1024 * 1024,
      });
    const packageInfo = JSON.parse(member("package.json"));
    assert.ok(member(packageInfo.main.replace(/^\.\//, "")).length > 0);
    let installed = member(`${skill}/SKILL.md`).toString();
    if (harness === "claude-code") {
      assert.equal(installed.split(permission).length, 2);
      installed = installed.replace(permission, "");
    }
    assert.equal(installed, originalSkill);
    assert.deepEqual(
      member(`${skill}/scripts/sp`),
      readFileSync(join(HERE, "scripts/sp")),
    );
    for (const target of TARGETS)
      assert.deepEqual(
        member(`${skill}/bin/${binaryName(target)}`),
        artifacts[target].files.sp,
      );
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES"])
      assert.deepEqual(
        member(`${skill}/${name}`),
        artifacts[TARGETS[0]].files[name],
      );
    assert.equal(
      member(`${skill}/bin/COMMIT`).toString(),
      `${manifest.source_commit}\n`,
    );
    const build = member(`${skill}/bin/BUILD.json`);
    builds.push(build);
    assert.deepEqual(JSON.parse(build), packagedBuild(manifest, artifacts));
    const listing = execFileSync("tar", ["-tzf", path], { encoding: "utf8" });
    assertPackagedSkillMembers(listing, skill);
    assert.doesNotMatch(
      listing,
      /load-sp\.mjs|release\.json|downloads\/|get-sp\.sh|\.scratchpad-work\//,
    );
  }
  assert.ok(builds.every((build) => build.equals(builds[0])));
});

test("exact npm skill membership detects an orphan inside a packaged skill root", () => {
  const fixture = setup();
  symlinkSync(process.execPath, join(fixture.commands, "node"));
  const npm = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
  symlinkSync(npm, join(fixture.commands, "npm"));
  const addon = join(fixture.root, "addon");
  const output = join(fixture.root, "pack");
  mkdirSync(addon);
  mkdirSync(output);
  writeFileSync(
    join(addon, "package.json"),
    JSON.stringify({
      name: "scratchpad-orphan-control",
      version: "0.0.0",
      files: ["skill"],
    }),
  );
  const installed = spawnSync(
    "sh",
    [join(HERE, "install.sh"), "--source-dir", assets],
    {
      cwd: addon,
      env: fixture.env,
      encoding: "utf8",
    },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const orphan = join(addon, "skill/.scratchpad-install-orphan");
  mkdirSync(orphan);
  writeFileSync(join(orphan, "SKILL.md"), "interrupted previous installer\n");
  const packed = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", output],
    {
      cwd: addon,
      env: fixture.env,
      encoding: "utf8",
    },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const archives = readdirSync(output);
  assert.equal(archives.length, 1, packed.stdout);
  const listing = execFileSync("tar", ["-tzf", join(output, archives[0])], {
    encoding: "utf8",
  });
  assert.ok(
    listing.includes("package/skill/.scratchpad-install-orphan/SKILL.md"),
  );
  assert.throws(
    () => assertPackagedSkillMembers(listing, "skill/scratchpad"),
    /packaged skill member set differs/,
  );
});
