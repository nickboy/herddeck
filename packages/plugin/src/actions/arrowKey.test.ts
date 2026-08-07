import { describe, expect, test } from "bun:test";
import { renderArrowKey } from "./arrowKey";

describe("renderArrowKey", () => {
  test("empty title when bridge connected (icon carries the visual)", () => {
    expect(renderArrowKey("connected")).toEqual({ title: "" });
  });

  test("`!` prefix when bridge offline so press feedback is visible", () => {
    expect(renderArrowKey("disconnected").title).toBe("!");
    expect(renderArrowKey("connecting").title).toBe("!");
  });
});
