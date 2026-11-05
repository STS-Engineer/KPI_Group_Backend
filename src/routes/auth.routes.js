const crypto = require("crypto");
const express = require("express");
const { RateLimiterMemory } = require("rate-limiter-flexible");
const { setSessionCookie, clearSessionCookie, getRequestMeta, parseCookies } = require("../middlewares/auth.middleware");
const { getAadstsCode } = require("../services/microsoftAuth.service");

const TOO_MANY_REQUESTS_MESSAGE =
  "Too many failed attempts. Try again in a few minutes or reset your password.";

// "Continue with Microsoft": what /login must find again in /callback (state,
// PKCE verifier, nonce, the page to return to) waits in a short-lived cookie
// limited to these two routes -- nothing in server memory, so it survives a
// restart or another instance answering the callback. SameSite=Lax: it is
// sent when Microsoft redirects the browser back to the callback.
const MICROSOFT_COOKIE = "kpi_ms_signin";
const MICROSOFT_COOKIE_PATH = "/api/auth/microsoft";
const MICROSOFT_SIGN_IN_TTL_SECONDS = 10 * 60;

const buildMicrosoftCookie = (config, value, maxAgeSeconds) => {
  const parts = [
    `${MICROSOFT_COOKIE}=${value}`,
    `Path=${MICROSOFT_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
};

const readMicrosoftTransaction = (req) => {
  try {
    const value = parseCookies(req.headers.cookie)[MICROSOFT_COOKIE];
    const transaction = value ? JSON.parse(Buffer.from(value, "base64url").toString("utf8")) : null;
    return transaction?.state && transaction?.verifier && transaction?.nonce ? transaction : null;
  } catch {
    return null;
  }
};

const sameText = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Same rule as getSafeNextPath() in the React app: a page of the app only.
const getSafeNextPath = (value) => {
  const path = String(value || "");
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\") || path.startsWith("/login")) return null;
  return path.slice(0, 1000);
};

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

// A JSON value safe inside an inline <script>.
const toScriptValue = (value) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .split(LINE_SEPARATOR).join("\\u2028")
    .split(PARAGRAPH_SEPARATOR).join("\\u2029");

// End of a Microsoft sign-in, in the popup the sign-in page opened: tells that
// page the result (postMessage, only to its origin) and closes. Opened in the
// main window instead (popup blocked), it goes back to /login, which opens the
// app once signed in or shows the error.
const sendMicrosoftResult = (res, { origin, next }, result) => {
  const query = new URLSearchParams();
  if (next) query.set("next", next);
  if (!result.ok) query.set("microsoft_error", result.error);
  if (!result.ok && result.detail) query.set("microsoft_detail", result.detail);
  const queryText = query.toString();
  const fallbackUrl = `${origin}/login${queryText ? `?${queryText}` : ""}`;
  const message = { type: "kpi-microsoft-sign-in", ok: result.ok, error: result.error || null, detail: result.detail || null };
  const nonce = crypto.randomBytes(16).toString("base64");

  res.set(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  );
  res.set("Referrer-Policy", "no-referrer");
  res.type("html").send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>KPI Manager</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#334155">
<p>${result.ok ? "Signed in. You can close this window." : "Back to KPI Manager..."}</p>
<script nonce="${nonce}">
(function () {
  var message = ${toScriptValue(message)};
  var origin = ${toScriptValue(origin)};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(message, origin);
      window.close();
      return;
    }
  } catch (error) {}
  window.location.replace(${toScriptValue(fallbackUrl)});
})();
</script>
</body>
</html>`);
};

const sendError = (res, error, logLabel) => {
  if (!error.statusCode) console.error(`${logLabel} error:`, error);
  return res.status(error.statusCode || 500).json({
    error: error.statusCode ? error.message : "Unexpected error. Please try again."
  });
};

// Resolves to true when the request may proceed; otherwise answers 429 itself.
const consumeOrReject = async (limiter, key, res) => {
  try {
    await limiter.consume(key);
    return true;
  } catch (rateLimiterRes) {
    if (rateLimiterRes instanceof Error) throw rateLimiterRes;
    res.set("Retry-After", String(Math.ceil((rateLimiterRes.msBeforeNext || 60000) / 1000)));
    res.status(429).json({ error: TOO_MANY_REQUESTS_MESSAGE });
    return false;
  }
};

