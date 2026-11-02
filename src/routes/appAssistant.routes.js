const express = require("express");
const { RateLimiterMemory } = require("rate-limiter-flexible");

// API of the AI Assistant (services/appAssistant.service.js).
//
// POST /api/assistant/chat is open, like the pages it is shown on: without a
// session the assistant explains the app and the KPI definitions only; with
// one it also reads the user's KPI data, within their scope. The answer is a
// Server-Sent Events stream: `tool` (a data lookup starts / ends), `delta`
// (text), then `done` ({ conversation_id, answer, suggestions }) or `error`.
//
// The saved conversations (GET / DELETE /api/assistant/conversations[/:id])
// are protected routes (middlewares/auth.middleware.js).
//
// Every question costs an OpenAI call, so questions are limited per account,
// and more strictly per IP address without a session.

// The signed-in user, once their password is set (as the protected routes require).
const signedInUser = (req) => (req.auth?.user && !req.auth.user.must_change_password ? req.auth.user : null);

const HEARTBEAT_MS = 15000;

const createAppAssistantRouter = ({
  appAssistant,
  questionsPerUser = 60,
  questionsPerIp = 20,
  windowSeconds = 15 * 60,
  logger = console
}) => {
  const router = express.Router();
  const userLimiter = new RateLimiterMemory({ points: questionsPerUser, duration: windowSeconds });
  const ipLimiter = new RateLimiterMemory({ points: questionsPerIp, duration: windowSeconds });

  router.use("/api/assistant", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  const handle = (label, handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!error.statusCode) logger.error(`${label} error:`, error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "Unexpected error. Please try again.",
        ...(error.code ? { code: error.code } : {})
      });
    }
  };

  router.post("/api/assistant/chat", async (req, res) => {
    const viewer = signedInUser(req);
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "Type a question first." });

    try {
      if (viewer) await userLimiter.consume(`user:${viewer.user_id}`);
      else await ipLimiter.consume(String(req.ip || req.socket?.remoteAddress || "unknown"));
    } catch (rateLimiterRes) {
      if (rateLimiterRes instanceof Error) {
        logger.error("POST /api/assistant/chat rate limiter error:", rateLimiterRes);
        return res.status(500).json({ error: "Unexpected error. Please try again." });
      }
      res.set("Retry-After", String(Math.ceil((rateLimiterRes.msBeforeNext || 60000) / 1000)));
      return res.status(429).json({
        error: viewer
          ? "You have asked a lot of questions in a short time — wait a few minutes and try again."
          : "Too many questions from this network — wait a few minutes, or sign in.",
        code: "RATE_LIMITED"
      });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    // The user closed the panel or pressed Stop: stop the OpenAI stream too.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    const send = (event, payload) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    // Keeps proxies from closing the connection while tools run.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": keep-alive\n\n");
    }, HEARTBEAT_MS);

    try {
      const result = await appAssistant.chat({
        viewer,
        conversationId: viewer ? req.body?.conversation_id : null,
        message,
        history: viewer ? [] : req.body?.history,
        page: req.body?.page,
        emit: send,
        signal: controller.signal
      });
      send("done", result);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (!error.statusCode) logger.error("POST /api/assistant/chat error:", error);
        send("error", {
          error: error.statusCode ? error.message : "The assistant could not answer. Please try again.",
          ...(error.code ? { code: error.code } : {})
        });
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });

  router.get(
    "/api/assistant/conversations",
    handle("GET /api/assistant/conversations", async (req, res) => {
      res.json({ conversations: await appAssistant.listConversations(req.auth.user) });
    })
  );

  router.get(
    "/api/assistant/conversations/:conversationId",
    handle("GET /api/assistant/conversations/:conversationId", async (req, res) => {
      res.json(await appAssistant.getConversation(req.auth.user, req.params.conversationId));
    })
  );

  router.delete(
    "/api/assistant/conversations/:conversationId",
    handle("DELETE /api/assistant/conversations/:conversationId", async (req, res) => {
      await appAssistant.deleteConversation(req.auth.user, req.params.conversationId);
      res.json({ success: true });
    })
  );

  return router;
};

module.exports = { createAppAssistantRouter };
