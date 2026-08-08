import { expect, test } from "bun:test";
import { EXPECTED_PROTOCOL as PROTOCOL_PKG } from "@herddeck/protocol";
import { EXPECTED_PROTOCOL as CLI_COPY } from "./herddeck";

// The CLI duplicates EXPECTED_PROTOCOL to stay dependency-free at
// runtime; this test (dev-only workspace dep) keeps the copies from
// drifting when the herdr protocol version bumps.
test("CLI's protocol constant matches @herddeck/protocol", () => {
  expect(CLI_COPY).toBe(PROTOCOL_PKG);
});
