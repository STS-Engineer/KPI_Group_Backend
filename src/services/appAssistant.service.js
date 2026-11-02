// The AI Assistant of the React app (chat button on every page).
//
// One chat turn: the system prompt (services/appAssistantKnowledge.js: the
// boards, the KPI rules, who is asking and from which page), the recent
// messages, then OpenAI streaming with function calling -- the model reads live
// data through services/appAssistantTools.service.js (scoped by the account),
// for up to MAX_TOOL_ROUNDS rounds, and the answer streams back as it comes.
//
// Signed-in users keep their conversations (kpi_app_assistant_conversation,
// one row per conversation, deleted with the account). Visitors without a
// session send their recent messages with each question; nothing is stored.

const { createHttpError } = require("../utils/httpError");
const { buildSystemPrompt, splitFollowUps } = require("./appAssistantKnowledge");

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_MESSAGE_LENGTH = 4000;
const HISTORY_FOR_MODEL = 12;
const STORED_MESSAGES = 80;
const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_RESULT_CHARS = 16000;
const MAX_CONVERSATIONS_LISTED = 50;

const SCHEMA_STATEMENTS = [
  `
  CREATE TABLE IF NOT EXISTS public.kpi_app_assistant_conversation (
    conversation_id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES public.kpi_app_user(user_id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL DEFAULT '',
    messages JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `CREATE INDEX IF NOT EXISTS kpi_app_assistant_conversation_user_idx ON public.kpi_app_assistant_conversation (user_id)`
];

const normalizeMessage = (value) => {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) throw createHttpError(400, "Type a question first.");
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw createHttpError(400, `Questions are limited to ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return text;
};

const sanitizeSuggestions = (suggestions) =>
  (Array.isArray(suggestions) ? suggestions : [])
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => entry.trim().slice(0, 160))
    .slice(0, 3);

// The recent messages a visitor without a session sends back with each question.
const sanitizeHistory = (history) =>
  (Array.isArray(history) ? history : [])
    .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant"))
    .map((entry) => ({
      role: entry.role,
      content: String(entry.content ?? "").slice(0, MAX_MESSAGE_LENGTH).trim(),
      suggestions: entry.role === "assistant" ? sanitizeSuggestions(entry.suggestions) : []
    }))
    .filter((entry) => entry.content)
    .slice(-HISTORY_FOR_MODEL);

// An earlier message as the model wrote it: the answers get their follow-up
// line back, so the model keeps writing one.
const toModelMessage = (entry) => ({
  role: entry.role,
  content:
    entry.role === "assistant" && entry.suggestions?.length
      ? `${entry.content}\n\nFOLLOW_UPS: ${entry.suggestions.join(" | ")}`
      : String(entry.content)
});

const sanitizePage = (page) => ({
  path: String(page?.path ?? "").slice(0, 200),
  hash: String(page?.hash ?? "").slice(0, 60)
});

const parseConversationId = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw createHttpError(400, "Invalid conversation.");
  return parsed;
};

