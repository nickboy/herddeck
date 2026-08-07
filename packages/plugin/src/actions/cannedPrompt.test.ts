import { describe, expect, test } from "bun:test";
import { DEFAULT_CANNED_TEXT, renderCannedPrompt, resolveCannedPromptText } from "./cannedPrompt";

describe("resolveCannedPromptText", () => {
  test("defaults to 'continue' when undefined", () => {
    expect(resolveCannedPromptText(undefined)).toBe("continue");
    expect(resolveCannedPromptText(undefined)).toBe(DEFAULT_CANNED_TEXT);
  });

  test("defaults when blank/whitespace-only", () => {
    expect(resolveCannedPromptText("")).toBe(DEFAULT_CANNED_TEXT);
    expect(resolveCannedPromptText("   ")).toBe(DEFAULT_CANNED_TEXT);
  });

  test("trims surrounding whitespace on a real value", () => {
    expect(resolveCannedPromptText("  keep going  ")).toBe("keep going");
  });

  test("passes a real value through untouched (already trimmed)", () => {
    expect(resolveCannedPromptText("run the tests")).toBe("run the tests");
  });
});

describe("renderCannedPrompt", () => {
  test("title is the default text when settings.text is unset", () => {
    expect(renderCannedPrompt(undefined)).toEqual({ title: "continue" });
  });

  test("title is the configured text when short enough to fit", () => {
    expect(renderCannedPrompt("run tests")).toEqual({ title: "run tests" });
  });

  test("truncates long text to the 3-line character budget, no ellipsis", () => {
    const long = "this is a very long canned prompt that will not fit on the key";
    const r = renderCannedPrompt(long);
    expect(r.title.length).toBe(24);
    expect(r.title).toBe(long.slice(0, 24));
  });

  test("stable output for the same input", () => {
    expect(renderCannedPrompt("continue")).toEqual(renderCannedPrompt("continue"));
  });
});
