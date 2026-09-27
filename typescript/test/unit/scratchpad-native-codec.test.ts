import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE,
  CodecError,
  chunkID,
  chunkStream,
  decodeReference,
  encodeDirectory,
  encodeFileObject,
  encodeReference,
  encodeTreeNode,
  fileObjectID,
  treeNodeID,
  verifyObject,
} from "../../src/scratchpad-native/codec";
import type { Directory, Reference, TreeEntry } from "../../src/scratchpad-native/codec";
import { normalizeUnicode15, validatePublicKey } from "../../src/scratchpad-native/protocol";

interface FixtureEntry {
  name?: string;
  name_hex?: string;
  type: "file" | "dir" | "symlink";
  id_hex?: string;
  target?: string;
  executable?: boolean;
}
interface Fixture {
  name: string;
  kind: "chunk" | "file" | "tree" | "deep_tree" | "wide_tree";
  mode?: "decode";
  encoded_hex?: string;
  id?: string;
  reject?: string;
  object?: {
    content_hex?: string;
    content_repeat?: { byte_hex: string; count: number };
    entries?: FixtureEntry[];
    depth?: number;
    dir_name?: string;
    leaf?: FixtureEntry;
    count?: number;
    name_prefix?: string;
    pad?: number;
    id_hex?: string;
    extra_name?: string;
  };
  expect?: {
    id: string;
    canonical_hex?: string;
    canonical_length: number;
    canonical_sha256: string;
  };
}
const directory = fileURLToPath(
  new URL("../../../test-fixtures/scratchpad/codec/", import.meta.url),
);
const manifest = readFileSync(directory + "/manifest.txt", "utf8")
  .trim()
  .split("\n");
const fixtures = manifest.map(
  (name) => JSON.parse(readFileSync(directory + "/" + name, "utf8")) as Fixture,
);
const idFromHex = (hex: string): string => Buffer.from(hex, "hex").toString("base64url");
function entry(raw: FixtureEntry): TreeEntry {
  let name = raw.name!;
  if (raw.name_hex !== undefined) {
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(raw.name_hex, "hex"));
    } catch {
      name = "\ud800";
    }
  }
  return {
    name,
    type: raw.type === "dir" ? "directory" : raw.type,
    ...(raw.id_hex === undefined ? {} : { object: idFromHex(raw.id_hex) }),
    ...(raw.target === undefined ? {} : { linkTarget: raw.target }),
    ...(raw.executable === undefined ? {} : { executable: raw.executable }),
  };
}
async function run(fixture: Fixture): Promise<{ bytes: Uint8Array; id: string }> {
  if (fixture.mode === "decode") {
    const bytes = Buffer.from(fixture.encoded_hex!, "hex"),
      id = idFromHex(fixture.id!);
    const kind = fixture.kind === "chunk" ? "chnk" : fixture.kind === "file" ? "fobj" : "tree";
    verifyObject({ kind, id }, bytes);
    return { bytes, id };
  }
  const object = fixture.object!;
  if (fixture.kind === "chunk" || fixture.kind === "file") {
    const raw =
      object.content_hex === undefined
        ? Buffer.alloc(
            object.content_repeat!.count,
            Buffer.from(object.content_repeat!.byte_hex, "hex"),
          )
        : Buffer.from(object.content_hex, "hex");
    if (fixture.kind === "chunk") {
      const id = chunkID(raw);
      verifyObject({ kind: "chnk", id }, raw);
      return { bytes: raw, id };
    }
    const file = await chunkStream([raw], () => {}),
      bytes = encodeFileObject(file);
    return { bytes, id: fileObjectID(bytes) };
  }
  if (fixture.kind === "deep_tree") {
    let dir: Directory = { entries: [entry(object.leaf!)] };
    for (let index = 1; index < object.depth!; index++)
      dir = { entries: [{ name: object.dir_name!, type: "directory", child: dir }] };
    const result = encodeDirectory(dir);
    return { bytes: result.nodes.get(result.root)!, id: result.root };
  }
  let entries: TreeEntry[];
  if (fixture.kind === "wide_tree") {
    entries = Array.from({ length: object.count! }, (_, index) => ({
      name: object.name_prefix! + index.toString().padStart(object.pad ?? 4, "0"),
      type: "file",
      object: idFromHex(object.id_hex!),
    }));
    if (object.extra_name)
      entries.push({ name: object.extra_name, type: "file", object: idFromHex(object.id_hex!) });
  } else entries = object.entries!.map(entry);
  const bytes = encodeTreeNode(entries);
  return { bytes, id: treeNodeID(bytes) };
}
describe("ScratchPad canonical codec fixtures", () => {
  it("covers exactly the 47 Go fixture files", () => {
    expect(manifest).toHaveLength(47);
    expect(
      readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort(),
    ).toEqual([...manifest].sort());
  });
  for (const fixture of fixtures)
    it(fixture.name, async () => {
      if (fixture.reject) {
        await expect(run(fixture)).rejects.toMatchObject({ reason: fixture.reject });
        return;
      }
      const result = await run(fixture),
        wanted = fixture.expect!;
      expect(Buffer.from(result.id, "base64url").toString("hex")).toBe(wanted.id);
      expect(result.bytes.length).toBe(wanted.canonical_length);
      expect(createHash("sha256").update(result.bytes).digest("hex")).toBe(wanted.canonical_sha256);
      if (wanted.canonical_hex)
        expect(Buffer.from(result.bytes).toString("hex")).toBe(wanted.canonical_hex);
      const kind = fixture.kind === "chunk" ? "chnk" : fixture.kind === "file" ? "fobj" : "tree";
      expect(() => verifyObject({ kind, id: result.id }, result.bytes)).not.toThrow();
      const wrong = Uint8Array.from(result.bytes);
      wrong[wrong.length - 1] = wrong[wrong.length - 1]! ^ 1;
      expect(() => verifyObject({ kind, id: result.id }, wrong)).toThrow();
    });
  it("chunks arbitrary stream boundaries into fixed chunks and an exact digest", async () => {
    const input = Buffer.alloc(CHUNK_SIZE * 2 + 19, 0xa3),
      emitted: Uint8Array[] = [];
    function* source(): Generator<Uint8Array> {
      yield input.subarray(0, 3);
      yield input.subarray(3, CHUNK_SIZE + 7);
      yield input.subarray(CHUNK_SIZE + 7);
    }
    const file = await chunkStream(source(), (_index, object, bytes) => {
      expect(object.id).toBe(chunkID(bytes));
      emitted.push(Uint8Array.from(bytes));
    });
    expect(file.chunks.map((chunk) => chunk.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 19]);
    expect(Buffer.concat(emitted)).toEqual(input);
    expect(file.digest).toBe(createHash("sha256").update(input).digest("hex"));
  });
  it("propagates a spool failure without returning a prepared file", async () => {
    const disk = new Error("disk full");
    await expect(
      chunkStream([Buffer.alloc(CHUNK_SIZE + 1)], () => {
        throw disk;
      }),
    ).rejects.toBe(disk);
  });
  it("keeps Unicode 15 unassigned characters inert on newer Node versions", () => {
    expect(normalizeUnicode15("q\u0301\u{10EFD}")).not.toBe("q\u0301\u{10EFD}");
    // TULU-TIGALARI SIGN ANUSVARA was unassigned in Unicode 15.
    expect(normalizeUnicode15("q\u0301\u{113CE}")).toBe("q\u0301\u{113CE}");
  });
});

