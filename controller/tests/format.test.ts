import { describe, expect, it } from "vitest";
import { ago, fmtBytes, pct } from "../src/lib/format";

describe("fmtBytes", () => {
  it("renders an em-dash for null/undefined", () => {
    expect(fmtBytes(null)).toBe("—");
    expect(fmtBytes(undefined)).toBe("—");
  });

  it("renders bytes with no decimal", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1023)).toBe("1023 B");
  });

  it("labels binary units as binary and steps at 1024 boundaries", () => {
    expect(fmtBytes(1024)).toBe("1.0 KiB");
    expect(fmtBytes(1536)).toBe("1.5 KiB");
    expect(fmtBytes(1024 ** 2)).toBe("1.0 MiB");
    expect(fmtBytes(1024 ** 3)).toBe("1.0 GiB");
    expect(fmtBytes(2 * 1024 ** 4)).toBe("2.0 TiB");
    expect(fmtBytes(1024 ** 5)).toBe("1.0 PiB");
  });

  it("does not skip a unit", () => {
    // Regression: the node storage page carried its own copy of this ladder with "MiB" missing, so
    // every size from 1 MiB up rendered 1024x too large -- a 7.25 TiB pool showed as "7.3 PiB".
    expect(fmtBytes(1024 ** 2)).toBe("1.0 MiB");
    expect(fmtBytes(7.25 * 1024 ** 4)).toBe("7.3 TiB");
  });

  it("drops the decimal once the value reaches 100 in a unit", () => {
    expect(fmtBytes(100 * 1024)).toBe("100 KiB");
    expect(fmtBytes(150 * 1024)).toBe("150 KiB");
  });

  it("clamps to the largest unit (PiB)", () => {
    expect(fmtBytes(5000 * 1024 ** 5)).toBe("5000 PiB");
  });

  it("renders an em-dash for non-finite values", () => {
    expect(fmtBytes(Number.NaN)).toBe("—");
    expect(fmtBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("ago", () => {
  it("returns 'never' for falsy timestamps", () => {
    expect(ago(null)).toBe("never");
    expect(ago(undefined)).toBe("never");
    expect(ago(0)).toBe("never");
  });

  it("formats seconds, minutes, hours, days", () => {
    const now = Date.now();
    expect(ago(now - 5 * 1000)).toBe("5s ago");
    expect(ago(now - 5 * 60 * 1000)).toBe("5m ago");
    expect(ago(now - 5 * 3600 * 1000)).toBe("5h ago");
    expect(ago(now - 5 * 86400 * 1000)).toBe("5d ago");
  });

  it("uses the largest fitting unit at boundaries", () => {
    const now = Date.now();
    expect(ago(now - 59 * 1000)).toBe("59s ago");
    expect(ago(now - 60 * 1000)).toBe("1m ago");
    expect(ago(now - 3599 * 1000)).toBe("59m ago");
    expect(ago(now - 3600 * 1000)).toBe("1h ago");
  });
});

describe("pct", () => {
  it("returns null when quota is missing or non-positive", () => {
    expect(pct(100, null)).toBeNull();
    expect(pct(100, undefined)).toBeNull();
    expect(pct(100, 0)).toBeNull();
    expect(pct(100, -5)).toBeNull();
  });

  it("computes a rounded percentage", () => {
    expect(pct(50, 100)).toBe(50);
    expect(pct(1, 3)).toBe(33);
    expect(pct(0, 100)).toBe(0);
  });

  it("caps at 100 when over quota", () => {
    expect(pct(150, 100)).toBe(100);
    expect(pct(1000, 100)).toBe(100);
  });
});
