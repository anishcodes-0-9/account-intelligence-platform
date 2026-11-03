import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors/app-error.js";
import { FILLER_TERMS, matchesAllTokens, parseSearchQuery, tokenize } from "../src/companies/search-query.js";

describe("tokenize", () => {
  it("lower-cases and splits on anything that is not a letter or digit", () => {
    expect(tokenize("AI-driven, Fintech/Payments_v2 (beta)!")).toEqual(["ai", "driven", "fintech", "payments", "v2", "beta"]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("!!!")).toEqual([]);
  });

  it("keeps non-ASCII letters", () => {
    expect(tokenize("Zürich Café")).toEqual(["zürich", "café"]);
  });
});

describe("parseSearchQuery", () => {
  it("drops exactly the five filler terms, case-insensitively", () => {
    expect([...FILLER_TERMS].sort()).toEqual(["companies", "company", "inc", "ltd", "pty"]);
    expect(parseSearchQuery("AI Companies")).toEqual(["ai"]);
    expect(parseSearchQuery("Acme Pty LTD Inc company")).toEqual(["acme"]);
  });

  it("does not treat similar words as filler", () => {
    expect(parseSearchQuery("incorporated companys")).toEqual(["incorporated", "companys"]);
  });

  it("de-duplicates tokens", () => {
    expect(parseSearchQuery("ai AI Ai")).toEqual(["ai"]);
  });

  it("treats undefined and blank queries as no text filter", () => {
    expect(parseSearchQuery(undefined)).toEqual([]);
    expect(parseSearchQuery("")).toEqual([]);
    expect(parseSearchQuery("   \t\n")).toEqual([]);
  });

  it("rejects non-blank queries with nothing meaningful", () => {
    for (const q of ["companies", "Company Inc", "inc ltd pty", "!!!", "- ,"]) {
      expect(() => parseSearchQuery(q), q).toThrow(ValidationError);
    }
  });
});

describe("matchesAllTokens", () => {
  it("matches whole tokens across fields, never substrings", () => {
    const fields = ["Beta Retail", "Retail", "Inventory planning for retailers who maintain stock."];
    expect(matchesAllTokens(fields, ["retail"])).toBe(true);
    expect(matchesAllTokens(fields, ["ai"])).toBe(false); // "retailers", "maintain" contain "ai" as a substring
    expect(matchesAllTokens(fields, ["retail", "maintain"])).toBe(true);
    expect(matchesAllTokens(fields, ["retai"])).toBe(false);
    expect(matchesAllTokens(fields, ["retail", "missing"])).toBe(false);
  });
});
