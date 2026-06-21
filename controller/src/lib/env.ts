/**
 * Controller environment. Only bootstrap/connection secrets live here; all operational settings
 * (SMTP, WebDAV, quota defaults, GPU policy) are stored in the `settings` table and edited in the UI.
 *
 * Values are read lazily (getters) so importing this module never throws — required-var validation
 * happens on first access at runtime, not during the Next.js build's static analysis.
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

export const env = {
  get dbPath(): string {
    return process.env.DB_PATH ?? "./data/controller.db";
  },
  get port(): number {
    return parseInt(process.env.PORT ?? "8443", 10);
  },
  get signupToken(): string {
    return required("SIGNUP_TOKEN");
  },
  get agentToken(): string {
    return required("AGENT_TOKEN");
  },
  get sessionSecret(): string {
    const secret = required("SESSION_SECRET");
    // HS256 keys shorter than the 256-bit output are trivially weaker; enforce a sane floor.
    if (secret.length < 32) {
      throw new Error("SESSION_SECRET must be at least 32 characters (use `openssl rand -hex 32`)");
    }
    return secret;
  },
  get isProd(): boolean {
    return process.env.NODE_ENV === "production";
  },
  // During the per-node-token rollout the shared AGENT_TOKEN still authenticates nodes whose row is
  // auth_mode='legacy'. Set ALLOW_LEGACY_AGENT_TOKEN=0 once every node has its own token to refuse
  // the shared token fleet-wide. Defaults on for backward compatibility.
  get allowLegacyAgentToken(): boolean {
    return process.env.ALLOW_LEGACY_AGENT_TOKEN !== "0";
  },
};
