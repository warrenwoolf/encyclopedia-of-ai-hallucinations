/** Parse environment variables once, fail loudly on missing required values. */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Read a value from $NAME, else from $NAME_FILE (a path on disk), else fall
 * back. Useful for secrets: keeps them off the command line / env dump.
 */
function optionalFile(name: string, fallback: string): string {
  const direct = process.env[name];
  if (direct && direct.length > 0) return direct;
  const filePath = process.env[`${name}_FILE`];
  if (filePath && filePath.length > 0) {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const v = fs.readFileSync(filePath, "utf8").trim();
      if (v.length > 0) return v;
    } catch (err) {
      console.error(`[config] failed to read ${name}_FILE=${filePath}:`, err);
    }
  }
  return fallback;
}

export const config = {
  port: parseInt(optional("PORT", "8090"), 10),
  hostname: optional("HOST", "0.0.0.0"),
  nodeEnv: optional("NODE_ENV", "development"),
  inDevelopment: bool("IN_DEVELOPMENT", true),

  db: {
    host: optional("DB_HOST", "127.0.0.1"),
    port: parseInt(optional("DB_PORT", "3306"), 10),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
  },

  sessionSecret: required("SESSION_SECRET"),

  /** Where the public site lives. Used to build absolute URLs in outbound emails. */
  publicBaseUrl: optional("PUBLIC_BASE_URL", "https://enaih.org"),

  email: {
    /** When unset, email sending is disabled and the module no-ops. */
    resendApiKey: optionalFile("RESEND_API_KEY", ""),
    from: optional("EMAIL_FROM", "ENAIH <noreply@eah.warrenwoolf.com>"),
    /** Where bounces / human replies should go. */
    replyTo: optional("EMAIL_REPLY_TO", "noreply@eah.warrenwoolf.com"),
    /** Public-facing address for privacy / data-deletion requests. Shown on /privacy. */
    privacy: optional("PRIVACY_EMAIL", "privacy@eah.warrenwoolf.com"),
    /**
     * Monthly send cap. Free Resend tier is 300/month; we default to 280 to
     * leave headroom for transactional review-decision mail after we hide
     * the email-signup option. Set to 0 to disable the gate entirely.
     */
    monthlyCap: parseInt(optional("EMAIL_MONTHLY_CAP", "280"), 10),
    /**
     * Where staff-facing notices (e.g. entry complaints) are emailed. Defaults
     * to the privacy inbox — a real, monitored address — but can be pointed at
     * a dedicated contact/abuse mailbox via CONTACT_EMAIL.
     */
    contact: optional("CONTACT_EMAIL", optional("PRIVACY_EMAIL", "privacy@eah.warrenwoolf.com")),
  },

  /**
   * Google Identity Services (GIS) client. When the client id is unset, the
   * "Continue with Google" button is hidden and the verify route returns 404.
   *
   * No client secret or redirect URI: the GIS embedded flow returns an ID
   * token (credential) directly to the browser, which we verify locally
   * against Google's JWKS (see src/oauth-google.ts). There is no server-side
   * code exchange and no redirect/callback URL, so neither value is needed.
   */
  googleOAuth: {
    clientId: optional("GOOGLE_CLIENT_ID", ""),
  },

  adminBootstrap: {
    user: optional("ADMIN_BOOTSTRAP_USER", ""),
    email: optional("ADMIN_BOOTSTRAP_EMAIL", ""),
    pass: optional("ADMIN_BOOTSTRAP_PASS", ""),
  },

  /**
   * Discord bot notifications. When the bot token is unset, the module no-ops.
   * Two channels: new submissions entering the review queue go to the staff
   * channel; newly published entries go to the public channel. Either channel
   * id can be left blank to disable just that notification.
   */
  discord: {
    botToken: optionalFile("DISCORD_BOT_TOKEN", ""),
    staffChannelId: optional("DISCORD_STAFF_CHANNEL_ID", ""),
    publicChannelId: optional("DISCORD_PUBLIC_CHANNEL_ID", ""),
  },
} as const;

export const isProd = config.nodeEnv === "production";
