import { describe, expect, it } from "vitest";
import { ALP_CORE_VERSION } from "../src/index";

describe("ALP TypeScript core", () => {
  it("loads through the test runner", () => {
    expect(ALP_CORE_VERSION).toBe(1);
  });
});
