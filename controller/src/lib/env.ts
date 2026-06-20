/**
 * Controller environment. Only bootstrap/connection secrets live here; all operational settings
 * (SMTP, WebDAV, quota defaults, GPU policy) are stored in the `settings` table and edited in the UI.
 *
 * Values are read lazily (getters) so importing this module never throws — required-var validation
 * happens on first access at runtime, not during the Next.js build's static analysis.
 */

function required(name: string, devFallback?: string): string {
  const value = process.env[name];
  if (value && value !== "") return value;
  if (process.env.NODE_ENV !== "production" && devFallback !== undefined) return devFallback;
  throw new Error(`Missing required env var ${name}`);
}

export const env = {
  get dbPath(): string {
    return process.env.DB_PATH ?? "./data/controller.db";
  },
  get port(): number {
    return parseInt(process.env.PORT ?? "8443", 10);
  },
  get signupToken(): string {
    return required("SIGNUP_TOKEN", "dev-signup-token");
  },
  get agentToken(): string {
    return required("AGENT_TOKEN", "dev-agent-token");
  },
  get sessionSecret(): string {
    return required("SESSION_SECRET", "dev-session-secret-change-me-please");
  },
  get isProd(): boolean {
    return process.env.NODE_ENV === "production";
  },
};
