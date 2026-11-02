// Session handling for every request, plus the guard on the routes that need
// a signed-in user.
//
// Only the Responsible KPI Dashboard (/responsible/:id/dashboard), the user
// administration, the rows of the database shown on the KPI & Target Intake
// page and the saved AI Assistant conversations require an account. A user only opens their own dashboard:
// :id must be the people_id of their account (administrators open any). Every other page -- in particular the
// ones opened from e-mail links (/form, /dashboard, /kpi-training-center,
// /kpi-target-adjustments/review...) -- stays open exactly as before, so the
// API stays public except for the routes below. /api/admin/* additionally
// requires the admin role.
//
// GET/PUT/DELETE /api/kpis/:id are also called by the dashboard, but stay
// public because the open /kpi-admin page uses them too.

const PROTECTED_ROUTES = [
  // Responsible KPI Dashboard: KPI matrix, target allocations, charts, lookups (all methods)
  /^\/api\/responsibles\/[^/]+\/dashboard-context$/,
  /^\/api\/responsibles\/[^/]+\/kpis(\/[^/]+)?$/,
  /^\/api\/responsibles\/[^/]+\/kpi-objects(\/[^/]+)?$/,
  /^\/api\/responsibles\/[^/]+\/parameter-kpis(\/[^/]+)?$/,
  /^\/api\/responsibles\/[^/]+\/kpi-monthly-series$/,
  /^\/api\/responsibles\/[^/]+\/kpi-analytics-filters$/,
  /^\/api\/responsibles\/[^/]+\/kpi-graphs$/,
  /^\/api\/responsibles\/[^/]+\/kpi-history-monthly$/,
  // KPI & Target Intake page: the rows already in the database (the rest of the page is public)
  /^\/api\/kpi-intake\/records$/,
  // AI Assistant: the saved conversations of the signed-in user (the chat itself is public)
  /^\/api\/assistant\/conversations(\/[^/]+)?$/,
  // User administration
  /^\/api\/admin(\/|$)/
];

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const isProtectedRoute = (req) => PROTECTED_ROUTES.some((pattern) => pattern.test(req.path));

// The :id of /api/responsibles/:id/... -- the people_id of the dashboard's owner.
const getDashboardOwnerId = (req) => /^\/api\/responsibles\/([^/]+)\//.exec(req.path)?.[1];

// A user only opens their own dashboard (id = the people_id their account is
// linked to); administrators can open anyone's.
const canOpenDashboard = (user, ownerId) => user.role === "admin" || ownerId === String(user.people_id ?? "");

const parseCookies = (header) => {
  const cookies = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex < 0) return;
      const name = part.slice(0, separatorIndex).trim();
      if (!name || cookies[name] !== undefined) return;
      try {
        cookies[name] = decodeURIComponent(part.slice(separatorIndex + 1).trim());
      } catch {
        cookies[name] = part.slice(separatorIndex + 1).trim();
      }
    });
  return cookies;
};

const buildCookie = (config, value, { maxAgeSeconds }) => {
  const sameSite = config.cookieSameSite.charAt(0).toUpperCase() + config.cookieSameSite.slice(1);
  const parts = [
    `${config.cookieName}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (config.cookieSecure) parts.push("Secure");
  return parts.join("; ");
};

const setSessionCookie = (res, config, token, expiresAt) => {
  res.append("Set-Cookie", buildCookie(config, token, { maxAgeSeconds: (expiresAt.getTime() - Date.now()) / 1000 }));
};

const clearSessionCookie = (res, config) => {
  res.append("Set-Cookie", buildCookie(config, "", { maxAgeSeconds: 0 }));
};

const getRequestMeta = (req) => ({
  ipAddress: req.ip || req.socket?.remoteAddress || null,
  userAgent: req.get("user-agent") || null
});

const createAuthMiddleware = ({ authService, config, logger = console }) => {
  // Loads the session (if any) for every request: req.auth = { user, sessionId, token } or null.
  const attachSession = async (req, res, next) => {
    req.auth = null;
    const token = parseCookies(req.headers.cookie)[config.cookieName];
    if (!token) return next();

    try {
      const session = await authService.getSession(token);
      if (session) {
        req.auth = { user: session.user, sessionId: session.sessionId, token };
      } else {
        // Expired or revoked: drop the stale cookie.
        clearSessionCookie(res, config);
      }
    } catch (error) {
      logger.error("[Auth] Session lookup failed:", error.message);
      req.authError = error;
    }
    return next();
  };

  // Cookie-authenticated, state-changing requests must come from the app
  // itself (CSRF protection on top of the SameSite cookie).
  const verifyOrigin = (req, res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();
    if (!parseCookies(req.headers.cookie)[config.cookieName]) return next();

    const origin = String(req.get("origin") || "").replace(/\/+$/, "");
    if (origin && !config.allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: "Request origin not allowed.", code: "ORIGIN_NOT_ALLOWED" });
    }
    return next();
  };

  const requireAuthentication = (req, res, next) => {
    if (req.method === "OPTIONS" || !isProtectedRoute(req)) return next();

    if (!req.auth) {
      if (req.authError) {
        return res.status(503).json({ error: "Authentication is temporarily unavailable.", code: "AUTH_UNAVAILABLE" });
      }
      return res.status(401).json({ error: "Authentication required.", code: "AUTH_REQUIRED" });
    }
    if (req.auth.user.must_change_password) {
      return res.status(403).json({
        error: "You must change your password before continuing.",
        code: "PASSWORD_CHANGE_REQUIRED"
      });
    }
    const ownerId = getDashboardOwnerId(req);
    if (ownerId !== undefined && !canOpenDashboard(req.auth.user, ownerId)) {
      return res.status(403).json({ error: "This KPI dashboard belongs to another person.", code: "NOT_OWN_DASHBOARD" });
    }
    return next();
  };

  const requireAdmin = (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: "Authentication required.", code: "AUTH_REQUIRED" });
    if (req.auth.user.role !== "admin") {
      return res.status(403).json({ error: "Administrator access required.", code: "ADMIN_REQUIRED" });
    }
    return next();
  };

  return { attachSession, verifyOrigin, requireAuthentication, requireAdmin };
};

module.exports = {
  PROTECTED_ROUTES,
  isProtectedRoute,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  getRequestMeta,
  createAuthMiddleware
};