const buildTitle = (text) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77).trimEnd()}...` : line;
};

const toIso = (value) => (value ? new Date(value).toISOString() : null);

const truncateToolResult = (value) => {
  const json = JSON.stringify(value ?? null);
  return json.length > MAX_TOOL_RESULT_CHARS
    ? `${json.slice(0, MAX_TOOL_RESULT_CHARS)}... [truncated: ask for a narrower selection]`
    : json;
};

// Reasoning models only take the default temperature.
const supportsTemperature = (model) => !/^(o\d|gpt-5)/i.test(model);

const isAbortError = (error, signal) =>
  Boolean(signal?.aborted) || error?.name === "AbortError" || error?.name === "APIUserAbortError";

// What the user reads when OpenAI fails.
const describeOpenAIError = (error) => {
  if (/api key is not configured/i.test(error?.message || "")) {
    return createHttpError(503, "The AI Assistant is not configured on this server yet (OpenAI key missing).");
  }
  if (error?.status === 429) return createHttpError(503, "The AI service is busy right now. Try again in a minute.");
  if (error?.status === 401 || error?.status === 403) {
    return createHttpError(503, "The AI service rejected the server's credentials. Tell an administrator.");
  }
  return null;
};

const createAppAssistant = ({ db, tools, getOpenAIClient, model = DEFAULT_MODEL, now = () => new Date(), logger = console }) => {
  const chatModel = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  let schemaPromise = null;

  const ensureSchema = () => {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        for (const statement of SCHEMA_STATEMENTS) await db.query(statement);
      })().catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  };

  const loadOwnedConversation = async (viewer, conversationId) => {
    await ensureSchema();
    const result = await db.query(
      `
      SELECT conversation_id, title, messages, created_at, updated_at
      FROM public.kpi_app_assistant_conversation
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, viewer.user_id]
    );
    const row = result.rows[0];
    if (!row) {
      const error = createHttpError(404, "This conversation no longer exists.");
      error.code = "CONVERSATION_NOT_FOUND";
      throw error;
    }
    return { ...row, messages: Array.isArray(row.messages) ? row.messages : [] };
  };

  const listConversations = async (viewer) => {
    await ensureSchema();
    const result = await db.query(
      `
      SELECT conversation_id, title, created_at, updated_at
      FROM public.kpi_app_assistant_conversation
      WHERE user_id = $1
      ORDER BY updated_at DESC, conversation_id DESC
      LIMIT ${MAX_CONVERSATIONS_LISTED}
      `,
      [viewer.user_id]
    );
    return result.rows.map((row) => ({
      conversation_id: row.conversation_id,
      title: row.title,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at)
    }));
  };

  const getConversation = async (viewer, conversationId) => {
    const row = await loadOwnedConversation(viewer, parseConversationId(conversationId));
    return {
      conversation_id: row.conversation_id,
      title: row.title,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
      messages: row.messages
    };
  };

  const deleteConversation = async (viewer, conversationId) => {
    await ensureSchema();
    const result = await db.query(
      `DELETE FROM public.kpi_app_assistant_conversation WHERE conversation_id = $1 AND user_id = $2 RETURNING conversation_id`,
      [parseConversationId(conversationId), viewer.user_id]
    );
    if (!result.rows.length) throw createHttpError(404, "This conversation no longer exists.");
  };

  const saveTurn = async (viewer, conversation, entries) => {
    await ensureSchema();
    const messages = [...(conversation?.messages || []), ...entries].slice(-STORED_MESSAGES);
    if (conversation) {
      await db.query(
        `
        UPDATE public.kpi_app_assistant_conversation
        SET messages = $3::jsonb, updated_at = $4
        WHERE conversation_id = $1 AND user_id = $2
        `,
        [conversation.conversation_id, viewer.user_id, JSON.stringify(messages), now()]
      );
      return conversation.conversation_id;
    }
    const inserted = await db.query(
      `
      INSERT INTO public.kpi_app_assistant_conversation (user_id, title, messages, created_at, updated_at)
      VALUES ($1, $2, $3::jsonb, $4, $4)
      RETURNING conversation_id
      `,
      [viewer.user_id, buildTitle(entries[0].content), JSON.stringify(messages), now()]
    );
    return inserted.rows[0].conversation_id;
  };

  // One streamed model call. Text goes to onText as it comes; tool calls are
  // put back together from their fragments.
  const streamCompletion = async (openai, { messages, toolDefinitions, onText, signal }) => {
    const body = { model: chatModel, messages, stream: true };
    if (supportsTemperature(chatModel)) body.temperature = 0.2;
    if (toolDefinitions.length) {
      body.tools = toolDefinitions;
      body.tool_choice = "auto";
    }
    const stream = await openai.chat.completions.create(body, { signal });
    const calls = [];
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) onText(delta.content);
      for (const fragment of delta.tool_calls || []) {
        const index = Number.isInteger(fragment.index) ? fragment.index : calls.length;
        const call = calls[index] || (calls[index] = { id: "", name: "", arguments: "" });
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
      }
    }
    return { toolCalls: calls.filter((call) => call && call.name) };
  };

  const runTool = async (call, viewer, emit) => {
    const label = tools.labelOf(call.name);
    emit("tool", { id: call.id, name: call.name, label, status: "running" });
    let output;
    try {
      output = await tools.execute(call.name, call.arguments, { viewer });
    } catch (error) {
      logger.error(`[AI Assistant] Tool ${call.name} failed:`, error.message);
      output = { error: "This data could not be read right now." };
    }
    emit("tool", { id: call.id, name: call.name, label, status: output?.error ? "error" : "done" });
    return { role: "tool", tool_call_id: call.id, content: truncateToolResult(output) };
  };

  // One question. viewer: the signed-in account, or null.
  const chat = async ({ viewer = null, conversationId = null, message, history = [], page = {}, emit = () => {}, signal } = {}) => {
    const text = normalizeMessage(message);
    const conversation = viewer && parseConversationId(conversationId)
      ? await loadOwnedConversation(viewer, parseConversationId(conversationId))
      : null;
    const previous = (viewer ? sanitizeHistory(conversation?.messages) : sanitizeHistory(history)).map(toModelMessage);

    let scope = null;
    if (viewer) {
      scope = await tools.describeScope(viewer).catch((error) => {
        logger.error("[AI Assistant] Scope lookup failed:", error.message);
        return null;
      });
    }

    const messages = [
      { role: "system", content: buildSystemPrompt({ viewer, scope, page: sanitizePage(page), now: now() }) },
      ...previous,
      { role: "user", content: text }
    ];
    const toolDefinitions = tools.definitionsFor(viewer);

    let openai;
    try {
      openai = getOpenAIClient();
    } catch (error) {
      throw describeOpenAIError(error) || error;
    }

    let answer = "";
    // The text of the current round, kept apart so Stop keeps what was written.
    let roundText = "";
    const closeRound = () => {
      const content = roundText;
      if (content) answer += (answer && !answer.endsWith("\n") ? "\n\n" : "") + content;
      roundText = "";
      return content;
    };
    const toolsUsed = [];
    let stopped = false;
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        // The last round has no tools, so the model has to answer.
        const { toolCalls } = await streamCompletion(openai, {
          messages,
          toolDefinitions: round < MAX_TOOL_ROUNDS ? toolDefinitions : [],
          onText: (text) => {
            roundText += text;
            emit("delta", { delta: text });
          },
          signal
        });
        const content = closeRound();
        if (!toolCalls.length) break;

        messages.push({
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments || "{}" }
          }))
        });
        messages.push(...(await Promise.all(toolCalls.map((call) => runTool(call, viewer, emit)))));
        toolCalls.forEach((call) => {
          if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
        });
      }
    } catch (error) {
      if (!isAbortError(error, signal)) throw describeOpenAIError(error) || error;
      closeRound();
      stopped = true;
    }

    const { answer: shown, suggestions } = splitFollowUps(answer);
    let savedConversationId = conversation?.conversation_id ?? null;
    if (viewer && (shown || !stopped)) {
      const timestamp = now().toISOString();
      savedConversationId = await saveTurn(viewer, conversation, [
        { role: "user", content: text, ts: timestamp },
        {
          role: "assistant",
          content: shown || "(no answer)",
          ts: timestamp,
          ...(toolsUsed.length ? { tools: toolsUsed } : {}),
          ...(suggestions.length ? { suggestions } : {}),
          ...(stopped ? { stopped: true } : {})
        }
      ]);
    }

    return {
      conversation_id: savedConversationId,
      answer: shown,
      suggestions,
      tools_used: toolsUsed,
      stopped
    };
  };

  return { ensureSchema, chat, listConversations, getConversation, deleteConversation, model: chatModel };
};

module.exports = { createAppAssistant, sanitizeHistory, normalizeMessage, MAX_MESSAGE_LENGTH };
