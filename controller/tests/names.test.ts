import { describe, expect, it } from "vitest";
import { composeName, isFacultyDegree, nameVars, normalizeDegree, splitFullName } from "../src/lib/names";

describe("splitFullName", () => {
  it("splits on the final space", () => {
    expect(splitFullName("Ningxi Cheng")).toEqual({ firstName: "Ningxi", lastName: "Cheng" });
    expect(splitFullName("Dr. Jane Smith")).toEqual({ firstName: "Dr. Jane", lastName: "Smith" });
  });

  it("keeps a single token as the first name", () => {
    expect(splitFullName("Prince")).toEqual({ firstName: "Prince", lastName: null });
  });

  it("returns nulls for blank input", () => {
    expect(splitFullName("   ")).toEqual({ firstName: null, lastName: null });
    expect(splitFullName(null)).toEqual({ firstName: null, lastName: null });
  });
});

describe("composeName", () => {
  it("joins the parts it has", () => {
    expect(composeName("Geng", "Yuan")).toBe("Geng Yuan");
    expect(composeName("Geng", null)).toBe("Geng");
    expect(composeName(" ", "Yuan")).toBe("Yuan");
    expect(composeName(null, undefined)).toBeNull();
  });
});

describe("normalizeDegree", () => {
  it("canonicalizes the roster spellings", () => {
    expect(normalizeDegree("Phd")).toBe("PhD");
    expect(normalizeDegree(" ph.d. ")).toBe("PhD");
    expect(normalizeDegree("masters")).toBe("MS");
    expect(normalizeDegree("faculty")).toBe("Faculty");
    expect(normalizeDegree("Professor")).toBe("Faculty");
  });

  it("keeps unknown but plausible values and drops junk", () => {
    expect(normalizeDegree("Visiting Scholar")).toBe("Visiting Scholar");
    expect(normalizeDegree("")).toBeNull();
    expect(normalizeDegree("!!!")).toBeNull();
    expect(normalizeDegree("x".repeat(40))).toBeNull();
  });

  it("identifies the PI row", () => {
    expect(isFacultyDegree("faculty")).toBe(true);
    expect(isFacultyDegree("PhD")).toBe(false);
    expect(isFacultyDegree(null)).toBe(false);
  });
});

describe("nameVars", () => {
  it("prefers the stored parts", () => {
    expect(nameVars({ first_name: "Geng", last_name: "Yuan", name: "stale", username: "gy23443" })).toEqual({
      name: "Geng Yuan",
      first_name: "Geng",
      last_name: "Yuan",
    });
  });

  it("derives the parts from a legacy single name", () => {
    expect(nameVars({ name: "Jane Smith" })).toEqual({
      name: "Jane Smith",
      first_name: "Jane",
      last_name: "Smith",
    });
  });

  it("falls back to the username when there is no name at all", () => {
    expect(nameVars({ username: "gy23443" })).toEqual({ name: "gy23443", first_name: "", last_name: "" });
  });
});
