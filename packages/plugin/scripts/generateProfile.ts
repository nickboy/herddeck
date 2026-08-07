/**
 * Generates `HerdDeck.streamDeckProfile`, pre-arranging the actions on
 * a 15-key MK.2 across TWO pages. Ported from ClaudeDeck's generator
 * (same v3.0 on-disk format — see that file's header for the quirks:
 * distinct outer/page uuids, lowercase Pages.* refs, uppercase
 * Profiles/<id>/ dirs).
 *
 * Page 1 mirrors ClaudeDeck's proven layout (slots / answers+wispr+plan
 * / nav cluster). Page 2 hosts the herdr-native keys (worktree, canned
 * prompt, target switcher) so the daily-driver page stays uncluttered.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SlotSpec {
  col: number;
  row: number;
  uuid: string;
  name: string;
  /** System page-nav actions render their own titles ("1/2") when
   * true; plugin actions must stay false so setTitle() wins. */
  linkedTitle?: boolean;
}

const PAGE_PREVIOUS_UUID = "com.elgato.streamdeck.page.previous";
const PAGE_NEXT_UUID = "com.elgato.streamdeck.page.next";
const ACTION = (id: string) => `com.nickboy.herddeck.${id}`;

export const PAGE_ONE: readonly SlotSpec[] = [
  // Row 0: five agent slots (blocked-first ordering comes from the daemon).
  ...Array.from({ length: 5 }, (_, col) => ({
    col,
    row: 0,
    uuid: ACTION("agent-slot"),
    name: "Agent Slot",
  })),
  // Row 1: answers + Wispr Flow + Plan Usage (ClaudeDeck positions).
  { col: 0, row: 1, uuid: ACTION("answer-yes"), name: "Answer — Yes" },
  { col: 1, row: 1, uuid: ACTION("answer-no"), name: "Answer — No" },
  { col: 2, row: 1, uuid: ACTION("answer-always"), name: "Answer — Always" },
  { col: 3, row: 1, uuid: ACTION("wispr-flow"), name: "Wispr Flow" },
  { col: 4, row: 1, uuid: ACTION("plan-usage"), name: "Plan Usage" },
  // Row 2: nav cluster with Enter at the center (one-handed submit).
  { col: 0, row: 2, uuid: PAGE_PREVIOUS_UUID, name: "Previous Page", linkedTitle: true },
  { col: 1, row: 2, uuid: ACTION("arrow-up"), name: "Arrow Up" },
  { col: 2, row: 2, uuid: ACTION("enter"), name: "Enter" },
  { col: 3, row: 2, uuid: ACTION("arrow-down"), name: "Arrow Down" },
  { col: 4, row: 2, uuid: PAGE_NEXT_UUID, name: "Next Page", linkedTitle: true },
] as const;

export const PAGE_TWO: readonly SlotSpec[] = [
  // Herdr-native extras; slot paging (menu) lives here too. Unlisted
  // coordinates render as blank keys for user customization.
  { col: 0, row: 0, uuid: ACTION("worktree"), name: "New Worktree" },
  { col: 1, row: 0, uuid: ACTION("canned-prompt"), name: "Canned Prompt" },
  { col: 2, row: 0, uuid: ACTION("target-switcher"), name: "Target Switcher" },
  { col: 3, row: 0, uuid: ACTION("menu"), name: "Slot Paging" },
  { col: 0, row: 2, uuid: PAGE_PREVIOUS_UUID, name: "Previous Page", linkedTitle: true },
  { col: 4, row: 2, uuid: PAGE_NEXT_UUID, name: "Next Page", linkedTitle: true },
] as const;

export interface ActionEntry {
  ActionID: string;
  LinkedTitle: boolean;
  Name: string;
  Resources: null;
  Settings: Record<string, unknown>;
  State: number;
  States: Array<Record<string, unknown>>;
  UUID: string;
}

export interface PageManifest {
  Controllers: Array<{ Actions: Record<string, ActionEntry>; Type: "Keypad" }>;
  Icon: "";
  Name: "";
}

export interface TopManifest {
  AppIdentifier: "*";
  Device: { Model: string; UUID: string };
  Name: string;
  Pages: { Current: string; Default: string; Pages: string[] };
  Version: "3.0";
}

const NULL_UUID = "00000000-0000-0000-0000-000000000000";
// MK.2 model code, lifted from a real on-disk profile (ClaudeDeck note).
const MK2_MODEL = "20GAA9902";

export function buildPageManifest(layout: readonly SlotSpec[]): PageManifest {
  const actions: Record<string, ActionEntry> = {};
  for (const slot of layout) {
    if (slot.col < 0 || slot.col > 4 || slot.row < 0 || slot.row > 2) {
      throw new Error(`invalid MK.2 coordinate: col=${slot.col} row=${slot.row}`);
    }
    actions[`${slot.col},${slot.row}`] = {
      ActionID: NULL_UUID,
      LinkedTitle: slot.linkedTitle === true,
      Name: slot.name,
      Resources: null,
      Settings: {},
      State: 0,
      States: [{}],
      UUID: slot.uuid,
    };
  }
  return { Controllers: [{ Actions: actions, Type: "Keypad" }], Icon: "", Name: "" };
}

export function buildTopManifest(name: string, pageUuids: string[]): TopManifest {
  const first = pageUuids[0];
  if (!first) throw new Error("at least one page uuid required");
  return {
    AppIdentifier: "*",
    Device: { Model: MK2_MODEL, UUID: "" },
    Name: name,
    Pages: { Current: first, Default: first, Pages: [...pageUuids] },
    Version: "3.0",
  };
}

/** Deterministic uuids keep the committed archive byte-stable. */
const DEFAULT_OUTER_UUID = "7e2dd0af-5b1c-4c8e-9a63-0123456789ab";
const DEFAULT_PAGE_UUIDS = [
  "b1e8a3f0-4c5d-4e6f-8901-234567890abc",
  "c2f9b4e1-5d6e-4f70-9012-34567890abcd",
];

export function writeProfileArchive(
  outputPath: string,
  pages: readonly (readonly SlotSpec[])[] = [PAGE_ONE, PAGE_TWO],
  profileName = "HerdDeck",
  outerUuid: string = DEFAULT_OUTER_UUID,
  pageUuids: string[] = DEFAULT_PAGE_UUIDS,
): void {
  if (pages.length !== pageUuids.length) {
    throw new Error(`pages (${pages.length}) and pageUuids (${pageUuids.length}) length mismatch`);
  }
  const topManifest = buildTopManifest(profileName, pageUuids);
  const staging = mkdtempSync(join(tmpdir(), "herddeck-profile-"));
  try {
    const base = join(staging, `${outerUuid.toUpperCase()}.sdProfile`);
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "manifest.json"), JSON.stringify(topManifest));
    pages.forEach((layout, i) => {
      const pageUuid = pageUuids[i];
      if (!pageUuid) throw new Error(`missing uuid for page ${i}`);
      const pageDir = join(base, "Profiles", pageUuid.toUpperCase());
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(join(pageDir, "manifest.json"), JSON.stringify(buildPageManifest(layout)));
    });
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    rmSync(resolve(outputPath), { force: true });
    execSync(`cd "${staging}" && zip -qr "${resolve(outputPath)}" . -x ".*"`, {
      stdio: "inherit",
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const dir = dirname(resolve(import.meta.path ?? "."));
  const target = resolve(dir, "..", "com.nickboy.herddeck.sdPlugin", "HerdDeck.streamDeckProfile");
  writeProfileArchive(target);
  console.log(`wrote ${target}`);
}
