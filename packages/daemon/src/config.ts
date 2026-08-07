import fs from "node:fs";
import path from "node:path";
import { configPath } from "./paths";

export interface LocalTarget {
  name: string;
  kind: "local";
  socket: string;
}

export interface RemoteTarget {
  name: string;
  kind: "remote";
  host: string;
  remoteSocket: string;
}

export type TargetConfig = LocalTarget | RemoteTarget;

export interface HerdDeckConfig {
  port: number;
  terminalApp: string;
  planUsageEnabled: boolean;
  targets: TargetConfig[];
}

function parseToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection: string | null = null;
  let currentArray: string | null = null;
  let arrayIndex = -1;
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";

    // Strip comments
    const commentIdx = line.indexOf("#");
    if (commentIdx >= 0) {
      line = line.substring(0, commentIdx);
    }

    line = line.trim();

    if (!line) continue;

    // Array of tables: [[name]]
    if (line.startsWith("[[") && line.endsWith("]]")) {
      currentArray = line.slice(2, -2);
      currentSection = null;
      if (!result[currentArray]) result[currentArray] = [];
      const arr = result[currentArray] as Record<string, unknown>[];
      arr.push({});
      arrayIndex = arr.length - 1;
      continue;
    }

    // Section: [name]
    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1);
      currentArray = null;
      if (!result[currentSection]) result[currentSection] = {};
      continue;
    }

    // Key-value pair
    const eqIdx = line.indexOf("=");
    if (eqIdx >= 0) {
      const key = line.substring(0, eqIdx).trim();
      const valueStr = line.substring(eqIdx + 1).trim();

      const value: unknown = parseValue(valueStr);

      if (currentArray !== null) {
        const arr = result[currentArray] as Record<string, unknown>[];
        const entry = arr[arrayIndex];
        if (entry) entry[key] = value;
      } else if (currentSection !== null) {
        const section = result[currentSection] as Record<string, unknown>;
        section[key] = value;
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

function parseValue(rawStr: string): unknown {
  const str = rawStr.trim();

  // String (quoted)
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }

  // Boolean
  if (str === "true") return true;
  if (str === "false") return false;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(str)) {
    return str.includes(".") ? Number.parseFloat(str) : Number.parseInt(str, 10);
  }

  // Unquoted string fallback
  return str;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) throw new Error("$HOME not set");
    return path.join(home, p.slice(2));
  }
  return p;
}

export function loadConfig(configFilePath?: string): HerdDeckConfig {
  const filePath = configFilePath || configPath();

  let raw: Record<string, unknown>;
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    try {
      raw = useTomlParser(content);
    } catch (e) {
      throw new Error(
        `Failed to parse config at ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else {
    // Default config
    raw = {};
  }

  // Extract daemon section
  const daemonSection = (raw.daemon || {}) as Record<string, unknown>;
  const port = typeof daemonSection.port === "number" ? daemonSection.port : 9137;

  // Extract ui section
  const uiSection = (raw.ui || {}) as Record<string, unknown>;
  const terminalApp =
    typeof uiSection.terminal_app === "string" ? uiSection.terminal_app : "Ghostty";

  // Extract plan_usage section
  const planUsageSection = (raw.plan_usage || {}) as Record<string, unknown>;
  const planUsageEnabled =
    typeof planUsageSection.enabled === "boolean" ? planUsageSection.enabled : true;

  // Parse targets
  const targetsArray = (raw.targets || []) as Record<string, unknown>[];

  const targets: TargetConfig[] = [];
  const seenNames = new Set<string>();

  if (targetsArray.length === 0) {
    // Default single local target
    const home = process.env.HOME;
    if (!home) throw new Error("$HOME not set");
    targets.push({
      name: "local",
      kind: "local",
      socket: path.join(home, ".config/herdr/herdr.sock"),
    });
  } else {
    for (const rawTarget of targetsArray) {
      const name = rawTarget.name as string;
      const kind = rawTarget.kind as string;

      // Validate name
      if (!name || typeof name !== "string") {
        throw new Error("targets[].name is required and must be a string");
      }
      if (!/^[a-z0-9-]+$/.test(name)) {
        throw new Error(
          `targets[].name "${name}" must match /^[a-z0-9-]+$/ (lowercase alphanumeric and hyphens)`,
        );
      }
      if (seenNames.has(name)) {
        throw new Error(`targets[].name "${name}" is duplicated`);
      }
      seenNames.add(name);

      if (kind === "local") {
        const session = rawTarget.session as string | undefined;
        let socket: string;

        if (session) {
          const home = process.env.HOME;
          if (!home) throw new Error("$HOME not set");
          socket = path.join(home, ".config/herdr/sessions", session, "herdr.sock");
        } else if (rawTarget.socket) {
          socket = expandHome(rawTarget.socket as string);
        } else {
          const home = process.env.HOME;
          if (!home) throw new Error("$HOME not set");
          socket = path.join(home, ".config/herdr/herdr.sock");
        }

        targets.push({
          name,
          kind: "local",
          socket,
        });
      } else if (kind === "remote") {
        const host = rawTarget.host as string | undefined;
        if (!host) {
          throw new Error(`targets[] with kind "remote" must have host set`);
        }

        const remoteSocket = (rawTarget.remote_socket as string) || "~/.config/herdr/herdr.sock";

        targets.push({
          name,
          kind: "remote",
          host,
          remoteSocket,
        });
      } else {
        throw new Error(`targets[].kind must be "local" or "remote", got "${kind}"`);
      }
    }
  }

  return {
    port,
    terminalApp,
    planUsageEnabled,
    targets,
  };
}

function useTomlParser(content: string): Record<string, unknown> {
  // Check if Bun.TOML.parse exists at runtime.
  // In Bun env, use native TOML parser; otherwise fall back to minimal parser.
  const bunGlobal = globalThis as { Bun?: { TOML?: { parse?: (content: string) => unknown } } };
  if (bunGlobal.Bun?.TOML?.parse) {
    return bunGlobal.Bun.TOML.parse(content) as Record<string, unknown>;
  }

  // Fall back to minimal parser
  return parseToml(content);
}
