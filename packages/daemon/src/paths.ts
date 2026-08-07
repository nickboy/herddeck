import fs from "node:fs";
import path from "node:path";

export function herddeckDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("$HOME not set");
  return path.join(home, ".herddeck");
}

export function runDir(): string {
  return path.join(herddeckDir(), "run");
}

export function configPath(): string {
  return path.join(herddeckDir(), "config.toml");
}

export function logPath(): string {
  return path.join(herddeckDir(), "daemon.log");
}

export function ensureRunDir(): string {
  const dir = runDir();

  try {
    const stat = fs.statSync(dir);
    const mode = stat.mode & 0o777;

    if (mode !== 0o700) {
      throw new Error(
        `runDir ${dir} has insecure permissions 0${mode.toString(8)} (expected 0700). ` +
          `Forwarded sockets live there; set to 0700 with: chmod 700 ${dir}`,
      );
    }

    return dir;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    }
    throw e;
  }
}
