// In-memory cookie store for the Voyager client.
//
// We do not use tough-cookie's CookieJar directly because:
//   - LinkedIn does not always send a Domain attribute (and we want host-only
//     behavior pinned to www.linkedin.com regardless).
//   - We want stable, deterministic Cookie: header output regardless of
//     attribute parsing quirks.
//   - The Set-Cookie "li_at=delete me" sentinel is what the Go reference checks
//     for invalidated sessions (checkHTTPRedirect, request.go:57-69).
//
// We still use tough-cookie's Cookie.parse to robustly parse individual
// Set-Cookie strings (handles quoted values, attribute parsing, RFC edge cases),
// then we store only name->value in our own Map keyed by cookie name.

import { Cookie } from "tough-cookie";

const LI_AT_INVALIDATED_VALUES = new Set([
  "delete me",
  "delete%20me",
]);

export class CookieStore {
  private readonly values = new Map<string, string>();
  private invalidated = false;

  private constructor() {}

  static fromHeader(rawCookieHeader: string): CookieStore {
    const store = new CookieStore();
    const trimmed = rawCookieHeader.trim();
    if (trimmed.length === 0) return store;
    // Split on `;` — the Cookie request header has a simpler grammar than
    // Set-Cookie: each segment is `name=value` with no attributes.
    for (const piece of trimmed.split(";")) {
      const seg = piece.trim();
      if (seg.length === 0) continue;
      const eq = seg.indexOf("=");
      if (eq <= 0) continue;
      const name = seg.slice(0, eq).trim();
      const value = seg.slice(eq + 1).trim();
      if (name.length === 0) continue;
      store.values.set(name, value);
    }
    return store;
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  setFromSetCookie(setCookieHeaders: string[]): void {
    for (const raw of setCookieHeaders) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      const parsed = Cookie.parse(raw);
      if (!parsed) continue;
      const name = parsed.key;
      const value = parsed.value;
      if (typeof name !== "string" || name.length === 0) continue;
      // Check the LinkedIn sentinel: li_at=delete me (or delete%20me).
      if (name === "li_at" && LI_AT_INVALIDATED_VALUES.has(value)) {
        this.invalidated = true;
      }
      this.values.set(name, value);
    }
  }

  toCookieHeader(): string {
    // Stable order: insertion order is deterministic because Map preserves it
    // and we never delete entries.
    const parts: string[] = [];
    for (const [name, value] of this.values) {
      parts.push(`${name}=${value}`);
    }
    return parts.join("; ");
  }

  isInvalidated(): boolean {
    return this.invalidated;
  }
}
