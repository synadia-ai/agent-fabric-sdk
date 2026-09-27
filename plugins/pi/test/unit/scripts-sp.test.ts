// The skill's `scripts/sp` (`docs/plugins.md` §9.1), run as PI's bash tool
// runs it: a copy of the script in a skill directory whose bin/ holds fake
// sp binaries that print their name and arguments, and a fake `uname` first
// on PATH. The last case runs the real binary for this machine, when built.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const SKILL = resolve(__dirname, "../../skill/scratchpad");
const PLATFORMS = ["darwin-arm64", "darwin-amd64", "linux-arm64", "linux-amd64"] as const;

let root: string;
let script: string;
let fakes: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fabric-pi-scripts-sp-"));
  mkdirSync(join(root, "skill", "scripts"), { recursive: true });
  mkdirSync(join(root, "skill", "bin"));
  script = join(root, "skill", "scripts", "sp");
  copyFileSync(join(SKILL, "scripts", "sp"), script);
  chmodSync(script, 0o755);
  for (const p of PLATFORMS) executable(join(root, "skill", "bin", `sp-${p}`), FAKE_SP);
  fakes = join(root, "fakes");
  mkdirSync(fakes);
  executable(join(fakes, "uname"), FAKE_UNAME);
});

const FAKE_SP = `#!/bin/sh
echo "$(basename "$0")"
for a in "$@"; do printf '%s\\n' "$a"; done
exit "\${FAKE_EXIT:-0}"
`;

const FAKE_UNAME = `#!/bin/sh
case $1 in
  -s) echo "$FAKE_UNAME_S" ;;
  -m) echo "$FAKE_UNAME_M" ;;
esac
`;

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const CONNECTION = {
  NATS_URL: "nats://127.0.0.1:4333",
  NATS_CREDS: "/keys/pi.creds",
  SCRATCHPAD_DIR: "/state/scratchpad",
  SCRATCHPAD_VOLUME: "pi-vol",
};

interface Run {
  readonly status: number | null;
  readonly binary: string | undefined;
  readonly args: string[];
  readonly error: { code: string; message: string; unknown: boolean } | undefined;
}

function run(
  args: string[],
  env: Record<string, string> = CONNECTION,
  platform: [string, string] = ["Darwin", "arm64"],
  path: string = script,
): Run {
  const r = spawnSync(path, args, {
    encoding: "utf8",
    env: {
      PATH: `${fakes}:/usr/bin:/bin`,
      FAKE_UNAME_S: platform[0],
      FAKE_UNAME_M: platform[1],
      ...env,
    },
  });
  const lines = r.stdout.split("\n").filter((l) => l !== "");
  const stderr = r.stderr.trim();
  return {
    status: r.status,
    binary: lines[0],
    args: lines.slice(1),
    error:
      stderr === ""
        ? undefined
        : (JSON.parse(stderr) as { error: NonNullable<Run["error"]> }).error,
  };
}

