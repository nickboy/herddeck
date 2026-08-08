import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type HerdDeckConfig, type TargetConfig, loadConfig } from "./config";

function targetAt(config: HerdDeckConfig, i: number): TargetConfig {
  const t = config.targets[i];
  if (!t) throw new Error(`no target at index ${i}`);
  return t;
}

describe("config", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "herddeck-config-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    if (originalHome) {
      process.env.HOME = originalHome;
    }
  });

  describe("loadConfig", () => {
    test("returns default config when file missing", () => {
      const configPath = path.join(tempDir, "config.toml");
      const config = loadConfig(configPath);

      expect(config.port).toBe(9137);
      expect(config.terminalApp).toBe("Ghostty");
      expect(config.planUsageEnabled).toBe(true);
      expect(config.targets).toHaveLength(1);
      expect(targetAt(config, 0)).toEqual({
        name: "local",
        kind: "local",
        socket: path.join(tempDir, ".config/herdr/herdr.sock"),
        focusTerminal: true,
      });
    });

    test("parses port override", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[daemon]
port = 8080
`,
      );

      const config = loadConfig(configPath);
      expect(config.port).toBe(8080);
    });

    test("parses terminalApp from [ui]", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[ui]
terminal_app = "Kitty"
`,
      );

      const config = loadConfig(configPath);
      expect(config.terminalApp).toBe("Kitty");
    });

    test("parses planUsageEnabled from [plan_usage]", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[plan_usage]
enabled = false
`,
      );

      const config = loadConfig(configPath);
      expect(config.planUsageEnabled).toBe(false);
    });

    test("parses local target with explicit socket", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "local"
kind = "local"
socket = "~/.config/herdr/herdr.sock"
`,
      );

      const config = loadConfig(configPath);
      expect(config.targets).toHaveLength(1);
      expect(targetAt(config, 0)).toEqual({
        name: "local",
        kind: "local",
        socket: path.join(tempDir, ".config/herdr/herdr.sock"),
        focusTerminal: true,
      });
    });

    test("parses local target with named session socket", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "local"
kind = "local"
session = "mysession"
`,
      );

      const config = loadConfig(configPath);
      expect(config.targets).toHaveLength(1);
      expect(targetAt(config, 0)).toEqual({
        name: "local",
        kind: "local",
        socket: path.join(tempDir, ".config/herdr/sessions/mysession/herdr.sock"),
        focusTerminal: true,
      });
    });

    test("parses local target with default socket when neither socket nor session set", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "local"
kind = "local"
`,
      );

      const config = loadConfig(configPath);
      expect(config.targets).toHaveLength(1);
      expect(targetAt(config, 0)).toEqual({
        name: "local",
        kind: "local",
        socket: path.join(tempDir, ".config/herdr/herdr.sock"),
        focusTerminal: true,
      });
    });

    test("parses remote target with absolute remote_socket", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "workbox"
kind = "remote"
host = "workbox.example.com"
remote_socket = "/home/nick/.config/herdr/herdr.sock"
`,
      );

      const config = loadConfig(configPath);
      expect(config.targets).toHaveLength(1);
      const target = targetAt(config, 0);
      expect(target.kind).toBe("remote");
      expect(target.name).toBe("workbox");
      if (target.kind === "remote") {
        expect(target.host).toBe("workbox.example.com");
        expect(target.remoteSocket).toBe("/home/nick/.config/herdr/herdr.sock");
      }
    });

    test("throws when remote_socket is missing", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "workbox"
kind = "remote"
host = "workbox.example.com"
`,
      );

      expect(() => loadConfig(configPath)).toThrow(/remote_socket is required/);
    });

    test("throws when remote_socket uses a tilde (sshd does not expand it)", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "workbox"
kind = "remote"
host = "workbox.example.com"
remote_socket = "~/.config/herdr/herdr.sock"
`,
      );

      expect(() => loadConfig(configPath)).toThrow(/absolute path/);
    });

    test("parses multiple targets", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "local"
kind = "local"

[[targets]]
name = "workbox"
kind = "remote"
host = "workbox.example.com"
remote_socket = "/home/nick/.config/herdr/herdr.sock"
`,
      );

      const config = loadConfig(configPath);
      expect(config.targets).toHaveLength(2);
      expect(targetAt(config, 0).name).toBe("local");
      expect(targetAt(config, 0).kind).toBe("local");
      expect(targetAt(config, 1).name).toBe("workbox");
      expect(targetAt(config, 1).kind).toBe("remote");
    });

    test("throws on duplicate target names", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "local"
kind = "local"

[[targets]]
name = "local"
kind = "remote"
host = "other.com"
`,
      );

      expect(() => {
        loadConfig(configPath);
      }).toThrow(/duplicated/);
    });

    test("throws on invalid target name (uppercase)", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "Local"
kind = "local"
`,
      );

      expect(() => {
        loadConfig(configPath);
      }).toThrow(/must match \/\^/);
    });

    test("throws on invalid target name (special chars)", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "local_box"
kind = "local"
`,
      );

      expect(() => {
        loadConfig(configPath);
      }).toThrow(/must match \/\^/);
    });

    test("throws on target name with spaces", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "local box"
kind = "local"
`,
      );

      expect(() => {
        loadConfig(configPath);
      }).toThrow(/must match \/\^/);
    });

    test("allows valid target names with hyphens and numbers", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "local-box-1"
kind = "local"

[[targets]]
name = "workbox-v2"
kind = "local"
`,
      );

      const config = loadConfig(configPath);
      expect(config.targets).toHaveLength(2);
      expect(targetAt(config, 0).name).toBe("local-box-1");
      expect(targetAt(config, 1).name).toBe("workbox-v2");
    });

    test("throws when remote target missing host", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "remote-no-host"
kind = "remote"
`,
      );

      expect(() => {
        loadConfig(configPath);
      }).toThrow(/must have host set/);
    });

    test("throws on invalid kind", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "invalid"
kind = "unknown"
`,
      );

      expect(() => {
        loadConfig(configPath);
      }).toThrow(/must be "local" or "remote"/);
    });

    test("handles comments in TOML", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `# Configuration file
[daemon]
port = 9137  # default port

[ui]
terminal_app = "Ghostty"  # terminal to use
`,
      );

      const config = loadConfig(configPath);
      expect(config.port).toBe(9137);
      expect(config.terminalApp).toBe("Ghostty");
    });

    test("handles full config with all sections and targets", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[daemon]
port = 8080

[ui]
terminal_app = "Kitty"

[plan_usage]
enabled = false

[[targets]]
name = "local"
kind = "local"
socket = "~/.config/herdr/herdr.sock"

[[targets]]
name = "workbox"
kind = "remote"
host = "workbox.example.com"
remote_socket = "/home/nick/.config/herdr/custom.sock"
`,
      );

      const config = loadConfig(configPath);
      expect(config.port).toBe(8080);
      expect(config.terminalApp).toBe("Kitty");
      expect(config.planUsageEnabled).toBe(false);
      expect(config.targets).toHaveLength(2);
    });

    test("expands ~ in local socket paths", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "local"
kind = "local"
socket = "~/custom/herdr.sock"
`,
      );

      const config = loadConfig(configPath);
      const target = targetAt(config, 0);
      if (target.kind === "local") {
        expect(target.socket).toBe(path.join(tempDir, "custom/herdr.sock"));
        expect(target.socket).not.toContain("~");
      }
    });

    test("rejects ~ in remote socket paths verbatim (never expands)", () => {
      const configPath = path.join(tempDir, "config.toml");
      fs.writeFileSync(
        configPath,
        `[[targets]]
name = "remote"
kind = "remote"
host = "box.com"
remote_socket = "~/custom/herdr.sock"
`,
      );

      expect(() => loadConfig(configPath)).toThrow(/absolute path/);
    });
  });
});

describe("focus_terminal", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "herddeck-focus-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("defaults to true for local and remote targets", () => {
    const p = path.join(dir, "config.toml");
    fs.writeFileSync(
      p,
      `[[targets]]
name = "local"
kind = "local"

[[targets]]
name = "macmini"
kind = "remote"
host = "mini.local"
remote_socket = "/Users/nick/.config/herdr/herdr.sock"
`,
    );
    const config = loadConfig(p);
    expect(targetAt(config, 0).focusTerminal).toBe(true);
    expect(targetAt(config, 1).focusTerminal).toBe(true);
  });

  test("honors an explicit opt-out on a remote target", () => {
    const p = path.join(dir, "config.toml");
    fs.writeFileSync(
      p,
      `[[targets]]
name = "headless"
kind = "remote"
host = "box"
remote_socket = "/home/you/.config/herdr/herdr.sock"
focus_terminal = false
`,
    );
    expect(targetAt(loadConfig(p), 0).focusTerminal).toBe(false);
  });
});
