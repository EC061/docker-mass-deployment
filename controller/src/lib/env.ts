/**
 * Controller environment. Only bootstrap/connection secrets live here; all operational settings
 * (SMTP, WebDAV, quota defaults, GPU policy) are stored in the `settings` table and edited in the UI.
 *
 * Values are read lazily (getters) so importing this module never throws — required-var validation
 * happens on first access at runtime, not during the Next.js build's static analysis. Call
 * assertEnv() once at server boot to validate everything eagerly and fail closed with a clear error.
 */

// Bootstrap secrets must be supplied in EVERY environment — no dev fallbacks. Published default
// strings (the old "dev-*" values) let anyone forge an admin JWT or connect agents on a from-source
// deploy, so we fail closed regardless of NODE_ENV (H-01). For local development, generate real
// values once (e.g. `openssl rand -hex 32`) and put them in .env.local.
function required(name: string): string {
  const value = process.env[name];
  if (value && value !== "") return value;
  throw new Error(`Missing required env var ${name} (set a real value; there is no default)`);
}

// Substrings that mark a value as an unset template/placeholder. Rejected in every environment so a
// copied-but-not-filled-in .env can never reach production. Kept deliberately narrow (no "secret"/
// "password"/"test" — those are legitimate substrings of strong values and of the test fixtures).
const PLACEHOLDER_MARKERS = ["replace_with", "changeme", "change-me", "placeholder", "example"];

const isProdEnv = () => process.env.NODE_ENV === "production";

/**
 * Reject obvious placeholder/weak secrets. Placeholder markers fail everywhere; a length floor and
 * the all-identical-character check are enforced only in production, so the short fixtures the test
 * suite uses ("t", "test-agent", …) keep working while a real deployment must use strong values.
 */
function rejectWeak(name: string, value: string, minLenProd: number): string {
  const lower = value.toLowerCase();
  for (const marker of PLACEHOLDER_MARKERS) {
    if (lower.includes(marker)) {
      throw new Error(`${name} looks like a placeholder ("${marker}"); set a real random value`);
    }
  }
  if (isProdEnv()) {
    if (value.length < minLenProd) {
      throw new Error(`${name} must be at least ${minLenProd} characters in production`);
    }
    if (/^(.)\1*$/.test(value)) {
      throw new Error(`${name} must not be a single repeated character`);
    }
  }
  return value;
}

// One DNS hostname: dot-separated labels of [A-Za-z0-9-] (no leading/trailing hyphen per label),
// total <= 253 chars. No scheme, no port, no path, no wildcard, no comma — those are rejected with a
// specific message before this runs.
const HOSTNAME_RE =
  /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Validate CONTROLLER_DOMAIN as exactly one hostname; return "" (same-origin) when unset. */
function validateControllerDomain(raw: string): string {
  const v = raw.trim();
  if (v === "") return "";
  if (v.includes(",")) {
    throw new Error("CONTROLLER_DOMAIN must be exactly one hostname (no comma-separated list)");
  }
  if (v.includes("://") || v.includes("/")) {
    throw new Error("CONTROLLER_DOMAIN must be a bare hostname (no scheme or path)");
  }
  if (v.includes("*")) {
    throw new Error("CONTROLLER_DOMAIN must not contain a wildcard");
  }
  if (v.includes(":")) {
    throw new Error("CONTROLLER_DOMAIN must not include a port");
  }
  if (!HOSTNAME_RE.test(v)) {
    throw new Error(`CONTROLLER_DOMAIN is not a valid hostname: '${v}'`);
  }
  return v.toLowerCase();
}

export const env = {
  get dbPath(): string {
    return process.env.DB_PATH ?? "./data/controller.db";
  },
  get port(): number {
    const raw = process.env.PORT ?? "8443";
    if (!/^\d+$/.test(raw.trim())) {
      throw new Error(`PORT must be an integer (got '${raw}')`);
    }
    const n = parseInt(raw, 10);
    if (n < 1 || n > 65535) {
      throw new Error(`PORT must be between 1 and 65535 (got ${n})`);
    }
    return n;
  },
  get signupToken(): string {
    return rejectWeak("SIGNUP_TOKEN", required("SIGNUP_TOKEN"), 16);
  },
  get agentToken(): string {
    // Also the HMAC pepper for per-node token hashes (see lib/nodes.ts) — must be strong in prod.
    return rejectWeak("AGENT_TOKEN", required("AGENT_TOKEN"), 16);
  },
  get sessionSecret(): string {
    const secret = rejectWeak("SESSION_SECRET", required("SESSION_SECRET"), 32);
    // HS256 keys shorter than the 256-bit output are trivially weaker; enforce a sane floor in every
    // environment (the test fixture is exactly 32 chars).
    if (secret.length < 32) {
      throw new Error("SESSION_SECRET must be at least 32 characters (use `openssl rand -hex 32`)");
    }
    return secret;
  },
  /** The single public hostname the controller is reached at, or "" for same-origin (dev). */
  get controllerDomain(): string {
    return validateControllerDomain(process.env.CONTROLLER_DOMAIN ?? "");
  },
  /** "https://<domain>" — the only browser Origin accepted for mutations — or "" when unset. */
  get controllerOrigin(): string {
    const d = validateControllerDomain(process.env.CONTROLLER_DOMAIN ?? "");
    return d ? `https://${d}` : "";
  },
  get isProd(): boolean {
    return process.env.NODE_ENV === "production";
  },
};

/**
 * Eagerly validate every bootstrap variable. Called once at server start so a misconfigured deploy
 * fails immediately with a precise message instead of on the first request that happens to read a var.
 */
export function assertEnv(): void {
  void env.port;
  void env.signupToken;
  void env.agentToken;
  void env.sessionSecret;
  void env.controllerDomain;
}
