const { parseBooleanEnv } = require("./mailer");

const parsePositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseOriginList = (value) =>
  String(value || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);

// "Continue with Microsoft" (Entra ID app registration "KPI Manager"). Only
// from the environment, never hardcoded: without all four values the button
// is hidden and the Microsoft routes answer "not configured".
const loadMicrosoftConfig = (env) => {
  const value = (name) => String(env[name] || "").trim();
  const microsoft = {
    tenantId: value("AZURE_TENANT_ID"),
    clientId: value("AZURE_CLIENT_ID"),
    clientSecret: value("AZURE_CLIENT_SECRET"),
    redirectUri: value("AZURE_REDIRECT_URI")
  };
  return { ...microsoft, enabled: Object.values(microsoft).every(Boolean) };
};

const loadAuthConfig = (env = process.env) => {
  const allowedOrigins = parseOriginList(env.FRONTEND_URL || "http://localhost:5173");
  const sameSite = String(env.AUTH_COOKIE_SAMESITE || "lax").trim().toLowerCase();

  return {
    microsoft: loadMicrosoftConfig(env),
    cookieName: "kpi_session",
    // Browsers only accept SameSite=None together with Secure.
    cookieSecure: sameSite === "none" || parseBooleanEnv(env.AUTH_COOKIE_SECURE, env.NODE_ENV === "production"),
    cookieSameSite: ["lax", "strict", "none"].includes(sameSite) ? sameSite : "lax",
    // Absolute lifetime of a session, and how long it survives without any request.
    sessionTtlMs: parsePositiveNumber(env.AUTH_SESSION_TTL_HOURS, 12) * 60 * 60 * 1000,
    sessionIdleMs: parsePositiveNumber(env.AUTH_SESSION_IDLE_MINUTES, 120) * 60 * 1000,
    resetTokenTtlMs: parsePositiveNumber(env.AUTH_RESET_TOKEN_TTL_MINUTES, 60) * 60 * 1000,
    inviteTokenTtlMs: parsePositiveNumber(env.AUTH_INVITE_TOKEN_TTL_HOURS, 72) * 60 * 60 * 1000,
    maxFailedLogins: parsePositiveNumber(env.AUTH_MAX_FAILED_LOGINS, 5),
    lockoutMs: parsePositiveNumber(env.AUTH_LOCKOUT_MINUTES, 15) * 60 * 1000,
    // Requests per IP address per 15 minutes.
    loginRateLimitPerIp: parsePositiveNumber(env.AUTH_LOGIN_RATE_LIMIT_PER_IP, 30),
    forgotPasswordRateLimitPerIp: parsePositiveNumber(env.AUTH_FORGOT_PASSWORD_RATE_LIMIT_PER_IP, 5),
    tokenRateLimitPerIp: parsePositiveNumber(env.AUTH_TOKEN_RATE_LIMIT_PER_IP, 30),
    allowedOrigins,
    // Links in invitation / reset e-mails point to the React app.
    appUrl: (String(env.AUTH_APP_URL || "").trim().replace(/\/+$/, "") || allowedOrigins[0] || "http://localhost:5173"),
    mailFrom: String(env.AUTH_MAIL_FROM || "").trim() || '"KPI Manager" <kpi-manager@avocarbon.com>'
  };
};

module.exports = { loadAuthConfig };
