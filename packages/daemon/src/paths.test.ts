import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath, ensureRunDir, herddeckDir, logPath, runDir } from "./paths";

describe("paths", () => {
  describe("herddeckDir", () => {
    test("returns $HOME/.herddeck", () => {
      const home = process.env.HOME;
      expect(home).toBeDefined();
      const result = herddeckDir();
      expect(result).toBe(path.join(home as string, ".herddeck"));
    });
  });

  describe("runDir", () => {
    test("returns $HOME/.herddeck/run", () => {
      const home = process.env.HOME;
      expect(home).toBeDefined();
      const result = runDir();
      expect(result).toBe(path.join(home as string, ".herddeck/run"));
    });
  });

  describe("configPath", () => {
    test("returns $HOME/.herddeck/config.toml", () => {
      const home = process.env.HOME;
      expect(home).toBeDefined();
      const result = configPath();
      expect(result).toBe(path.join(home as string, ".herddeck/config.toml"));
    });
  });

  describe("logPath", () => {
    test("returns $HOME/.herddeck/daemon.log", () => {
      const home = process.env.HOME;
      expect(home).toBeDefined();
      const result = logPath();
      expect(result).toBe(path.join(home as string, ".herddeck/daemon.log"));
    });
  });

  describe("ensureRunDir", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "herddeck-test-"));
      process.env.HOME = tempDir;
    });

    afterEach(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    });

    test("creates runDir with 0700 mode if missing", () => {
      const dir = runDir();
      expect(fs.existsSync(dir)).toBe(false);

      const result = ensureRunDir();

      expect(result).toBe(dir);
      expect(fs.existsSync(dir)).toBe(true);
      const stat = fs.statSync(dir);
      expect(stat.mode & 0o777).toBe(0o700);
    });

    test("returns existing runDir with correct permissions", () => {
      const dir = runDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

      const result = ensureRunDir();

      expect(result).toBe(dir);
      expect(fs.existsSync(dir)).toBe(true);
    });

    test("throws if runDir exists with insecure permissions", () => {
      const dir = runDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });

      expect(() => {
        ensureRunDir();
      }).toThrow();

      const err = expect(() => {
        ensureRunDir();
      }).toThrow();

      // Verify error message mentions security issue and chmod suggestion
      let error: Error | undefined;
      try {
        ensureRunDir();
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).toContain("insecure permissions");
      expect(error?.message).toContain("chmod 700");
    });

    test("throws if runDir exists with mode 0644", () => {
      const dir = runDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      fs.chmodSync(dir, 0o644);

      let error: Error | undefined;
      try {
        ensureRunDir();
      } catch (e) {
        error = e as Error;
      }
      expect(error?.message).toContain("insecure permissions");
    });
  });
});
