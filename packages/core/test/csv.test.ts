import { describe, expect, it } from "vitest";
import { buildContactsCsv, CSV_COLUMNS, escapeCsvField, neutralizeFormula } from "../src/index.js";

describe("CSV escaping", () => {
  it.each([
    ["plain", "plain"],
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ["line1\nline2", '"line1\nline2"'],
    ["line1\r\nline2", '"line1\r\nline2"'],
    ["", ""],
  ])("escapes %j", (input, expected) => {
    expect(escapeCsvField(input)).toBe(expected);
  });

  it("writes null as an empty field", () => {
    expect(escapeCsvField(null)).toBe("");
  });
});

describe("formula injection protection", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", '=HYPERLINK("http://x","y")'])("neutralizes %j", (value) => {
    expect(neutralizeFormula(value)).toBe(`'${value}`);
    expect(escapeCsvField(value).replace(/^"/, "").startsWith("'")).toBe(true);
  });

  it("leaves ordinary values alone, including characters that are only dangerous at the start", () => {
    for (const value of ["Ana-Maria", "a=b", "x+y", "me@example.com", " =padded"]) expect(neutralizeFormula(value)).toBe(value);
  });

  it("combines with quoting: the apostrophe goes inside the quotes", () => {
    expect(escapeCsvField('=A1,"x"')).toBe(`"'=A1,""x"""`);
  });
});

describe("buildContactsCsv", () => {
  it("emits public column names, a header, CRLF line endings and a trailing newline", () => {
    expect(CSV_COLUMNS).toEqual(["id", "name", "title", "email", "linkedin"]);
    const csv = buildContactsCsv([
      { id: "cnt_1", name: "Ana, Jr.", title: "CTO", email: null, linkedin: null },
      { id: "cnt_2", name: "=cmd", title: "Eng", email: "e@x.example", linkedin: "https://l.example/in/a" },
    ]);
    expect(csv).toBe(
      'id,name,title,email,linkedin\r\ncnt_1,"Ana, Jr.",CTO,,\r\ncnt_2,\'=cmd,Eng,e@x.example,https://l.example/in/a\r\n',
    );
  });

  it("emits only the header for no rows", () => {
    expect(buildContactsCsv([])).toBe("id,name,title,email,linkedin\r\n");
  });
});
