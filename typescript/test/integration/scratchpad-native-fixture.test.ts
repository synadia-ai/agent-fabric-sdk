import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NativeServiceFixture } from "../harness/scratchpad-native.js";

const coreRoot = process.env["SCRATCHPAD_CORE_ROOT"];
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

describe.skipIf(!coreRoot)("native ScratchPad fixture protocol boundary", () => {
  let fixture: NativeServiceFixture;
  const clients = new Map<string, NatsConnection>();

  beforeAll(async () => {
    fixture = await NativeServiceFixture.start(coreRoot!);
    for (const [name, user] of Object.entries(fixture.config.users)) {
      const nc = await connect({
        servers: fixture.config.url,
        authenticator: credsAuthenticator(await readFile(user.credentials)),
        reconnect: false,
      });
      clients.set(name, nc);
      await nc.flush();
    }
  }, 120_000);

  afterAll(async () => {
    for (const nc of clients.values()) await nc.close();
    if (fixture) {
      const counts = await fixture.close();
      console.info("NATIVE_FIXTURE", JSON.stringify(counts));
    }
  });

  it("authenticates three distinct users and serves Go bytes through the activated import", async () => {
    expect(fixture.config.storage).toBe("file");
    expect(new Set(Object.values(fixture.config.users).map((user) => user.user)).size).toBe(3);
    for (const [name, nc] of clients) {
      const reply = await nc.request("sp.v1.api.v2.info", encode({}), { timeout: 5000 });
      const info = reply.json<{ principal: { account: string; user: string } }>();
      const user = fixture.config.users[name as keyof typeof fixture.config.users];
      expect(info.principal).toEqual({ account: user.account, user: user.user });
    }
    const publication = await fixture.command<{
      reference: string;
      bytes: number;
      sha256: string;
      receipt: { head: { generation: number; root: string } };
    }>("go_publish", { path: "/go.bin", bytes: 4097 });
    const reference = JSON.parse(
      Buffer.from(publication.reference.slice("sp-ref:".length), "base64url").toString(),
    ) as { target: { volume: string; creation_id: string }; root: string; path: string };
    const request = {
      target: reference.target,
      root: reference.root,
      path: reference.path,
      trace: {},
      offset: 0,
      length: 4097,
    };
    const received = await clients
      .get("reader")!
      .request("sp.v1.api.v2.content.read", encode(request), { timeout: 5000 });
    expect(JSON.parse(received.headers!.get("ScratchPad-Reply"))).toMatchObject({ code: "ok" });
    expect(Uint8Array.from(received.data)).toEqual(
      Uint8Array.from({ length: 4097 }, (_, index) => index % 251),
    );
    expect(createHash("sha256").update(received.data).digest("hex")).toBe(publication.sha256);
    const denied = await clients
      .get("intruder")!
      .request("sp.v1.api.v2.content.read", encode(request), { timeout: 5000 });
    expect(JSON.parse(denied.headers!.get("ScratchPad-Reply"))).toMatchObject({ code: "denied" });
    expect(denied.data.byteLength).toBe(0);
    const observed = await fixture.command<{ bytes: number; sha256: string }>("go_read", {
      user: "reader",
      reference: publication.reference,
    });
    expect(observed).toMatchObject({ bytes: publication.bytes, sha256: publication.sha256 });
    const fault = await connect({
      servers: fixture.config.fault_url,
      authenticator: credsAuthenticator(await readFile(fixture.config.users.owner.credentials)),
      reconnect: false,
    });
    clients.set("fault", fault);
    await fault.flush();
    await fixture.command("drop_publish", { operation_id: "fixture-lost-reply" });
    const publicationRequest = {
      target: reference.target,
      command: {
        creation_id: reference.target.creation_id,
        writer: { slot: 1, generation: 1 },
        number: 1,
        operation_id: "fixture-lost-reply",
        base: publication.receipt.head,
        root: reference.root,
        trace: {},
        retention: { enabled: false, slot: 0, generation: 0, until: 0 },
      },
    };
    await expect(
      fault.request("sp.v1.api.v2.checkpoint.publish", encode(publicationRequest), {
        timeout: 500,
      }),
    ).rejects.toThrow();
    const accepted = await fixture.command<{ receipt: unknown }>("accepted", {
      operation_id: "fixture-lost-reply",
    });
    await fixture.command("restart_service");
    const recovered = await clients
      .get("owner")!
      .request("sp.v1.api.v2.checkpoint.publish", encode(publicationRequest), { timeout: 5000 });
    expect(recovered.json()).toEqual(accepted.receipt);
    console.info(
      "NATIVE_FIXTURE_PROTOCOL users=3 exact_bytes=4097 denied_readers=1 go_reads=1 dropped_reply=1 service_restart=1 exact_receipt=1",
    );
  });
});
