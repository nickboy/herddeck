import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAGE_ONE,
  PAGE_TWO,
  buildPageManifest,
  buildTopManifest,
  writeProfileArchive,
} from "./generateProfile";

describe("buildPageManifest", () => {
  test("page one places five agent slots on row 0 and nav corners on row 2", () => {
    const m = buildPageManifest(PAGE_ONE);
    const actions = m.Controllers[0]?.Actions ?? {};
    for (let col = 0; col < 5; col++) {
      expect(actions[`${col},0`]?.UUID).toBe("com.nickboy.herddeck.agent-slot");
    }
    expect(actions["0,2"]?.UUID).toBe("com.elgato.streamdeck.page.previous");
    expect(actions["4,2"]?.UUID).toBe("com.elgato.streamdeck.page.next");
    expect(actions["2,2"]?.UUID).toBe("com.nickboy.herddeck.enter");
  });

  test("plugin actions keep LinkedTitle false; system nav opts in", () => {
    const m = buildPageManifest(PAGE_ONE);
    const actions = m.Controllers[0]?.Actions ?? {};
    expect(actions["0,0"]?.LinkedTitle).toBe(false);
    expect(actions["0,2"]?.LinkedTitle).toBe(true);
  });

  test("page two hosts the herdr-native keys and leaves gaps blank", () => {
    const m = buildPageManifest(PAGE_TWO);
    const actions = m.Controllers[0]?.Actions ?? {};
    expect(actions["0,0"]?.UUID).toBe("com.nickboy.herddeck.worktree");
    expect(actions["1,0"]?.UUID).toBe("com.nickboy.herddeck.canned-prompt");
    expect(actions["2,0"]?.UUID).toBe("com.nickboy.herddeck.target-switcher");
    expect(actions["4,0"]).toBeUndefined();
    expect(actions["1,1"]).toBeUndefined();
  });

  test("rejects off-grid coordinates", () => {
    expect(() => buildPageManifest([{ col: 5, row: 0, uuid: "x", name: "x" }])).toThrow(
      /invalid MK.2 coordinate/,
    );
  });
});

describe("buildTopManifest", () => {
  test("first page is Current and Default; all pages listed in order", () => {
    const top = buildTopManifest("HerdDeck", ["aaa", "bbb"]);
    expect(top.Pages.Current).toBe("aaa");
    expect(top.Pages.Default).toBe("aaa");
    expect(top.Pages.Pages).toEqual(["aaa", "bbb"]);
    expect(top.Version).toBe("3.0");
  });
});

describe("writeProfileArchive", () => {
  test("produces a zip with outer wrapper and one dir per page", () => {
    const dir = mkdtempSync(join(tmpdir(), "herddeck-profile-test-"));
    const out = join(dir, "HerdDeck.streamDeckProfile");
    try {
      writeProfileArchive(out);
      expect(existsSync(out)).toBe(true);
      const listing = execSync(`unzip -l "${out}"`).toString();
      expect(listing).toContain(".sdProfile/manifest.json");
      const pageDirs = listing.match(/Profiles\/[0-9A-F-]+\/manifest\.json/g) ?? [];
      expect(pageDirs.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws on pages/uuids length mismatch", () => {
    expect(() => writeProfileArchive("/tmp/x.streamDeckProfile", [PAGE_ONE], "X", "u", [])).toThrow(
      /length mismatch/,
    );
  });
});
