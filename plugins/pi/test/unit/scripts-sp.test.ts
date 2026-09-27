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
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The one skill the add-ons share, and this add-on's installed copy of it
// (`npm run build:sp`), which carries the binaries.
const SOURCE = resolve(__dirname, "../../../scratchpad-skill");
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
  copyFileSync(join(SOURCE, "scripts", "sp"), script);
  chmodSync(script, 0o755);
  for (const p of PLATFORMS) executable(join(root, "skill", "bin", `sp-${p}`), FAKE_SP);
  fakes = join(root, "fakes");
  mkdirSync(fakes);
  executable(join(fakes, "uname"), FAKE_UNAME);
});

// Prints its name and arguments; with FAKE_JSON, answers publish-file and
// grant the way sp does; with FAKE_LOG, appends every call's arguments there.
const FAKE_SP = `#!/bin/sh
[ -n "\${FAKE_LOG:-}" ] && printf '%s\\n' "$*" >> "$FAKE_LOG"
if [ -n "\${FAKE_JSON:-}" ]; then
  for a in "$@"; do
    case $a in
      publish-file) echo '{"receipt":{"head":1},"reference":"sp-ref:abc123"}'; exit "\${FAKE_EXIT:-0}" ;;
      grant)
        if [ -n "\${FAKE_GRANT_FAIL:-}" ]; then
          echo '{"error":{"code":"denied","message":"refused","unknown":false}}' >&2; exit 1
        fi
        echo '{"handle":{"slot":0,"generation":4},"expires_at":99}'; exit 0 ;;
    esac
  done
fi
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
  SP_NATS_URL: "nats://127.0.0.1:4333",
  SP_NATS_CREDS: "/keys/pi.creds",
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
      "scripts/sp: ScratchPad is not configured for this agent: SP_NATS_URL and SP_NATS_CREDS are unset",
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

// Claude Code's add-on cannot set the Bash tool's environment, so it writes
// the variables to a file its SessionStart hook names in SP_ENV_FILE.
describe("the variables from SP_ENV_FILE", () => {
  function envFile(text: string): string {
    const path = join(root, `sp-${Math.random().toString(36).slice(2)}.env`);
    writeFileSync(path, text);
    return path;
  }

  it("takes the connection, the workspace, the trace and the caller from the file", () => {
    const path = envFile(
      [
        "SP_NATS_URL=nats://127.0.0.1:4333",
        "SP_NATS_CREDS=/keys/cc it's.creds",
        "SCRATCHPAD_DIR=/state/scratchpad",
        "SCRATCHPAD_VOLUME=cc-vol",
        `SP_THREAD_ID=${"a".repeat(32)}`,
        `SP_ROOT_ID=${"b".repeat(32)}`,
        "SP_CALLER_ACCOUNT=ACALLER",
        "SP_CALLER_USER=UCALLER",
      ].join("\n"),
    );
    const read = run(["read", "--ref", "x"], { SP_ENV_FILE: path });
    expect(read.status).toBe(0);
    expect(flag(read.args, "--creds")).toBe("/keys/cc it's.creds");
    expect(flag(read.args, "--dir")).toBe("/state/scratchpad");
    expect(flag(read.args, "--thread-id")).toBe("a".repeat(32));
    expect(flag(run(["init"], { SP_ENV_FILE: path }).args, "--volume")).toBe("cc-vol");
    const grant = run(["grant", "--ref", "sp-ref:abc", "--operation-id", "g1"], {
      SP_ENV_FILE: path,
    });
    expect(flag(grant.args, "--grantee-user")).toBe("UCALLER");
  });

  it("is the truth when it exists: a served prompt's variable it does not name is unset", () => {
    const path = envFile("SP_NATS_URL=nats://from-file:4222\nSP_NATS_CREDS=/keys/f.creds\n");
    const r = run(["grant", "--ref", "sp-ref:abc", "--operation-id", "g1"], {
      ...CONNECTION,
      SP_ENV_FILE: path,
      SP_THREAD_ID: "a".repeat(32),
      SP_ROOT_ID: "b".repeat(32),
      SP_CALLER_ACCOUNT: "ASTALE",
      SP_CALLER_USER: "USTALE",
    });
    expect(r.status).toBe(2);
    expect(r.error?.message).toContain("grant goes only to the agent whose prompt is being served");
    const read = run(["read", "--ref", "x"], { ...CONNECTION, SP_ENV_FILE: path });
    expect(flag(read.args, "--url")).toBe("nats://from-file:4222");
    expect(read.args).not.toContain("--thread-id");
    // What the file does not hold keeps its value from the environment.
    expect(flag(read.args, "--dir")).toBe("/state/scratchpad");
  });

  it("reads only its own names, as values and never as commands", () => {
    const marker = join(root, "ran");
    const path = envFile(
      [
        "SP_NATS_URL=nats://127.0.0.1:4333",
        `SP_NATS_CREDS=$(touch ${marker})`,
        `PATH=/nowhere`,
        `SCRATCHPAD_BIN=/elsewhere/sp`,
        "not a line",
      ].join("\n"),
    );
    const r = run(["read", "--ref", "x"], { SP_ENV_FILE: path });
    expect(r.status).toBe(0);
    expect(r.binary).toBe("sp-darwin-arm64");
    expect(flag(r.args, "--creds")).toBe(`$(touch ${marker})`);
    expect(existsSync(marker)).toBe(false);
  });

  it("falls back to the environment when the file does not exist", () => {
    const r = run(["read", "--ref", "x"], { ...CONNECTION, SP_ENV_FILE: join(root, "absent.env") });
    expect(flag(r.args, "--url")).toBe("nats://127.0.0.1:4333");
    const bare = run(["read", "--ref", "x"], { SP_ENV_FILE: join(root, "absent.env") });
    expect(bare.status).toBe(2);
    expect(bare.error?.message).toContain("SP_NATS_URL and SP_NATS_CREDS are unset");
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
      env: { PATH: "/usr/bin:/bin", SP_NATS_URL: "nats://127.0.0.1:1", SP_NATS_CREDS: creds },
    });
    expect(r.status).toBe(1);
    expect((JSON.parse(r.stderr) as { error: unknown }).error).toMatchObject({
      code: "invalid",
      unknown: false,
    });
  });
});

describe("a publication while a prompt with a verified caller is served", () => {
  const CALLER = { SP_CALLER_ACCOUNT: "ACALLER", SP_CALLER_USER: "UCALLER" };
  const PUBLISH = [
    "publish-file",
    "--source",
    "-",
    "--path",
    "/r.txt",
    "--operation-id",
    "p1",
    "--ttl-seconds",
    "900",
  ];

  function publish(env: Record<string, string>): {
    status: number | null;
    out: unknown;
    calls: string[];
  } {
    const log = join(root, `calls-${Math.random().toString(36).slice(2)}.log`);
    const r = spawnSync(script, PUBLISH, {
      encoding: "utf8",
      env: {
        PATH: `${fakes}:/usr/bin:/bin`,
        FAKE_UNAME_S: "Darwin",
        FAKE_UNAME_M: "arm64",
        FAKE_JSON: "1",
        FAKE_LOG: log,
        ...CONNECTION,
        ...env,
      },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return {
      status: r.status,
      out: r.stdout.trim() === "" ? undefined : JSON.parse(r.stdout),
      calls,
    };
  }

  it("also grants the caller read on what it published, and says so", () => {
    const r = publish({ ...CALLER, SP_THREAD_ID: "a".repeat(32), SP_ROOT_ID: "b".repeat(32) });
    expect(r.status).toBe(0);
    expect(r.out).toEqual({
      receipt: { head: 1 },
      reference: "sp-ref:abc123",
      granted_to_caller: { handle: { slot: 0, generation: 4 }, expires_at: 99 },
    });
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toBe(
      `--url nats://127.0.0.1:4333 --creds /keys/pi.creds --dir /state/scratchpad ` +
        `--thread-id ${"a".repeat(32)} --root-id ${"b".repeat(32)} ` +
        "grant --ref sp-ref:abc123 --grantee-account ACALLER --grantee-user UCALLER " +
        "--operation-id p1-caller --ttl-seconds 900",
    );
  });

  it("reports a grant that failed next to the publication, which stands", () => {
    const r = publish({ ...CALLER, FAKE_GRANT_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toEqual({
      receipt: { head: 1 },
      reference: "sp-ref:abc123",
      caller_grant_error: { error: { code: "denied", message: "refused", unknown: false } },
    });
  });

  it("grants nothing when the publication failed, and passes its exit code through", () => {
    const r = publish({ ...CALLER, FAKE_EXIT: "3" });
    expect(r.status).toBe(3);
    expect(r.calls).toHaveLength(1);
  });

  it("grants nothing, in one call, when no prompt with a verified caller is served", () => {
    const r = publish({});
    expect(r.status).toBe(0);
    expect(r.out).toEqual({ receipt: { head: 1 }, reference: "sp-ref:abc123" });
    expect(r.calls).toHaveLength(1);
  });
});
