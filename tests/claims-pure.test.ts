import { describe, it, expect } from "vitest";
import { parseRowEmployee, xpathLiteral } from "../src/claims.js";

describe("parseRowEmployee", () => {
  it("extracts name and code from a parenthesised row", () => {
    expect(parseRowEmployee("Asha Rao (E12345) - Finance Manager Approval")).toEqual({
      employeeName: "Asha Rao",
      employeeCode: "E12345",
    });
  });
  it("falls back to full text when no code present", () => {
    expect(parseRowEmployee("Finance Manager Approval")).toEqual({
      employeeName: "Finance Manager Approval",
      employeeCode: "Finance Manager Approval",
    });
  });
});

describe("xpathLiteral", () => {
  it("wraps plain strings in single quotes", () => {
    expect(xpathLiteral("Bill Date")).toBe("'Bill Date'");
  });
  it("uses double quotes when an apostrophe is present", () => {
    expect(xpathLiteral("Approver's")).toBe(`"Approver's"`);
  });
});
