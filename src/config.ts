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

export const config = {
  port: parseInt(optional("PORT", "8090"), 10),
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

  adminBootstrap: {
    user: optional("ADMIN_BOOTSTRAP_USER", ""),
    pass: optional("ADMIN_BOOTSTRAP_PASS", ""),
  },
} as const;

export const isProd = config.nodeEnv === "production";
