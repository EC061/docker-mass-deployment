import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as webdav from "../src/lib/webdav";

const cfg = { url: "https://dav.example/labmgr", user: "bob", pass: "s3cret" };

type Call = { url: string; init: any };
let calls: Call[];

function mockFetch(make: (call: Call) => Partial<Response> & { _text?: string; _buf?: Buffer }) {
  return vi.fn(async (url: string, init: any) => {
    const call = { url, init };
    calls.push(call);
    const r = make(call);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: (r as any).statusText ?? "OK",
      text: async () => r._text ?? "",
      arrayBuffer: async () => {
        const b = r._buf ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    } as unknown as Response;
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth header", () => {
  it("sends HTTP basic auth derived from user:pass", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: true })));
    await webdav.put(cfg, "f.db", Buffer.from("x"));
    const expected = "Basic " + Buffer.from("bob:s3cret").toString("base64");
    expect(calls[0].init.headers.Authorization).toBe(expected);
  });

  it("omits auth when no user is configured", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: true })));
    await webdav.put({ ...cfg, user: "" }, "f.db", Buffer.from("x"));
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });
});

describe("put", () => {
  it("PUTs to url/name and resolves on success", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: true, status: 201 })));
    await webdav.put(cfg, "controller-1.db", Buffer.from("data"));
    expect(calls[0].url).toBe("https://dav.example/labmgr/controller-1.db");
    expect(calls[0].init.method).toBe("PUT");
  });

  it("throws on a non-ok status", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: false, status: 507, statusText: "Insufficient Storage" })));
    await expect(webdav.put(cfg, "f.db", Buffer.from("x"))).rejects.toThrow(/507 Insufficient Storage/);
  });
});

describe("get", () => {
  it("returns the body as a Buffer", async () => {
    const payload = Buffer.from("SQLite format 3\0");
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: true, _buf: payload })));
    const out = await webdav.get(cfg, "controller-latest.db");
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(payload)).toBe(true);
  });

  it("throws on a non-ok status", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: false, status: 404 })));
    await expect(webdav.get(cfg, "missing.db")).rejects.toThrow(/404/);
  });
});

describe("del", () => {
  it("issues a DELETE to url/name", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: true })));
    await webdav.del(cfg, "old.db");
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toBe("https://dav.example/labmgr/old.db");
  });
});

describe("list", () => {
  it("parses PROPFIND hrefs into basenames, excluding the collection itself", async () => {
    const xml = `<?xml version="1.0"?>
    <d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/labmgr/</d:href></d:response>
      <d:response><d:href>/labmgr/controller-1000.db</d:href></d:response>
      <d:response><d:href>/labmgr/controller-2000.db</d:href></d:response>
    </d:multistatus>`;
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: true, _text: xml })));
    const names = await webdav.list(cfg);
    expect(names).toEqual(["controller-1000.db", "controller-2000.db"]);
    expect(calls[0].init.method).toBe("PROPFIND");
    expect(calls[0].init.headers.Depth).toBe("1");
  });

  it("URL-decodes hrefs", async () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/labmgr/back%20up.db</d:href></d:response></d:multistatus>`;
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: true, _text: xml })));
    expect(await webdav.list(cfg)).toEqual(["back up.db"]);
  });

  it("returns an empty list on a non-ok status", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: false, status: 500 })));
    expect(await webdav.list(cfg)).toEqual([]);
  });
});

describe("listStrict", () => {
  it("throws on a non-ok status so failures aren't mistaken for an empty collection", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: false, status: 401, statusText: "Unauthorized" })));
    await expect(webdav.listStrict(cfg)).rejects.toThrow(/401/);
  });

  it("returns basenames on success", async () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/labmgr/controller-1000.db</d:href></d:response></d:multistatus>`;
    vi.stubGlobal("fetch", mockFetch(() => ({ ok: true, _text: xml })));
    expect(await webdav.listStrict(cfg)).toEqual(["controller-1000.db"]);
  });
});
