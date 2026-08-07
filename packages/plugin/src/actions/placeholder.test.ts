import { describe, expect, test } from "bun:test";
import { renderPlaceholder } from "./placeholder";

describe("renderPlaceholder", () => {
  test("disconnected state shows dim title and no highlight", () => {
    const r = renderPlaceholder("disconnected");
    expect(r.title).toContain("offline");
    expect(r.highlight).toBe(false);
  });

  test("connecting state shows connecting title", () => {
    const r = renderPlaceholder("connecting");
    expect(r.title.toLowerCase()).toContain("connect");
    expect(r.highlight).toBe(false);
  });

  test("connected state shows ready title and highlight", () => {
    const r = renderPlaceholder("connected");
    expect(r.title.toLowerCase()).toContain("ready");
    expect(r.highlight).toBe(true);
  });

  test("returned data is stable across calls (pure function)", () => {
    const a = renderPlaceholder("connected");
    const b = renderPlaceholder("connected");
    expect(a).toEqual(b);
  });
});