/** The value after `flag` in `args`, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

describe("the platform", () => {
  it.each([
    ["Darwin", "arm64", "sp-darwin-arm64"],
    ["Darwin", "x86_64", "sp-darwin-amd64"],
    ["Linux", "aarch64", "sp-linux-arm64"],
    ["Linux", "arm64", "sp-linux-arm64"],
    ["Linux", "x86_64", "sp-linux-amd64"],
    ["Linux", "amd64", "sp-linux-amd64"],
  ])("runs the binary for %s %s", (os, arch, binary) => {
    const r = run(["describe"], CONNECTION, [os, arch]);
    expect(r.status).toBe(0);
    expect(r.binary).toBe(binary);
  });

  it.each([
    ["FreeBSD", "amd64"],
    ["Linux", "riscv64"],
    ["MINGW64_NT-10.0", "x86_64"],
  ])("refuses %s %s with a clear error in sp's shape, exit 2", (os, arch) => {
    const r = run(["describe"], CONNECTION, [os, arch]);
    expect(r.status).toBe(2);
    expect(r.binary).toBeUndefined();
    expect(r.error).toEqual({
      code: "usage",
      message: `scripts/sp: unsupported platform ${os} ${arch}; sp is built for darwin and linux on arm64 and amd64`,
      unknown: false,
    });
  });

  it("names the missing binary when the package holds none for this platform", () => {
    const bare = mkdtempSync(join(tmpdir(), "fabric-pi-scripts-sp-bare-"));
    mkdirSync(join(bare, "scripts"), { recursive: true });
    const lone = join(bare, "scripts", "sp");
    copyFileSync(script, lone);
    chmodSync(lone, 0o755);
    const r = run(["describe"], CONNECTION, ["Linux", "x86_64"], lone);
    expect(r.status).toBe(2);
    expect(r.error?.message).toMatch(/^scripts\/sp: no sp binary at .*\/bin\/sp-linux-amd64; /);
  });

  it("takes SCRATCHPAD_BIN over the packaged binaries", () => {
    const own = join(root, "own-sp");
    executable(own, FAKE_SP);
    const r = run(["describe"], { ...CONNECTION, SCRATCHPAD_BIN: own }, ["Plan9", "mips"]);
    expect(r.status).toBe(0);
    expect(r.binary).toBe("own-sp");
  });
});

describe("the flags from the environment", () => {
  it("adds the connection and the workspace, and no volume, to a read", () => {
    const r = run(["read", "--ref", "sp-ref:abc"]);
    expect(r.status).toBe(0);
    expect(r.args).toEqual([
      "--dir",
      "/state/scratchpad",
      "--url",
      "nats://127.0.0.1:4333",
      "--creds",
      "/keys/pi.creds",
      "read",
      "--ref",
      "sp-ref:abc",
    ]);
  });

  it("adds the volume to init, and only to init", () => {
    expect(flag(run(["init", "--operation-id", "c1"]).args, "--volume")).toBe("pi-vol");
    for (const command of ["describe", "hydrate", "sync", "recover", "reset", "maintain"]) {
      expect(run([command]).args).not.toContain("--volume");
    }
  });

  it("refuses init without a volume", () => {
    const { SCRATCHPAD_VOLUME: _, ...noVolume } = CONNECTION;
    const r = run(["init"], noVolume);
    expect(r.status).toBe(2);
    expect(r.error?.message).toContain("SCRATCHPAD_VOLUME is unset");
  });

  it("adds the served prompt's trace when both ids are set, and neither when one is missing", () => {
    const both = run(["read", "--ref", "x"], {
      ...CONNECTION,
      SP_THREAD_ID: "a".repeat(32),
      SP_ROOT_ID: "b".repeat(32),
    });
    expect(flag(both.args, "--thread-id")).toBe("a".repeat(32));
    expect(flag(both.args, "--root-id")).toBe("b".repeat(32));
    const half = run(["read", "--ref", "x"], { ...CONNECTION, SP_THREAD_ID: "a".repeat(32) });
    expect(half.args).not.toContain("--thread-id");
    expect(half.args).not.toContain("--root-id");
  });

  it("names this agent as the creator of what it publishes", () => {
    const r = run(["publish-file", "--source", "-", "--path", "/r.txt", "--operation-id", "p1"], {
      ...CONNECTION,
      SP_CREATOR: "agents.prompt.pi.team.editor",
    });
    expect(flag(r.args, "--creator")).toBe("agents.prompt.pi.team.editor");
  });

  it("grants to the served prompt's caller", () => {
    const r = run(["grant", "--ref", "sp-ref:abc", "--operation-id", "g1"], {
      ...CONNECTION,
      SP_CALLER_ACCOUNT: "ACALLER",
      SP_CALLER_USER: "UCALLER",
    });
    expect(r.status).toBe(0);
    expect(flag(r.args, "--grantee-account")).toBe("ACALLER");
    expect(flag(r.args, "--grantee-user")).toBe("UCALLER");
  });

  it("refuses a grant when no served prompt has a verified caller", () => {
    const r = run(["grant", "--ref", "sp-ref:abc", "--operation-id", "g1"]);
    expect(r.status).toBe(2);
    expect(r.binary).toBeUndefined();
    expect(r.error?.message).toContain("grant goes only to the agent whose prompt is being served");
  });

  it("finds the command past flags and their values, as sp does", () => {
    const r = run(
      ["--operation-id", "init", "--ttl-seconds", "60", "publish-file", "--source", "-"],
      {
        ...CONNECTION,
        SP_CREATOR: "me",
      },
    );
    expect(r.args).not.toContain("--volume");
    expect(flag(r.args, "--creator")).toBe("me");
    expect(run(["--apply", "init"]).args).toContain("--volume");
  });

  it("refuses to run unconfigured", () => {
    const r = run(["describe"], { SCRATCHPAD_VOLUME: "v" });
    expect(r.status).toBe(2);
    expect(r.error?.message).toBe(
      "scripts/sp: ScratchPad is not configured for this agent: NATS_URL and NATS_CREDS are unset",
    );
  });

  it.each([
    ["--url", "nats://elsewhere:4222"],
    ["--creds=/tmp/other.creds"],
    ["-dir", "/tmp"],
    ["--volume", "theirs"],
    ["--thread-id", "a".repeat(32)],
    ["--root-id=x"],
    ["--creator", "someone"],
    ["--grantee-account", "A"],
    ["--grantee-user=U"],
  ])("refuses %s from the model", (...given) => {
    const r = run(["read", "--ref", "x", ...given]);
    expect(r.status).toBe(2);
    expect(r.binary).toBeUndefined();
    expect(r.error?.message).toMatch(/is set by the agent, not passed/);
  });

  it("passes sp's exit code through", () => {
    expect(run(["recover"], { ...CONNECTION, FAKE_EXIT: "3" }).status).toBe(3);
    expect(run(["recover"], { ...CONNECTION, FAKE_EXIT: "1" }).status).toBe(1);
  });
});

const machine = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "amd64"}`;
const built = existsSync(join(SKILL, "bin", `sp-${machine}`));

describe.skipIf(!built)("the packaged binary (npm run build:sp)", () => {
  it("runs through the real script: sp's own refusal of a malformed reference", () => {
    // sp checks the credentials file is readable before anything else.
    const creds = join(root, "empty.creds");
    writeFileSync(creds, "");
    const r = spawnSync(join(SKILL, "scripts", "sp"), ["read", "--ref", "sp-ref:e30"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", NATS_URL: "nats://127.0.0.1:1", NATS_CREDS: creds },
    });
    expect(r.status).toBe(1);
    expect((JSON.parse(r.stderr) as { error: unknown }).error).toMatchObject({
      code: "invalid",
      unknown: false,
    });
  });
});
