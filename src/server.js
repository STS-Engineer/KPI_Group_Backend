require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const cron = require("node-cron");

const { pool } = require("./config/db");
const { getOpenAIClient } = require("./config/openai");
const { createTransporter } = require("./config/mailer");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("./utils/normalize");
const { createHttpError } = require("./utils/httpError");
const { upsertPrimarySubjectKpiLink } = require("./models/kpi.model");

const kpisRoutes = require("./routes/kpis.routes");
const responsiblesRoutes = require("./routes/responsibles.routes");
const correctiveActionsRoutes = require("./routes/correctiveActions.routes");
const trainingRoutes = require("./routes/training.routes");
const statisticsRoutes = require("./routes/statistics.routes");
const unitsRoutes = require("./routes/units.routes");
const monitoringRoutes = require("./routes/monitoring.routes");
const ceoReportRoutes = require("./routes/ceoReport.routes");
const miscRoutes = require("./routes/misc.routes");
const targetAdjustmentsRoutes = require("./routes/targetAdjustments.routes");
const {
  ensureKpiRatioSchema,
  refreshKpiKnowledgeBaseForKpiId,
  refreshKpiKnowledgeBases
} = require("./services/kpiKnowledgeBase.service");
const { registerRecommendationRoutes } = require("./services/kpiRecommendations.service");
const { registerAIGeneratedKpiRoutes } = require("./services/kpiDerivedGenerator.service");
const { ensureKpiTrainingEscalationSchema } = require("./services/kpiTraining.service");
const { loadAuthConfig } = require("./config/auth");
const { installAuth } = require("./installAuth");
const { createKpiIntakeService } = require("./services/kpiIntake.service");
const { createKpiIntakeRouter } = require("./routes/kpiIntake.routes");
const { createKpiAnalyticsScope } = require("./services/kpiAnalyticsScope.service");
const { createAppAssistant } = require("./services/appAssistant.service");
const { createAppAssistantTools } = require("./services/appAssistantTools.service");
const { createAppAssistantRouter } = require("./routes/appAssistant.routes");
const { loadActionPlanCorrectiveActionMaps } = require("./services/actionPlan.service");
const { loadKpiTrainingPortalRows, buildTrainingPortalAssignment } = require("./services/kpiTraining.service");
const {
  loadKpiKnowledgeBaseForAssistant,
  buildStoredKpiKnowledgeBaseContext
} = require("./services/kpiAssistant.service");
const {
  normalizeCorrectiveActionStatus,
  CLOSED_CORRECTIVE_ACTION_STATUS
} = require("./services/kpiShared.service");

const app = express();

// Serve the Vite production build from the same origin as the API.
// The deployment workflow places frontend/dist under frontend-dist.
const path = require("path");
const fs = require("fs");
const frontendDist = path.join(__dirname, "..", "frontend-dist");
const frontendIndex = path.join(frontendDist, "index.html");

const port = process.env.PORT || 5000;
const authConfig = loadAuthConfig();

// Behind a reverse proxy (Azure App Service), TRUST_PROXY=1 makes req.ip the
// real client address -- used by the login rate limiter and the audit log.
if (process.env.TRUST_PROXY) {
  const trustProxy = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isFinite(trustProxy) ? trustProxy : process.env.TRUST_PROXY === "true");
}

