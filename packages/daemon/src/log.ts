// Single diagnostics sink for the daemon.
//
// Silent under `bun test` (which sets NODE_ENV=test): several suites
// deliberately drive failure paths — bad ssh auth, refused tunnels,
// malformed WS frames, HTTP 429 — and their loud output appears in the
// middle of `install.sh`, which runs the suite. Users reasonably read
// those lines as a broken install (reported twice from real installs).
// Set HERDDECK_LOG=1 to see them while debugging a test.

const SILENT = process.env.NODE_ENV === "test" && process.env.HERDDECK_LOG !== "1";

export function logDiag(message: string): void {
  if (SILENT) return;
  console.error(message);
}

export function logInfo(message: string): void {
  if (SILENT) return;
  console.log(message);
}
