import { describe, expect, it } from "vitest";
import {
  isProtocolCompatible,
  parseInboundFrame,
  PROTOCOL_VERSION,
} from "../src/lib/protocol";

describe("parseInboundFrame", () => {
  it("accepts a well-formed frame of each known type", () => {
    expect(parseInboundFrame({ type: "hello", v: 1, node: "gpu-1", token: "t" })?.type).toBe("hello");
    expect(parseInboundFrame({ type: "result", id: "x", ok: true })?.type).toBe("result");
    expect(parseInboundFrame({ type: "receipt", id: "x" })?.type).toBe("receipt");
    expect(parseInboundFrame({ type: "log", msg: "hi" })?.type).toBe("log");
    expect(parseInboundFrame({ type: "event", kind: "gpu", payload: {} })?.type).toBe("event");
    expect(parseInboundFrame({ type: "telemetry", payload: {} })?.type).toBe("telemetry");
  });

  it("rejects unknown types and malformed frames", () => {
    expect(parseInboundFrame({ type: "nope" })).toBeNull();
    expect(parseInboundFrame({ type: "result" })).toBeNull(); // missing id + ok
    expect(parseInboundFrame({ type: "hello", node: "n" })).toBeNull(); // missing token
    expect(parseInboundFrame("not an object")).toBeNull();
    expect(parseInboundFrame(null)).toBeNull();
  });

  it("rejects a hello with an over-long node name or token", () => {
    expect(parseInboundFrame({ type: "hello", node: "a".repeat(64), token: "t" })).toBeNull();
    expect(parseInboundFrame({ type: "hello", node: "n", token: "a".repeat(513) })).toBeNull();
  });

  it("strips unknown extra keys rather than failing", () => {
    const f = parseInboundFrame({ type: "result", id: "x", ok: false, error: "boom", junk: 1 }) as any;
    expect(f).not.toBeNull();
    expect(f.junk).toBeUndefined();
    expect(f.error).toBe("boom");
  });
});

describe("isProtocolCompatible", () => {
  it("accepts exactly the current version and rejects others / absent", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolCompatible(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isProtocolCompatible(0)).toBe(false);
    expect(isProtocolCompatible(undefined)).toBe(false); // pre-versioning agent -> incompatible
  });
});
