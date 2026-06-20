import { describe, expect, it } from "vitest";
import { applyMapping, parseCsv } from "../src/lib/csv";

describe("parseCsv", () => {
  it("parses headers and rows", () => {
    const { headers, rows } = parseCsv("username,email\nalice,alice@uga.edu\nbob,bob@uga.edu\n");
    expect(headers).toEqual(["username", "email"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ username: "alice", email: "alice@uga.edu" });
  });

  it("handles quoted fields with commas and CRLF", () => {
    const { rows } = parseCsv('username,name\r\nalice,"Doe, Alice"\r\n');
    expect(rows[0]).toEqual({ username: "alice", name: "Doe, Alice" });
  });

  it("ignores blank lines", () => {
    const { rows } = parseCsv("username\nalice\n\n\nbob\n");
    expect(rows.map((r) => r.username)).toEqual(["alice", "bob"]);
  });
});

describe("applyMapping", () => {
  const parsed = parseCsv(
    "user,mail,full\nalice,alice@uga.edu,Alice\nBOB,,Bob\nalice,alice2@uga.edu,Dup\nbad name,x@x.com,Bad\n",
  );

  it("maps columns and lowercases usernames", () => {
    const rows = applyMapping(parsed, { username: "user", email: "mail", name: "full" });
    expect(rows[0]).toMatchObject({ username: "alice", email: "alice@uga.edu", name: "Alice", issues: [] });
    expect(rows[1].username).toBe("bob");
  });

  it("flags missing email when an email column is mapped", () => {
    const rows = applyMapping(parsed, { username: "user", email: "mail" });
    expect(rows[1].issues).toContain("missing email"); // BOB has no mail
  });

  it("flags duplicate usernames and invalid usernames", () => {
    const rows = applyMapping(parsed, { username: "user" });
    expect(rows[2].issues).toContain("duplicate username in file"); // second alice
    expect(rows[3].issues).toContain("invalid username"); // "bad name"
  });
});