const account = "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS";
const reference: Reference = {
  version: 2,
  creator: "agent://writer/<reply>&",
  account,
  target: { volume: "Replies", creation_id: "ab".repeat(16) },
  root: Buffer.from([1, 2, 3, ...Array<number>(29).fill(0)]).toString("base64url"),
  generation: 7,
  path: "/replies/1.txt",
  retention: { slot: 2, generation: 9 },
  expires_at: 1900000600,
};
describe("ScratchPad exact v2 references", () => {
  it("matches the independently generated Go reference vector", () => {
    const fixture = JSON.parse(readFileSync(directory + "/../reference-v2.json", "utf8")) as {
      reference: Reference;
      canonical_json: string;
      token: string;
    };
    expect(encodeReference(fixture.reference)).toBe(fixture.token);
    expect(decodeReference(fixture.token)).toEqual(fixture.reference);
    expect(Buffer.from(fixture.token.slice(7), "base64url").toString()).toBe(
      fixture.canonical_json,
    );
    expect(fixture.canonical_json).toContain("\\u2028");
    expect(fixture.canonical_json).toContain("\\u2029");
    expect(fixture.canonical_json).toContain("<reply>&");
  });
  it("matches the Go reference JSON field order and unescaped HTML", () => {
    const expected = `{"version":2,"creator":"agent://writer/<reply>&","account":"${account}","target":{"volume":"Replies","creation_id":"${"ab".repeat(16)}"},"root":"${reference.root}","generation":7,"path":"/replies/1.txt","retention":{"slot":2,"generation":9},"expires_at":1900000600}`;
    const token = encodeReference(reference);
    expect(Buffer.from(token.slice(7), "base64url").toString()).toBe(expected);
    expect(decodeReference(token)).toEqual(reference);
    for (const bad of [
      token + "=",
      token.slice(7),
      "sp-ref:" +
        Buffer.from(expected.replace('"version":2', '"version": 2')).toString("base64url"),
      "sp-ref:" +
        Buffer.from(expected.replace('"version":2', '"version":2,"version":2')).toString(
          "base64url",
        ),
    ]) {
      expect(() => decodeReference(bad)).toThrow();
    }
  });
  it("escapes U+2028/U+2029 like Go and validates public-key checksum", () => {
    const token = encodeReference({ ...reference, creator: "a\u2028b\u2029c" });
    expect(Buffer.from(token.slice(7), "base64url").toString()).toContain("a\\u2028b\\u2029c");
    expect(() => validatePublicKey(account, "account")).not.toThrow();
    expect(() => validatePublicKey(account.slice(0, -1) + "A", "account")).toThrow();
    expect(() =>
      encodeReference({ ...reference, generation: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
  });
  it("exports typed codec failures", () =>
    expect(new CodecError("id-mismatch", "changed").reason).toBe("id-mismatch"));
});