// credentials: the React app sends the session cookie with every API call.
app.use(cors({ origin: authConfig.allowedOrigins, credentials: true }));
app.use(bodyParser.json({ limit: "40mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "40mb" }));

// Authentication first, so the routes of the Responsible KPI Dashboard and of
// the user administration (PROTECTED_ROUTES in middlewares/auth.middleware.js)
// require a session whatever router defines them. Every other route stays public.
let authTransporter = null;
// KPI & Target Intake page: public lines, submitted by an administrator.
const kpiIntake = createKpiIntakeService({ db: pool, refreshKnowledgeBases: refreshKpiKnowledgeBases });
const { authService, kpiChangeLog } = installAuth(app, {
  db: pool,
  config: authConfig,
  kpiIntake,
  sendMail: (message) => {
    if (!authTransporter) authTransporter = createTransporter();
    return authTransporter.sendMail(message);
  }
});

app.use(kpisRoutes);
app.use(responsiblesRoutes);
app.use(correctiveActionsRoutes);
app.use(trainingRoutes);
app.use(statisticsRoutes);
app.use(unitsRoutes);
app.use(monitoringRoutes);
app.use(ceoReportRoutes);
app.use(miscRoutes);
app.use(targetAdjustmentsRoutes);
app.use(createKpiIntakeRouter({ kpiIntake }));

// AI Assistant (chat button of the React app): reads live KPI data through
// scoped, read-only tools. KPI_ASSISTANT_MODEL picks the OpenAI model.
const appAssistant = createAppAssistant({
  db: pool,
  getOpenAIClient,
  model: process.env.KPI_ASSISTANT_MODEL,
  tools: createAppAssistantTools({
    db: pool,
    analyticsScope: createKpiAnalyticsScope({ db: pool }),
    loadCorrectiveActions: async (allocationRows) => {
      const { historyByAllocationId } = await loadActionPlanCorrectiveActionMaps(allocationRows);
      return Object.values(historyByAllocationId)
        .flat()
        .map((action) => ({
          id: action.id,
          kpi_target_allocation_id: action.kpi_target_allocation_id,
          period_label: action.period_label,
          root_cause: action.root_cause,
          implemented_solution: action.implemented_solution,
          owner: action.responsible,
          status: action.status,
          is_closed: normalizeCorrectiveActionStatus(action.status) === CLOSED_CORRECTIVE_ACTION_STATUS,
          due_date: action.due_date,
          importance: action.importance,
          urgency: action.urgency,
          created_date: action.created_date,
          closed_date: action.closed_date
        }));
    },
    loadTrainingAssignments: async (peopleId) =>
      (await loadKpiTrainingPortalRows({ peopleId })).map((row) => {
        const assignment = buildTrainingPortalAssignment(row);
        return {
          kpi: assignment.kpi?.name,
          status: assignment.status,
          training_completed: assignment.progress?.training_completed,
          test_available: assignment.progress?.test_available,
          test_completed: assignment.progress?.test_completed,
          score: assignment.score,
          passed: assignment.passed,
          due_date: assignment.due_date,
          escalation_level: assignment.escalation_level,
          next_reminder: assignment.next_reminder_due_at
        };
      }),
    loadKpiKnowledge: async ({ kpiId, question }) => {
      const kpiRow = await loadKpiKnowledgeBaseForAssistant(kpiId);
      if (!kpiRow) return null;
      const context = buildStoredKpiKnowledgeBaseContext({
        knowledgeBase: kpiRow.kpi_knowledge_base,
        message: question || kpiRow.kpi_name || "",
        conversationHistory: [],
        selectedKpiSummary: null,
        selectedKpi: { kpi_id: kpiRow.kpi_id, title: kpiRow.kpi_name, subtitle: kpiRow.kpi_sub_title }
      });
      return { kpi_id: kpiRow.kpi_id, kpi: kpiRow.kpi_name, ...context };
    }
  })
});
app.use(createAppAssistantRouter({ appAssistant }));

registerRecommendationRoutes(app, pool, createTransporter);
registerAIGeneratedKpiRoutes(app, {
  pool,
  ensureKpiRatioSchema,
  refreshKpiKnowledgeBaseForKpiId,
  upsertPrimarySubjectKpiLink,
  getOpenAIClient,
  cronScheduler: cron,
  normalizeOptionalIntegerInput,
  normalizeOptionalTextInput,
  createHttpError
});

ensureKpiRatioSchema()
  .then(() => {
    console.log("[KPI Knowledge Base] Sync infrastructure is ready.");
  })
  .catch((error) => {
    console.error("[KPI Knowledge Base] Sync infrastructure setup failed:", error.message);
  });

authService
  .ensureSchema()
  .then(() => {
    console.log("[Auth] User and session tables are ready.");
    // Its conversations belong to the accounts (kpi_app_user).
    return appAssistant.ensureSchema().then(() => {
      console.log("[AI Assistant] Conversation table is ready.");
    });
  })
  .catch((error) => {
    console.error("[Auth / AI Assistant] Schema setup failed:", error.message);
  });

kpiChangeLog
  .ensureSchema()
  .then(() => {
    console.log("[KPI change log] Table is ready.");
  })
  .catch((error) => {
    console.error("[KPI change log] Schema setup failed:", error.message);
  });

kpiIntake
  .ensureSchema()
  .then(() => {
    console.log("[KPI intake] Table is ready.");
  })
  .catch((error) => {
    console.error("[KPI intake] Schema setup failed:", error.message);
  });

ensureKpiTrainingEscalationSchema()
  .then(() => {
    console.log("[KPI Training Reminder] Escalation tracking table is ready.");
  })
  .catch((error) => {
    console.error("[KPI Training Reminder] Escalation tracking setup failed:", error.message);
  });

// API routes have priority. Never return HTML for unknown /api paths.
if (fs.existsSync(frontendIndex)) {
  app.use(express.static(frontendDist, { index: false }));
  app.get("*", (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/")) return next();
    if (req.method !== "GET") return next();
    return res.sendFile(frontendIndex);
  });
} else {
  console.warn("[Frontend] frontend-dist/index.html missing; API-only mode.");
}

app.listen(port, () => console.log("Server running on port " + port));
