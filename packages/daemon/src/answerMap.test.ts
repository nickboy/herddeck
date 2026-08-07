import { describe, expect, test } from "bun:test";
import { answerKeys } from "./answerMap";

describe("answerKeys", () => {
  test("claude mapping matches ClaudeDeck's proven digits", () => {
    expect(answerKeys("claude", "yes")).toEqual(["1", "enter"]);
    expect(answerKeys("claude", "always")).toEqual(["2", "enter"]);
    expect(answerKeys("claude", "no")).toEqual(["3", "enter"]);
  });

  test("unknown agent kinds fall back to the claude convention", () => {
    expect(answerKeys("codex", "yes")).toEqual(["1", "enter"]);
    expect(answerKeys(null, "no")).toEqual(["3", "enter"]);
  });
});
