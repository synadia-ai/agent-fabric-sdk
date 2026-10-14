import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headers, type Msg, type NatsConnection } from "@nats-io/nats-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeScratchPadBootstrap,
  MAX_BOOTSTRAP_BYTES,
  readScratchPadBootstrapFile,
  type ScratchPadBootstrap,
} from "../../src/scratchpad-native/bootstrap";
import {
  nativeScratchPad,
  nativeScratchPadFromEnv,
  type NativeScratchPad,
} from "../../src/scratchpad-native/client";
import { WorkspaceStore } from "../../src/scratchpad-native/store";
import { encodeTreeNode, treeNodeID } from "../../src/scratchpad-native/codec";
import * as p from "../../src/scratchpad-native/protocol";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test-fixtures/scratchpad/bootstrap-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  valid: ScratchPadBootstrap;
  valid_json: string;
  valid_trace: ScratchPadBootstrap;
  malformed: { name: string; json: string }[];
  sdk_refusals: { name: string; json: string }[];
};
const creator = "agents.prompt.test.acme.main";
type Wire = Record<string, unknown>;
const directories: string[] = [],
  clients: NativeScratchPad[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function paths(descriptor = fixture.valid_trace) {
  const root = await mkdtemp(join(tmpdir(), "fabric-bootstrap-"));
  directories.push(root);
  const file = join(root, "bootstrap file.json"),
    dir = join(root, "work");
  await writeFile(file, JSON.stringify(descriptor));
  return { root, file, dir };
}
async function saved(dir: string): Promise<Wire> {
  const store = await WorkspaceStore.open(dir);
  try {
    return store.load() as Wire;
  } finally {
    store.close();
  }
}
function reply(value: unknown, code: p.Code = "ok"): Msg {
  const h = headers();
  h.set(p.REPLY_HEADER, p.goJSON({ code, message: code === "ok" ? "" : code }));
  return {
    headers: h,
    data: code === "ok" ? Buffer.from(p.goJSON(value)) : new Uint8Array(),
  } as Msg;
}
class Service {
  principal = structuredClone(fixture.valid.principal);
  scope: p.ReservedScope | undefined = {
    volume: "Replies",
    objects: 100,
    bytes: 1 << 20,
    admission: fixture.valid.admission,
  };
  calls: { verb: string; body: Wire }[] = [];
  dropCreate = false;
  createCode: p.Code = "ok";
  view: p.VolumeView = {
    target: { volume: "Replies", creation_id: "ab".repeat(16) },
    owner: fixture.valid.principal,
    head: { generation: 1, root: treeNodeID(encodeTreeNode([])) },
    revision: 1,
    closed: false,
    epoch: 0,
    objects: 1,
    bytes: 4,
    writers: Array.from({ length: 8 }, () => ({ generation: 1, number: 0, write: false })),
    retentions: Array.from({ length: 8 }, () => ({ generation: 0 })),
    grants: Array.from({ length: 16 }, () => ({ generation: 0 })),
    lifetime: {
      admission: fixture.valid.admission,
      phase: "active",
      expires_at: 0,
      grace_until: 0,
      max_lease_seconds: 0,
      grace_seconds: 0,
      recovery_reads: true,
      reserve_objects: 0,
      reserve_bytes: 0,
    },
  };
  readonly nc = {
    info: { max_payload: 1 << 20, headers: true },
    isClosed: () => false,
    isDraining: () => false,
    flush: async () => {},
    request: (subject: string, bytes: Uint8Array) => {
      const verb = subject.slice(p.SUBJECT_PREFIX.length),
        body = JSON.parse(Buffer.from(bytes).toString()) as Wire;
      this.calls.push({ verb, body });
      if (verb === "info")
        return Promise.resolve(
          reply({
            principal: this.principal,
            scopes: this.scope ? [this.scope] : [],
            limits: p.PUBLIC_LIMITS,
          }),
        );
      if (verb === "volume.create") {
        if (this.dropCreate) {
          this.dropCreate = false;
          return Promise.reject(Error("accepted create reply lost"));
        }
        return Promise.resolve(reply(this.view, this.createCode));
      }
      if (verb === "volume.get") return Promise.resolve(reply(this.view));
      return Promise.reject(Error("unexpected bootstrap effect: " + verb));
    },
  } as unknown as NatsConnection;
}

describe("public ScratchPad bootstrap descriptor", () => {
  it("creates missing nested workspace parents before importing the request", async () => {
    const { file, root } = await paths(),
      service = new Service();
    const dir = join(root, "missing", "nested", "private", "work");
    const pad = await nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file });
    try {
      expect((await pad.describe()).volume.target).toEqual(service.view.target);
    } finally {
      await pad.close();
    }
    expect((await saved(dir)).creation).toEqual(fixture.valid_trace.creation);
    expect(service.calls.map((call) => call.verb)).toEqual(["info", "volume.create"]);
  });
  it("accepts the shared complete requests and the exact 4 KiB boundary", () => {
    expect(decodeScratchPadBootstrap(fixture.valid_json)).toEqual(fixture.valid);
    expect(decodeScratchPadBootstrap(JSON.stringify(fixture.valid_trace))).toEqual(
      fixture.valid_trace,
    );
    const size = Buffer.byteLength(fixture.valid_json);
    expect(
      decodeScratchPadBootstrap(fixture.valid_json + " ".repeat(MAX_BOOTSTRAP_BYTES - size)),
    ).toEqual(fixture.valid);
    expect(() =>
      decodeScratchPadBootstrap(fixture.valid_json + " ".repeat(MAX_BOOTSTRAP_BYTES - size + 1)),
    ).toThrow();
    expect(() => decodeScratchPadBootstrap(new Uint8Array([255]))).toThrow();
    const zero = structuredClone(fixture.valid);
    zero.principal.account = "A".repeat(56);
    expect(decodeScratchPadBootstrap(JSON.stringify(zero))).toEqual(zero);
  });
  it.each([...fixture.malformed, ...fixture.sdk_refusals])("refuses $name", ({ json }) => {
    expect(() => decodeScratchPadBootstrap(json)).toThrow();
  });
  it("reads only a bounded regular file", async () => {
    const { file, root } = await paths();
    expect(readScratchPadBootstrapFile(file)).toEqual(fixture.valid_trace);
    expect(() => readScratchPadBootstrapFile(root)).toThrow(/regular file/);
    await symlink(file, join(root, "link"));
    expect(() => readScratchPadBootstrapFile(join(root, "link"))).toThrow();
    await writeFile(file, " ".repeat(MAX_BOOTSTRAP_BYTES + 1));
    expect(() => readScratchPadBootstrapFile(file)).toThrow(/byte bound/);
  });
  it("authenticates, derives the volume, and persists the full request before creation", async () => {
    const { file, dir } = await paths(),
      service = new Service();
    const pad = (await nativeScratchPadFromEnv(
      { SCRATCHPAD_BOOTSTRAP_FILE: file, SCRATCHPAD_DIR: dir },
      { nc: service.nc, creator },
    ))!;
    await pad.close();
    expect(service.calls.map((call) => call.verb)).toEqual(["info"]);
    const state = await saved(dir);
    expect(state.creation).toEqual(fixture.valid_trace.creation);
    expect(state.admission).toEqual(fixture.valid_trace.admission);
    const resumed = await nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file });
    clients.push(resumed);
    expect((await resumed.describe()).volume.target).toEqual(service.view.target);
    const creation = service.calls.find((call) => call.verb === "volume.create")!.body;
    expect(creation).toEqual({
      volume: "Replies",
      action: fixture.valid_trace.creation,
      admission: fixture.valid_trace.admission,
    });
  });
  it("refuses a principal or custom-volume mismatch before workspace creation", async () => {
    const { file, dir } = await paths(),
      service = new Service();
    service.principal.account = "A".repeat(56);
    await expect(
      nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file }),
    ).rejects.toThrow(/principal/);
    await expect(readFile(join(dir, "scratchpad.sqlite"))).rejects.toThrow();
    service.principal = fixture.valid.principal;
    await expect(
      nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file, volume: "Custom" }),
    ).rejects.toThrow(/configured volume/);
    expect(service.calls.every((call) => call.verb === "info")).toBe(true);
  });
  it("refuses a changed first-import admission before saving state", async () => {
    const { file, dir } = await paths(),
      service = new Service();
    service.scope = { ...service.scope!, admission: { ...fixture.valid.admission, generation: 8 } };
    await expect(
      nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file }),
    ).rejects.toMatchObject({ code: "fenced" });
    expect(await saved(dir)).toBeUndefined();
    expect(service.calls.map((call) => call.verb)).toEqual(["info"]);
  });
  it("preserves SQLite bytes on matching import and full-Trace mismatch", async () => {
    const { file, dir } = await paths(),
      service = new Service();
    const pad = await nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file });
    await pad.close();
    const store = await WorkspaceStore.open(dir),
      state = store.load() as Wire;
    store.save({
      ...state,
      target: service.view.target,
      writer: { slot: 0, generation: 2 },
      next: 8,
      pending: { kind: "reset", writer: { slot: 0, generation: 2 } },
    });
    store.close();
    const before = await readFile(join(dir, "scratchpad.sqlite"));
    const same = await nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file });
    await same.close();
    expect(await readFile(join(dir, "scratchpad.sqlite"))).toEqual(before);
    const changed = structuredClone(fixture.valid_trace);
    changed.creation.trace.tool_call_id = "different";
    await writeFile(file, JSON.stringify(changed));
    await expect(
      nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file }),
    ).rejects.toThrow(/creation request/);
    expect(await readFile(join(dir, "scratchpad.sqlite"))).toEqual(before);
    expect(service.calls.every((call) => call.verb === "info")).toBe(true);
  });
  it("replays unknown creation from saved state without current discovery or admin ensure", async () => {
    const { file, dir } = await paths(),
      service = new Service();
    service.dropCreate = true;
    const pad = await nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file });
    await expect(pad.describe()).rejects.toMatchObject({ unknown: true });
    await pad.close();
    service.scope = undefined;
    const resumed = await nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file });
    clients.push(resumed);
    expect((await resumed.describe()).volume.target).toEqual(service.view.target);
    const attempts = service.calls.filter((call) => call.verb === "volume.create");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.body).toEqual(attempts[1]!.body);
    expect(service.calls.every((call) => ["info", "volume.create"].includes(call.verb))).toBe(true);
  });
  it("never adopts an existence refusal or reopens a disposed workspace", async () => {
    const { file, dir } = await paths(),
      service = new Service();
    service.createCode = "exists";
    const pad = await nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file });
    await expect(pad.describe()).rejects.toMatchObject({ code: "exists", unknown: false });
    await pad.close();
    const store = await WorkspaceStore.open(dir),
      state = store.load() as Wire;
    expect(state.target).toBeUndefined();
    store.save({
      ...state,
      target: service.view.target,
      disposal: {
        target: service.view.target,
        slot: 0,
        generation: 7,
        operation_id: "release",
        disposed: true,
        capacity_returned: true,
      },
    });
    store.close();
    const before = await readFile(join(dir, "scratchpad.sqlite"));
    await expect(
      nativeScratchPad({ nc: service.nc, dir, creator, bootstrapFile: file }),
    ).rejects.toMatchObject({ code: "fenced" });
    expect(await readFile(join(dir, "scratchpad.sqlite"))).toEqual(before);
    expect(service.calls.filter((call) => call.verb === "volume.create")).toHaveLength(1);
  });
});
