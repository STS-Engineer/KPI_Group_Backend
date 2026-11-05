const { createAuthService } = require("./services/auth.service");
const { createAuthMiddleware } = require("./middlewares/auth.middleware");
const { createAuthRouter } = require("./routes/auth.routes");
const { createAdminRouter } = require("./routes/admin.routes");
const { createKpiChangeLog } = require("./services/kpiChangeLog.service");
const { createMicrosoftAuth } = require("./services/microsoftAuth.service");

// Mounts authentication on the app. Must run before any other route is
// registered, so the routes listed in PROTECTED_ROUTES
// (middlewares/auth.middleware.js) are checked whatever router defines them.
// kpiIntake (optional): the KPI & Target Intake service, whose review and
// submit routes are administration routes. microsoftAuth / peopleDirectory:
// replaced by stand-ins in the tests (no call to Microsoft, no public.people).
const installAuth = (
  app,
  {
    db,
    sendMail,
    config,
    now,
    logger = console,
    kpiIntake = null,
    microsoftAuth = createMicrosoftAuth({ config }),
    peopleDirectory
  }
) => {
  const authService = createAuthService({ db, sendMail, config, now, logger, peopleDirectory });
  // Read by the administration ("KPI audit trail" tab); written by the KPI routes.
  const kpiChangeLog = createKpiChangeLog({ db });
  const { attachSession, verifyOrigin, requireAuthentication, requireAdmin } = createAuthMiddleware({
    authService,
    config,
    logger
  });

  app.use(attachSession);
  app.use(verifyOrigin);
  app.use(createAuthRouter({ authService, config, microsoftAuth }));
  app.use(requireAuthentication);
  app.use(createAdminRouter({ authService, requireAdmin, kpiChangeLog, kpiIntake }));

  return { authService, kpiChangeLog };
};

module.exports = { installAuth };