// microsoftAuth: services/microsoftAuth.service.js (null: no "Continue with Microsoft").
const createAuthRouter = ({ authService, config, microsoftAuth = null }) => {
  const router = express.Router();

  // Per e-mail + IP, so one person cannot lock out a colleague's account from
  // elsewhere, and per IP, against password spraying across many accounts.
  const loginByAccountLimiter = new RateLimiterMemory({ points: config.maxFailedLogins, duration: 15 * 60 });
  const loginByIpLimiter = new RateLimiterMemory({ points: config.loginRateLimitPerIp, duration: 15 * 60 });
  const forgotPasswordLimiter = new RateLimiterMemory({ points: config.forgotPasswordRateLimitPerIp, duration: 15 * 60 });
  const tokenLimiter = new RateLimiterMemory({ points: config.tokenRateLimitPerIp, duration: 15 * 60 });
  const changePasswordLimiter = new RateLimiterMemory({ points: 10, duration: 15 * 60 });
  const microsoftLimiter = new RateLimiterMemory({ points: config.loginRateLimitPerIp, duration: 15 * 60 });

  // The React app the result goes back to: the origin it sent, if allowed.
  const defaultOrigin = (() => {
    try {
      return new URL(config.appUrl).origin;
    } catch {
      return config.allowedOrigins[0];
    }
  })();
  const pickOrigin = (value) => {
    const origin = String(value || "").replace(/\/+$/, "");
    return config.allowedOrigins.includes(origin) ? origin : defaultOrigin;
  };

  router.use("/api/auth", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.post("/api/auth/login", async (req, res) => {
    try {
      const meta = getRequestMeta(req);
      const email = String(req.body?.email || "").trim().toLowerCase();
      const accountKey = `${meta.ipAddress}|${email}`;
      if (!(await consumeOrReject(loginByIpLimiter, String(meta.ipAddress), res))) return;
      if (!(await consumeOrReject(loginByAccountLimiter, accountKey, res))) return;

      const { user, token, expiresAt } = await authService.login(
        { email: req.body?.email, password: req.body?.password },
        meta
      );
      await loginByAccountLimiter.delete(accountKey);

      // A session cookie left from a previous login on this browser is revoked.
      if (req.auth?.token) await authService.logout(req.auth.token, meta);
      setSessionCookie(res, config, token, expiresAt);
      return res.json({ user });
    } catch (error) {
      return sendError(res, error, "POST /api/auth/login");
    }
  });

  router.post("/api/auth/logout", async (req, res) => {
    try {
      if (req.auth?.token) await authService.logout(req.auth.token, getRequestMeta(req));
      clearSessionCookie(res, config);
      return res.json({ success: true });
    } catch (error) {
      return sendError(res, error, "POST /api/auth/logout");
    }
  });

  router.get("/api/auth/me", (req, res) => {
    res.json({ user: req.auth ? authService.toSessionUser(req.auth.user) : null });
  });

  // Sign-in methods shown on the sign-in page.
  router.get("/api/auth/providers", (_req, res) => {
    res.json({ microsoft: Boolean(microsoftAuth?.enabled) });
  });

  // Opened by "Continue with Microsoft" (popup or whole page):
  // ?origin=<the React app>&next=<page to open once signed in>.
  router.get("/api/auth/microsoft/login", async (req, res) => {
    const context = { origin: pickOrigin(req.query.origin), next: getSafeNextPath(req.query.next) };
    if (!microsoftAuth?.enabled) return sendMicrosoftResult(res, context, { ok: false, error: "not_configured" });

    try {
      await microsoftLimiter.consume(String(getRequestMeta(req).ipAddress));
    } catch (rateLimiterRes) {
      if (rateLimiterRes instanceof Error) console.error("GET /api/auth/microsoft/login error:", rateLimiterRes);
      return sendMicrosoftResult(res, context, { ok: false, error: "too_many_attempts" });
    }

    try {
      const { url, transaction } = await microsoftAuth.startSignIn();
      const value = Buffer.from(JSON.stringify({ ...transaction, ...context })).toString("base64url");
      res.append("Set-Cookie", buildMicrosoftCookie(config, value, MICROSOFT_SIGN_IN_TTL_SECONDS));
      return res.redirect(url);
    } catch (error) {
      console.error("GET /api/auth/microsoft/login error:", error.message);
      return sendMicrosoftResult(res, context, { ok: false, error: "failed" });
    }
  });

  // Microsoft sends the browser back here (AZURE_REDIRECT_URI) with ?code&state.
  router.get("/api/auth/microsoft/callback", async (req, res) => {
    const transaction = readMicrosoftTransaction(req);
    res.append("Set-Cookie", buildMicrosoftCookie(config, "", 0));
    const context = { origin: pickOrigin(transaction?.origin), next: getSafeNextPath(transaction?.next) };
    const fail = (error, detail = null) => sendMicrosoftResult(res, context, { ok: false, error, detail });

    if (!microsoftAuth?.enabled) return fail("not_configured");
    const { code, state, error: providerError, error_description: providerErrorDescription } = req.query;
    if (providerError) {
      console.warn("[Auth] Microsoft sign-in refused by Microsoft:", providerError, providerErrorDescription);
      return fail(providerError === "access_denied" ? "cancelled" : "microsoft_error", getAadstsCode(providerErrorDescription));
    }
    // No cookie (expired, other browser) or another sign-in's state: start again.
    if (!transaction || !sameText(state, transaction.state)) return fail("expired");
    if (!code) return fail("failed");

    try {
      const meta = getRequestMeta(req);
      const claims = await microsoftAuth.completeSignIn({
        code: String(code),
        verifier: transaction.verifier,
        nonce: transaction.nonce
      });
      const { token, expiresAt } = await authService.signInWithMicrosoft({ claims }, meta);
      // A session cookie left from a previous login on this browser is revoked.
      if (req.auth?.token) await authService.logout(req.auth.token, meta);
      setSessionCookie(res, config, token, expiresAt);
      return sendMicrosoftResult(res, context, { ok: true });
    } catch (error) {
      // Refused by our own rules (no account, role not allowed...): the reason.
      if (error.statusCode && error.code) return fail(error.code, error.details?.org_role_label || null);
      console.error("GET /api/auth/microsoft/callback error:", error.errorCode || "", error.message);
      return fail("failed", getAadstsCode(error.message));
    }
  });

  router.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const meta = getRequestMeta(req);
      if (!(await consumeOrReject(forgotPasswordLimiter, String(meta.ipAddress), res))) return;
      await authService.requestPasswordReset({ email: req.body?.email }, meta);
      return res.json({
        success: true,
        message: "If an active account exists for this e-mail, a reset link has been sent to it."
      });
    } catch (error) {
      return sendError(res, error, "POST /api/auth/forgot-password");
    }
  });

  router.get("/api/auth/password-token", async (req, res) => {
    try {
      if (!(await consumeOrReject(tokenLimiter, String(getRequestMeta(req).ipAddress), res))) return;
      return res.json(await authService.validatePasswordToken(String(req.query?.token || "")));
    } catch (error) {
      return sendError(res, error, "GET /api/auth/password-token");
    }
  });

  router.post("/api/auth/reset-password", async (req, res) => {
    try {
      const meta = getRequestMeta(req);
      if (!(await consumeOrReject(tokenLimiter, String(meta.ipAddress), res))) return;
      const result = await authService.completePasswordReset(
        { token: String(req.body?.token || ""), password: req.body?.password },
        meta
      );
      // Every session of the account was revoked, including this browser's if any.
      clearSessionCookie(res, config);
      return res.json({ success: true, email: result.email });
    } catch (error) {
      return sendError(res, error, "POST /api/auth/reset-password");
    }
  });

  // Allowed while a password change is required (temporary password).
  router.post("/api/auth/change-password", async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ error: "Authentication required.", code: "AUTH_REQUIRED" });
      if (!(await consumeOrReject(changePasswordLimiter, String(req.auth.user.user_id), res))) return;
      const user = await authService.changePassword(
        req.auth.user,
        req.auth.sessionId,
        { currentPassword: req.body?.current_password, newPassword: req.body?.new_password },
        getRequestMeta(req)
      );
      return res.json({ user });
    } catch (error) {
      return sendError(res, error, "POST /api/auth/change-password");
    }
  });

  return router;
};

module.exports = { createAuthRouter };
