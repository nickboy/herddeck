import { describe, expect, test } from "bun:test";
import { LineDecoder, encodeRequest } from "./index";

describe("encodeRequest", () => {
  test("emits a single newline-terminated JSON line", () => {
    const line = encodeRequest("r1", "ping");
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ id: "r1", method: "ping", params: {} });
  });
});

describe("LineDecoder", () => {
  test("parses complete lines", () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("buffers partial lines across chunks", () => {
    const d = new LineDecoder();
    expect(d.push('{"id":"x","res')).toEqual([]);
    expect(d.push('ult":{}}\n')).toEqual([{ id: "x", result: {} }]);
  });

  test("handles a line split mid-multibyte-free boundary and many chunks", () => {
    const d = new LineDecoder();
    const full = `${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1" } })}\n`;
    for (const ch of full.slice(0, -1)) expect(d.push(ch)).toEqual([]);
    expect(d.push("\n")).toEqual([JSON.parse(full)]);
  });

  test("ignores blank lines", () => {
    const d = new LineDecoder();
    expect(d.push('\n\n{"a":1}\n\n')).toEqual([{ a: 1 }]);
  });
});
