import { describe, it, expect } from "vitest";
import {
  parseAmount,
  claimKey,
  expenseHeadKey,
  attachmentKey,
  storagePath,
  slugSegment,
} from "../src/util/parse.js";

describe("parseAmount", () => {
  it("parses rupee-formatted strings", () => {
    expect(parseAmount("₹ 1,234.50")).toBe(1234.5);
    expect(parseAmount("Rs. 1,000")).toBe(1000);
    expect(parseAmount("2,50,000.00")).toBe(250000);
    expect(parseAmount("450")).toBe(450);
  });
  it("preserves decimals and bare leading-decimal values", () => {
    expect(parseAmount("100.50")).toBe(100.5);
    expect(parseAmount(".50")).toBe(0.5); // must NOT become 50
    expect(parseAmount("Rs.500")).toBe(500);
  });
  it("returns null for empty / non-numeric", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("  -  ")).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount("N/A")).toBeNull();
  });
});

describe("dedupe keys", () => {
  it("claimKey combines run + employee", () => {
    expect(claimKey("job1", "E123")).toBe("job1::E123");
  });
  it("expenseHeadKey combines claim + head + bill", () => {
    expect(expenseHeadKey("c1", "Miscellaneous", "B-9")).toBe("c1::Miscellaneous::B-9");
    expect(expenseHeadKey("c1", "Misc", null)).toBe("c1::Misc::");
  });
  it("attachmentKey combines expenseHead + filename", () => {
    expect(attachmentKey("eh1", "petrol (1).pdf")).toBe("eh1::petrol (1).pdf");
  });
});

describe("storagePath / slugSegment", () => {
  it("slugSegment makes a path-safe segment", () => {
    expect(slugSegment("Miscellaneous Travel/Local")).toBe("Miscellaneous-Travel-Local");
    expect(slugSegment("  spaces  ")).toBe("spaces");
  });
  it("storagePath builds run/emp/head/file", () => {
    expect(storagePath("job1", "E123", "Misc Travel", "bill (1).pdf")).toBe(
      "job1/E123/Misc-Travel/bill (1).pdf"
    );
  });
});
