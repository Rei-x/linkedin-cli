import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConfigDir(): string {
  return process.env["LINKEDIN_CLI_DIR"] ?? join(homedir(), ".linkedin-cli");
}

export function defaultDbPath(): string {
  return process.env["LINKEDIN_CLI_DB"] ?? join(defaultConfigDir(), "cache.db");
}
