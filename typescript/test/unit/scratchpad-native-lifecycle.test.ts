import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headers, type Msg, type NatsConnection } from "@nats-io/nats-core";
import { afterEach, describe, expect, it } from "vitest";
import { nativeScratchPad } from "../../src/scratchpad-native/client";
import { WorkspaceStore } from "../../src/scratchpad-native/store";
import { ScratchPadTransport } from "../../src/scratchpad-native/transport";
import { encodeTreeNode, treeNodeID } from "../../src/scratchpad-native/codec";
import * as p from "../../src/scratchpad-native/protocol";

const principal: p.Principal = {
  account: "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS",
  user: "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA",
};
const admission: p.AdmissionBinding = { slot: 0, generation: 7, operation_id: "admit-7" };
const target: p.Target = { volume: "Replies", creation_id: "ab".repeat(16) };
const root = treeNodeID(encodeTreeNode([]));
function initial(): p.VolumeView {
  return {
    target,
    owner: principal,
    head: { generation: 1, root },
    revision: 1,
    closed: false,
    epoch: 0,
    objects: 1,
    bytes: 4,
    writers: Array.from({ length: 8 }, (_, slot) => ({
      generation: 1,
      number: 0,
      write: slot === 0,
      ...(slot === 0 ? { principal } : {}),
    })),
    retentions: Array.from({ length: 8 }, () => ({ generation: 0 })),
    grants: Array.from({ length: 16 }, () => ({ generation: 0 })),
    lifetime: {
      admission,
      phase: "active",
      expires_at: 1900000000,
      grace_until: 0,
      max_lease_seconds: 3600,
      grace_seconds: 60,
      recovery_reads: true,
      reserve_objects: 128,
      reserve_bytes: 8 * 2 ** 20,
    },
  };
}
function response(value: unknown, code: p.Code = "ok"): Msg {
  const h = headers();
  h.set(p.REPLY_HEADER, p.goJSON({ code, message: code === "ok" ? "" : "unsupported" }));
  return {
    headers: h,
    data: code === "ok" ? Buffer.from(p.goJSON(value)) : new Uint8Array(),
  } as unknown as Msg;
}
class Service {
  scope: p.ReservedScope | undefined = {
    volume: target.volume,
    objects: 100,
    bytes: 1 << 20,
    admission,
  };
  view = initial();
  calls: { verb: string; body: Record<string, unknown> }[] = [];
  drop = "";
  block = "";
  deny = "";
  dropFollowup = "";
  capacityReturned = false;
  releaseCode?: p.Code;
  renewCode?: p.Code;
  releasePlanOverride: Partial<p.VolumeReleasePlan> = {};
  changedReply = "";
  readonly nc = {
    info: { max_payload: 1 << 20, headers: true },
    isClosed: () => false,
    isDraining: () => false,
    flush: async () => {},
    request: (subject: string, data: Uint8Array) => {
      const verb = subject.slice(p.SUBJECT_PREFIX.length);
      const body = JSON.parse(Buffer.from(data).toString()) as Record<string, unknown>;
      this.calls.push({ verb, body });
      if (this.block === verb) return Promise.reject(Error("request withheld before acceptance"));
      if (this.deny === verb) return Promise.resolve(response({}, "closed"));
      if (verb === "volume.release.apply" && this.releaseCode)
        return Promise.resolve(response({}, this.releaseCode));
      if (verb === "volume.renew" && this.renewCode)
        return Promise.resolve(response({}, this.renewCode));
      let value: unknown;
      switch (verb) {
        case "reference.info":
          return Promise.resolve(response({}, "invalid"));
        case "object.prepare":
          value = {
            epoch: this.view.epoch,
            objects: (body.objects as p.ObjectSpec[]).map((object) => ({
              ...object,
              state: "verified",
              next: 0,
              code: "ok",
            })),
          };
          break;
        case "checkpoint.publish": {
          const command = body.command as p.Command;
          value = {
            volume: target.volume,
            principal,
            command,
            head: { generation: command.base.generation + 1, root: command.root },
            retention: { slot: command.retention.slot, generation: 3 },
          };
          break;
        }
        case "maintenance.close":
          if (body.revision !== this.view.revision)
            return Promise.resolve(response({}, "conflict"));
          this.view.revision++;
          this.view.closed = true;
          this.view.epoch = this.view.revision;
          value = this.view;
          break;
        case "info":
          value = { principal, scopes: this.scope ? [this.scope] : [], limits: p.PUBLIC_LIMITS };
          break;
        case "volume.create":
        case "volume.get":
          value = this.view;
          break;
        case "writer.reset":
          this.view.revision = 2;
          this.view.writers[0]!.generation = 2;
          value = { slot: 0, generation: 2 };
          break;
        case "volume.renew":
          this.view.lifetime!.expires_at = body.until as number;
          this.view.lifetime!.phase = "active";
          this.view.lifetime!.grace_until = 0;
          value = this.view;
          break;
        case "volume.remove.plan":
          value = {
            ...body,
            slot: admission.slot,
            generation: admission.generation,
            sequence: 42,
            added_objects: 1,
            added_bytes: 4,
          };
          break;
        case "volume.remove.apply": {
          const command = body.command as p.Command;
          value = {
            volume: target.volume,
            principal,
            command,
            head: { generation: command.base.generation + 1, root: command.root },
            retention: { slot: 0, generation: 0 },
          };
          break;
        }
        case "volume.release.plan":
          value = {
            request: body,
            incarnation: "ab".repeat(32),
            slot: admission.slot,
            generation: admission.generation,
            sequence: 43,
            head: this.view.head,
            effects: {
              objects: 1,
              bytes: 4,
              retentions: 1,
              read_grants: 1,
              access_slots: 1,
              references: 1,
            },
            ...this.releasePlanOverride,
          };
          break;
        case "volume.release.apply":
          value = {
            target,
            slot: admission.slot,
            generation: admission.generation,
            operation_id: (body.request as p.VolumeReleaseRequest).operation_id,
            disposed: true,
            capacity_returned: this.capacityReturned,
          };
          break;
        default:
          throw Error(`unexpected request ${verb}`);
      }
      if (this.drop === verb) {
        this.drop = this.dropFollowup;
        this.dropFollowup = "";
        return Promise.reject(Error("accepted response withheld"));
      }
      if (this.changedReply === verb) {
        const changed = structuredClone(value) as Record<string, unknown>;
        if (verb === "volume.create") (changed.lifetime as p.LifetimeView).admission.generation++;
        else if (verb === "volume.remove.apply")
          (changed.command as p.Command).remove_path = "/other";
        else changed.generation = admission.generation + 1;
        value = changed;
      }
      if (typeof value === "object" && value !== null && "command" in value) {
        const command = structuredClone(value.command) as p.Command;
        command.trace = Object.fromEntries(
          Object.entries(command.trace).filter(([, entry]) => entry !== ""),
        );
        value = { ...value, command };
      }
      return Promise.resolve(response(value));
    },
  } as unknown as NatsConnection;
  open(dir: string) {
    return nativeScratchPad({ nc: this.nc, volume: target.volume, creator: "agents.writer", dir });
  }
}
const directories: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-lifetime-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("reusable native lifetimes", () => {
  it("saves admission before creation and replays exactly after restart", async () => {
    const service = new Service(),
      dir = await directory();
    let client = await service.open(dir);
    service.drop = "volume.create";
    await expect(client.recover()).rejects.toMatchObject({ unknown: true });
    await client.close();
    const store = await WorkspaceStore.open(dir);
    expect(store.load()).toMatchObject({ admission });
    store.close();
    client = await service.open(dir);
    await client.recover();
    await client.close();
    const creates = service.calls.filter((call) => call.verb === "volume.create");
    expect(creates).toHaveLength(2);
    expect(creates[1]).toEqual(creates[0]);
  });
  it.each([false, true])(
    "never adopts a new admission for saved unfinished creation (legacy=%s)",
    async (legacy) => {
      const service = new Service(),
        dir = await directory();
      if (legacy) {
        delete service.scope!.admission;
        delete service.view.lifetime;
      }
      const client = await service.open(dir);
      service.drop = "volume.create";
      await expect(client.recover()).rejects.toMatchObject({ unknown: true });
      await client.close();
      service.scope = {
        volume: target.volume,
        objects: 100,
        bytes: 1 << 20,
        admission: { ...admission, generation: 8 },
      };
      await expect(service.open(dir)).rejects.toMatchObject({ code: "fenced", local: true });
      expect(service.calls.filter((call) => call.verb === "volume.create")).toHaveLength(1);
    },
  );
  it("persists one absolute renewal and rejects changed intent after reply loss", async () => {
    const service = new Service(),
      dir = await directory();
    let client = await service.open(dir);
    await client.recover();
    service.drop = "volume.renew";
    await expect(client.renewLease(1900000300)).rejects.toMatchObject({ unknown: true });
    await expect(client.renewLease(1900000400)).rejects.toMatchObject({ code: "busy" });
    await client.close();
    client = await service.open(dir);
    expect((await client.recover()).volume?.lifetime?.expires_at).toBe(1900000300);
    await client.close();
    const renewals = service.calls.filter((call) => call.verb === "volume.renew");
    expect(renewals).toHaveLength(2);
    expect(renewals[1]).toEqual(renewals[0]);
  });
  it.each(["writer.reset", "maintenance.close"])(
    "renews during grace while preserving an unknown %s across restart",
    async (blocked) => {
      const service = new Service(),
        dir = await directory();
      let client = await service.open(dir);
      if (blocked === "maintenance.close") await client.recover();
      service.block = blocked;
      await expect(
        blocked === "writer.reset" ? client.recover() : client.maintain(),
      ).rejects.toMatchObject({ unknown: true });
      await client.close();
      let store = await WorkspaceStore.open(dir);
      const original = store.load() as { pending: unknown; writer?: unknown; target: p.Target };
      expect(original.target).toEqual(target);
      if (blocked === "writer.reset") expect(original.writer).toBeUndefined();
      const originalBytes = JSON.stringify(original.pending);
      store.close();
      service.view.lifetime!.phase = "expiring";
      service.view.lifetime!.grace_until = 1900000060;
      client = await service.open(dir);
      service.deny = "volume.renew";
      await expect(client.renewLease(1900000299)).rejects.toMatchObject({
        code: "closed",
        unknown: false,
      });
      service.deny = "";
      service.drop = "volume.renew";
      await expect(client.renewLease(1900000300)).rejects.toMatchObject({ unknown: true });
      await expect(client.renewLease(1900000400)).rejects.toMatchObject({ code: "busy" });
      const beforeMutation = service.calls.length;
      await expect(client.resetWriter({ expectedGeneration: 2 })).rejects.toMatchObject({
        code: "busy",
      });
      expect(service.calls).toHaveLength(beforeMutation);
      await client.close();
      store = await WorkspaceStore.open(dir);
      const saved = store.load() as { pending: unknown; renewal: p.RenewRequest };
      expect(JSON.stringify(saved.pending)).toBe(originalBytes);
      expect(saved.renewal).toEqual({ target, until: 1900000300 });
      store.close();
      client = await service.open(dir);
      const beforeRecovery = service.calls.length;
      expect((await client.recover()).kind).toBe("renew");
      expect(service.calls.slice(beforeRecovery).map((call) => call.verb)).toEqual([
        "volume.renew",
      ]);
      await client.close();
      store = await WorkspaceStore.open(dir);
      const after = store.load() as { pending: unknown; renewal?: unknown };
      expect(JSON.stringify(after.pending)).toBe(originalBytes);
      expect(after.renewal).toBeUndefined();
      store.close();
      expect(
        service.calls
          .filter((call) => call.verb === "volume.renew" && call.body.until === 1900000300)
          .map((call) => call.body),
      ).toEqual([
        { target, until: 1900000300 },
        { target, until: 1900000300 },
      ]);
    },
  );
  it("renews the saved target when lost creation recovers but initializer reset is refused", async () => {
    const service = new Service(),
      dir = await directory();
    let client = await service.open(dir);
    service.drop = "volume.create";
    await expect(client.recover()).rejects.toMatchObject({ unknown: true });
    await client.close();
    service.view.lifetime!.phase = "expiring";
    service.view.lifetime!.grace_until = 1900000060;
    service.deny = "writer.reset";
    client = await service.open(dir);
    await expect(client.recover()).rejects.toMatchObject({ code: "closed", unknown: false });
    const before = service.calls.length;
    expect((await client.renewLease(1900000300)).lifetime!.phase).toBe("active");
    expect(service.calls.slice(before).map((call) => call.verb)).toEqual(["volume.renew"]);
    await client.close();
    const store = await WorkspaceStore.open(dir);
    expect(store.load()).toMatchObject({ target, admission });
    expect(store.load()).not.toHaveProperty("writer");
    store.close();
    const creates = service.calls.filter((call) => call.verb === "volume.create");
    expect(creates).toHaveLength(2);
    expect(creates[0]).toEqual(creates[1]);
  });
  it("replays the former pending renewal shape without replacing its deadline", async () => {
    const service = new Service(),
      dir = await directory();
    let client = await service.open(dir);
    await client.recover();
    service.drop = "volume.renew";
    await expect(client.renewLease(1900000300)).rejects.toMatchObject({ unknown: true });
    await client.close();
    const store = await WorkspaceStore.open(dir);
    const state = store.load() as Record<string, unknown>;
    state.pending = { kind: "renew", request: state.renewal };
    delete state.renewal;
    store.save(state);
    store.close();
    client = await service.open(dir);
    await expect(client.renewLease(1900000400)).rejects.toMatchObject({ code: "busy" });
    expect((await client.recover()).volume?.lifetime?.expires_at).toBe(1900000300);
    await client.close();
    const renewals = service.calls.filter((call) => call.verb === "volume.renew");
    expect(renewals).toHaveLength(2);
    expect(renewals[0]).toEqual(renewals[1]);
  });
  it("settles an expired unaccepted renewal without changing the ordinary pending intent", async () => {
    const service = new Service(),
      dir = await directory();
    let client = await service.open(dir);
    await client.recover();
    service.block = "maintenance.close";
    await expect(client.maintain()).rejects.toMatchObject({ unknown: true });
    service.block = "volume.renew";
    await expect(client.renewLease(1900000300)).rejects.toMatchObject({ unknown: true });
    await client.close();
    let store = await WorkspaceStore.open(dir);
    const original = store.load() as { pending: unknown; renewal: p.RenewRequest };
    const pendingBytes = JSON.stringify(original.pending);
    store.close();
    service.block = "";
    service.renewCode = "invalid";
    client = await service.open(dir);
    await expect(client.recover()).rejects.toMatchObject({ unknown: true });
    service.renewCode = "expired";
    await expect(client.recover()).rejects.toMatchObject({ code: "expired", unknown: false });
    await client.close();
    store = await WorkspaceStore.open(dir);
    const expired = store.load() as { pending: unknown; renewal?: unknown };
    expect(expired.renewal).toBeUndefined();
    expect(JSON.stringify(expired.pending)).toBe(pendingBytes);
    store.close();
    delete service.renewCode;
    client = await service.open(dir);
    expect((await client.renewLease(1900000400)).lifetime?.expires_at).toBe(1900000400);
    await client.close();
    store = await WorkspaceStore.open(dir);
    expect(JSON.stringify((store.load() as { pending: unknown }).pending)).toBe(pendingBytes);
    store.close();
    expect(service.calls.filter((call) => call.verb === "maintenance.close")).toHaveLength(1);
    expect(
      service.calls.filter((call) => call.verb === "volume.renew").map((call) => call.body),
    ).toEqual([
      original.renewal,
      original.renewal,
      original.renewal,
      { target, until: 1900000400 },
    ]);
  });
  it("settles an expired renewal in the former pending shape", async () => {
    const service = new Service(),
      dir = await directory();
    let client = await service.open(dir);
    await client.recover();
    service.block = "volume.renew";
    await expect(client.renewLease(1900000300)).rejects.toMatchObject({ unknown: true });
    await client.close();
    let store = await WorkspaceStore.open(dir);
    const saved = store.load() as Record<string, unknown>;
    saved.pending = { kind: "renew", request: saved.renewal };
    delete saved.renewal;
    store.save(saved);
    store.close();
    service.block = "";
    service.renewCode = "expired";
    client = await service.open(dir);
    await expect(client.recover()).rejects.toMatchObject({ code: "expired", unknown: false });
    await client.close();
    store = await WorkspaceStore.open(dir);
    expect(store.load()).not.toHaveProperty("pending");
    store.close();
  });
  it("settles an unaccepted release only after a newer plan proves the saved fence cannot win", async () => {
    const service = new Service(),
      dir = await directory();
    let client = await service.open(dir);
    await client.recover();
    const plan = await client.planVolumeRelease({
      operationId: "release-fenced",
      endPromises: true,
    });
    service.block = "volume.release.apply";
    await expect(client.applyVolumeRelease(plan)).rejects.toMatchObject({ unknown: true });
    await client.close();
    service.block = "";
    service.releaseCode = "conflict";
    service.releasePlanOverride = { sequence: plan.sequence + 1 };
    client = await service.open(dir);
    const before = service.calls.length;
    await expect(client.recover()).rejects.toMatchObject({ code: "fenced", unknown: false });
    expect(service.calls.slice(before).map((call) => call.verb)).toEqual([
      "volume.release.apply",
      "volume.release.plan",
    ]);
    expect(service.calls.at(-1)?.body).toEqual(plan.request);
    await client.close();
    const store = await WorkspaceStore.open(dir);
    expect(store.load()).not.toHaveProperty("pending");
    expect(store.load()).not.toHaveProperty("disposal");
    store.close();
    client = await service.open(dir);
    expect((await client.renewLease(1900000400)).lifetime?.expires_at).toBe(1900000400);
    const fresh = await client.planVolumeRelease({
      operationId: "release-replanned",
      endPromises: true,
    });
    expect(fresh.sequence).toBe(plan.sequence + 1);
    await client.close();
  });
  it.each([
    "same-position",
    "incarnation",
    "slot",
    "generation",
    "target",
    "unavailable",
    "accepted",
  ])("retains release intent when newer nonterminal evidence is absent (%s)", async (missing) => {
    const service = new Service(),
      dir = await directory();
    let client = await service.open(dir);
    await client.recover();
    const plan = await client.planVolumeRelease({
      operationId: "release-proof",
      endPromises: true,
    });
    if (missing === "accepted") await client.applyVolumeRelease(plan);
    else {
      service.block = "volume.release.apply";
      await expect(client.applyVolumeRelease(plan)).rejects.toMatchObject({ unknown: true });
    }
    await client.close();
    let store = await WorkspaceStore.open(dir);
    const original = JSON.stringify((store.load() as { pending: unknown }).pending);
    store.close();
    service.block = missing === "unavailable" ? "volume.release.plan" : "";
    service.releaseCode = "conflict";
    service.releasePlanOverride = { sequence: plan.sequence + 1 };
    if (missing === "same-position") service.releasePlanOverride.sequence = plan.sequence;
    if (missing === "incarnation") service.releasePlanOverride.incarnation = "cd".repeat(32);
    if (missing === "slot") service.releasePlanOverride.slot = plan.slot + 1;
    if (missing === "generation") service.releasePlanOverride.generation = plan.generation + 1;
    if (missing === "target")
      service.releasePlanOverride.request = {
        ...plan.request,
        target: { ...target, creation_id: "cd".repeat(16) },
      };
    client = await service.open(dir);
    const before = service.calls.length;
    await expect(client.recover()).rejects.toMatchObject({ unknown: true });
    if (missing === "accepted")
      expect(service.calls.slice(before).map((call) => call.verb)).toEqual([
        "volume.release.apply",
      ]);
    await client.close();
    store = await WorkspaceStore.open(dir);
    expect(JSON.stringify((store.load() as { pending: unknown }).pending)).toBe(original);
    expect(store.load()).not.toHaveProperty("disposal");
    store.close();
  });
  it("plans without mutation and recovers removal with its exact receipt", async () => {
    const service = new Service(),
      dir = await directory();
    let client = await service.open(dir);
    await client.recover();
    const before = service.calls.length;
    const plan = await client.planRemoval("/obsolete", { operationId: "remove-1" });
    expect(service.calls.slice(before).map((call) => call.verb)).toEqual([
      "volume.get",
      "volume.remove.plan",
    ]);
    service.drop = "volume.remove.apply";
    await expect(client.applyRemoval(plan)).rejects.toMatchObject({ unknown: true });
    await expect(
      client.applyRemoval({ ...plan, sequence: plan.sequence + 1 }),
    ).rejects.toMatchObject({ code: "busy" });
    await client.close();
    client = await service.open(dir);
    const recovered = await client.recover();
    expect(recovered.receipt?.command).toEqual(plan.command);
    expect(recovered.reference).toBeUndefined();
    expect(await client.applyRemoval(plan)).toEqual(recovered.receipt);
    await client.close();
    const applies = service.calls.filter((call) => call.verb === "volume.remove.apply");
    expect(applies).toHaveLength(2);
    expect(applies[1]).toEqual(applies[0]);
  });
  it("keeps release pending through disposal and reopens without an owned scope", async () => {
    const service = new Service(),
      dir = await directory();
    let client = await service.open(dir);
    await client.recover();
    const review = await client.planVolumeRelease({ operationId: "release-1" });
    expect(review.request.end_promises).toBe(false);
    const plan = await client.planVolumeRelease({ operationId: "release-1", endPromises: true });
    service.drop = "volume.release.apply";
    await expect(client.applyVolumeRelease(plan)).rejects.toMatchObject({ unknown: true });
    await client.close();
    service.scope = undefined;
    client = await service.open(dir);
    expect((await client.recover()).release).toMatchObject({
      disposed: true,
      capacity_returned: false,
    });
    await expect(client.renewLease(1900000500)).rejects.toMatchObject({ code: "busy" });
    await client.close();
    service.capacityReturned = true;
    client = await service.open(dir);
    expect((await client.recover()).release?.capacity_returned).toBe(true);
    const before = service.calls.length;
    expect((await client.applyVolumeRelease(plan)).capacity_returned).toBe(true);
    expect(service.calls).toHaveLength(before);
    await client.close();
    const applies = service.calls.filter((call) => call.verb === "volume.release.apply");
    expect(applies).toHaveLength(3);
    for (const call of applies) expect(call.body).toEqual(plan);
  });
  it.each([false, true])(
    "recovers a retired generation with saved fence acceptance=%s",
    async (accepted) => {
      const service = new Service(),
        dir = await directory();
      let client = await service.open(dir);
      await client.recover();
      const plan = await client.planVolumeRelease({
        operationId: "release-reuse",
        endPromises: true,
      });
      if (!accepted) service.drop = "volume.release.apply";
      if (accepted) expect((await client.applyVolumeRelease(plan)).capacity_returned).toBe(false);
      else await expect(client.applyVolumeRelease(plan)).rejects.toMatchObject({ unknown: true });
      await expect(
        client.applyVolumeRelease({ ...plan, incarnation: "cd".repeat(32) }),
      ).rejects.toMatchObject({ code: "busy" });
      await client.close();
      const store = await WorkspaceStore.open(dir);
      const saved = store.load() as { pending: { fence_accepted?: true } };
      expect(saved.pending.fence_accepted).toBe(accepted ? true : undefined);
      store.close();
      service.scope!.admission = { ...admission, generation: admission.generation + 1 };
      client = await service.open(dir);
      for (const code of ["fenced", "denied", "not_found", "corrupt"] as const) {
        service.releaseCode = code;
        await expect(client.recover()).rejects.toMatchObject({ code, unknown: true });
      }
      await client.close();
      const uncertain = await WorkspaceStore.open(dir);
      expect((uncertain.load() as { pending: unknown }).pending).toEqual(saved.pending);
      expect(uncertain.load()).not.toHaveProperty("disposal");
      uncertain.close();
      service.releaseCode = "generation_retired";
      client = await service.open(dir);
      const recovered = accepted
        ? await client.applyVolumeRelease(plan)
        : (await client.recover()).release!;
      expect(recovered).toEqual({
        target,
        slot: admission.slot,
        generation: admission.generation,
        operation_id: "release-reuse",
        disposed: true,
        capacity_returned: true,
        ...(!accepted ? { acceptance_unknown: true } : {}),
      });
      await client.close();
      client = await service.open(dir);
      const before = service.calls.length;
      expect((await client.recover()).release).toEqual(recovered);
      expect(await client.applyVolumeRelease(plan)).toEqual(recovered);
      await expect(
        client.applyVolumeRelease({ ...plan, incarnation: "cd".repeat(32) }),
      ).rejects.toMatchObject({ code: "invalid", local: true });
      await expect(
        client.applyVolumeRelease({ ...plan, sequence: plan.sequence + 1 }),
      ).rejects.toMatchObject({ code: "invalid", local: true });
      await expect(client.renewLease(1900000500)).rejects.toMatchObject({
        code: "fenced",
        local: true,
      });
      await expect(client.resetWriter({ expectedGeneration: 2 })).rejects.toMatchObject({
        code: "fenced",
        local: true,
      });
      await expect(client.maintain()).rejects.toMatchObject({ code: "fenced", local: true });
      expect(service.calls).toHaveLength(before);
      await client.close();
      const completed = await WorkspaceStore.open(dir);
      expect(completed.load()).toMatchObject({ disposal_plan: plan, admission });
      expect(completed.load()).not.toHaveProperty("pending");
      p.validateVolumeReleaseResult((completed.load() as { disposal: unknown }).disposal);
      completed.close();
    },
  );
  it("requires a canonical release incarnation and keeps local outcome fields off the wire", async () => {
    const service = new Service(),
      transport = new ScratchPadTransport(service.nc);
    const plan = await transport.planVolumeRelease({
      target,
      operation_id: "release",
      end_promises: true,
    });
    for (const incarnation of [undefined, "ab".repeat(31), "AB".repeat(32), "z".repeat(64)])
      expect(() => p.validateVolumeReleasePlan({ ...plan, incarnation })).toThrow();
    expect(() =>
      p.validateVolumeReleaseResult({
        target,
        slot: admission.slot,
        generation: admission.generation,
        operation_id: "release",
        disposed: true,
        capacity_returned: true,
        acceptance_unknown: true,
      }),
    ).toThrow();
  });
  it("treats mismatched creation binding as unknown and rejects removal on checkpoint", async () => {
    const service = new Service(),
      transport = new ScratchPadTransport(service.nc);
    service.changedReply = "volume.create";
    await expect(
      transport.createVolume({
        volume: target.volume,
        action: { operation_id: "create", trace: {} },
        admission,
      }),
    ).rejects.toMatchObject({ unknown: true });
    const command: p.Command = {
      creation_id: target.creation_id,
      writer: { slot: 0, generation: 2 },
      number: 1,
      operation_id: "remove",
      base: { generation: 1, root },
      root,
      trace: { tool_call_id: "" },
      remove_path: "/old",
      retention: { enabled: false, slot: 0, generation: 0, until: 0 },
    };
    const before = service.calls.length;
    await expect(transport.publish({ target, command })).rejects.toMatchObject({
      local: true,
      unknown: false,
    });
    expect(service.calls).toHaveLength(before);
    const plan = await transport.planRemoval({ target, command });
    expect(plan.command.trace).toEqual({});
    expect((await transport.applyRemoval({ ...plan, command })).command.trace).toEqual({});
    service.changedReply = "volume.remove.apply";
    await expect(
      transport.applyRemoval({
        target,
        command,
        slot: 0,
        generation: 7,
        sequence: 42,
        added_objects: 1,
        added_bytes: 4,
      }),
    ).rejects.toMatchObject({ unknown: true });
  });
  it("refuses malformed lease bounds and preserves the legacy absent shape", () => {
    const view = initial();
    p.validateVolumeView(view);
    for (const lifetime of [
      { ...view.lifetime!, admission: { ...admission, generation: 0 } },
      { ...view.lifetime!, grace_until: 1 },
      { ...view.lifetime!, reserve_objects: 0 },
    ])
      expect(() => p.validateVolumeView({ ...view, lifetime })).toThrow();
    delete view.lifetime;
    expect(() => p.validateVolumeView(view)).not.toThrow();
  });
  it("caps only new retention at the observed lease and preserves it across renewal", async () => {
    const service = new Service(),
      dir = await directory();
    const deadline = Math.floor(Date.now() / 1000) + 120;
    service.view.lifetime!.expires_at = deadline;
    let client = await service.open(dir);
    await client.recover();
    service.drop = "checkpoint.publish";
    await expect(
      client.publishBytes(Buffer.from("kept"), "/result", {
        operationId: "publish-lease",
        ttlSeconds: 600,
      }),
    ).rejects.toMatchObject({ unknown: true });
    await client.close();
    service.view.lifetime!.expires_at = deadline + 300;
    client = await service.open(dir);
    expect((await client.recover()).receipt?.command.retention.until).toBe(deadline);
    await client.close();
    const sent = service.calls.filter((call) => call.verb === "checkpoint.publish");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });
  it("refuses elapsed retention before saving or sending artifact mutations", async () => {
    const service = new Service(),
      dir = await directory();
    service.view.lifetime!.expires_at = Math.floor(Date.now() / 1000) - 1;
    const client = await service.open(dir);
    await client.recover();
    await expect(
      client.publishBytes(Buffer.from("expired"), "/result", { operationId: "expired" }),
    ).rejects.toMatchObject({ code: "expired", local: true, unknown: false });
    await client.close();
    expect(
      service.calls.filter(
        (call) => call.verb.startsWith("object.") || call.verb === "checkpoint.publish",
      ),
    ).toHaveLength(0);
    const store = await WorkspaceStore.open(dir);
    expect(store.load()).not.toHaveProperty("pending");
    store.close();
  });
  it.each([false, true])(
    "observes a lost close after private reopening (superseded=%s)",
    async (superseded) => {
      const service = new Service(),
        dir = await directory();
      let client = await service.open(dir);
      await client.recover();
      service.drop = "maintenance.close";
      service.dropFollowup = "volume.get";
      await expect(client.maintain()).rejects.toMatchObject({ unknown: true });
      await client.close();
      const closedEpoch = service.view.epoch;
      service.view.closed = false;
      service.view.revision += 2;
      if (superseded) service.view.epoch = service.view.revision;
      client = await service.open(dir);
      if (superseded) {
        await expect(client.recover()).rejects.toMatchObject({ code: "fenced" });
        expect((await client.renewLease(1900000100)).lifetime!.expires_at).toBe(1900000100);
      } else expect((await client.recover()).kind).toBe("close");
      await client.close();
      expect(service.calls.filter((call) => call.verb === "maintenance.apply")).toHaveLength(0);
      const closes = service.calls.filter((call) => call.verb === "maintenance.close");
      expect(closes).toHaveLength(2);
      for (const close of closes) expect(close.body.revision).toBe(closedEpoch - 1);
      const store = await WorkspaceStore.open(dir);
      expect(store.load()).not.toHaveProperty("pending");
      store.close();
    },
  );
  it.each([false, true])(
    "observes only its saved private collection epoch (superseded=%s)",
    async (superseded) => {
      const service = new Service(),
        dir = await directory();
      let client = await service.open(dir);
      await client.recover();
      await expect(client.maintain()).rejects.toMatchObject({ code: "closed" });
      await client.close();
      service.view.closed = false;
      service.view.revision++;
      if (superseded) service.view.epoch++;
      client = await service.open(dir);
      if (superseded) {
        await expect(client.recover()).rejects.toMatchObject({ code: "fenced" });
        expect((await client.renewLease(1900000100)).lifetime!.expires_at).toBe(1900000100);
      } else expect((await client.recover()).kind).toBe("apply");
      await client.close();
      expect(service.calls.filter((call) => call.verb === "maintenance.apply")).toHaveLength(0);
      const store = await WorkspaceStore.open(dir);
      expect(store.load()).not.toHaveProperty("pending");
      store.close();
    },
  );
});
