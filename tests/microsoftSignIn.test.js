// "Continue with Microsoft": real Express app + HTTP requests, in-memory
// PostgreSQL (pg-mem), with stand-ins for Microsoft Entra ID (no network) and
// for the role assignments of public.people.

const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const express = require("express");
const bodyParser = require("body-parser");
const { newDb } = require("pg-mem");
const { loadAuthConfig } = require("../src/config/auth");
const { installAuth } = require("../src/installAuth");
const model = require("../src/models/auth.model");
const { hashPassword } = require("../src/utils/password");

const APP_ORIGIN = "http://localhost:5173";
const ADMIN_EMAIL = "admin@avocarbon.com";
const ADMIN_PASSWORD = "Admin-Password-2026";

let server;
let baseUrl;
let pool;
const sentMails = [];

// ---- stand-ins -------------------------------------------------------------

// Microsoft: startSignIn() hands out numbered transactions; a code is valid
// once registered with the verifier of its transaction (as Entra ID checks PKCE).
const fakeMicrosoft = {
  enabled: true,
  count: 0,
  last: null,
  codes: new Map(),
  async startSignIn() {
    this.count += 1;
    this.last = { state: `state-${this.count}`, verifier: `verifier-${this.count}`, nonce: `nonce-${this.count}` };
    return { url: `https://login.example.test/authorize?state=${this.last.state}`, transaction: this.last };
  },
  async completeSignIn({ code, verifier }) {
    const entry = this.codes.get(code);
    if (!entry || entry.verifier !== verifier) throw new Error("AADSTS54005: the code was already redeemed or is invalid");
    this.codes.delete(code);
    return entry.claims;
  }
};

// public.people as the directory sees it: active flag and assignment role.
const directoryPeople = new Map(); // people_id -> { people_id, first_name, name, email, active, orgRole }
const peopleDirectory = {
  async findPersonByEmail(email) {
    return [...directoryPeople.values()].find((person) => person.email.toLowerCase() === email) || null;
  },
  async getPerson(peopleId) {
    return directoryPeople.get(Number(peopleId)) || null;
  },
  async getOrgRoles(peopleIds) {
    return new Map(
      peopleIds.map(Number).filter((id) => directoryPeople.get(id)?.orgRole).map((id) => [id, directoryPeople.get(id).orgRole])
    );
  },
  async getOrgRole(peopleId) {
    return directoryPeople.get(Number(peopleId))?.orgRole || { role: "user", label: null };
  }
};

let personCount = 0;
const addPerson = async ({ email, firstName = "Test", name = `PERSON${(personCount += 1)}`, active = true, orgRole = null }) => {
  const inserted = await pool.query(
    "INSERT INTO public.people (name, first_name, email) VALUES ($1, $2, $3) RETURNING people_id",
    [name, firstName, email]
  );
  const peopleId = inserted.rows[0].people_id;
  directoryPeople.set(peopleId, { people_id: peopleId, first_name: firstName, name, email, active, orgRole });
  return peopleId;
};

let oidCount = 0;
const microsoftAccount = (email, extra = {}) => ({
  oid: `oid-${(oidCount += 1)}`,
  tid: "tenant-test",
  name: "Test Person",
  preferred_username: email,
  ...extra
});

// ---- browser ---------------------------------------------------------------

// Keeps cookies between requests; never follows redirects (Microsoft is not reachable).
class Browser {
  constructor() {
    this.cookies = {};
  }

  async request(method, path, { body } = {}) {
    const cookieHeader = Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      redirect: "manual",
      headers: {
        Origin: APP_ORIGIN,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const setCookies = response.headers.getSetCookie();
    for (const setCookie of setCookies) {
      const [pair] = setCookie.split(";");
      const [name, ...rest] = pair.split("=");
      const value = rest.join("=");
      if (/Max-Age=0/i.test(setCookie) || !value) delete this.cookies[name.trim()];
      else this.cookies[name.trim()] = value;
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text, setCookies, headers: response.headers };
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, body) {
    return this.request("POST", path, { body: body ?? {} });
  }

  put(path, body) {
    return this.request("PUT", path, { body: body ?? {} });
  }
}

// The result the callback page posts to the sign-in page (and its fallback URL).
const readResult = (html) => {
  const message = /var message = (\{.*?\});/.exec(html);
  assert.ok(message, "the callback page carries the result");
  const fallback = /window\.location\.replace\((".*?")\)/.exec(html);
  return { ...JSON.parse(message[1]), fallback: fallback ? JSON.parse(fallback[1]) : null };
};

// The whole round trip: /login, Microsoft (simulated), /callback.
const signInWithMicrosoft = async (browser, claims, { next = "", origin = APP_ORIGIN } = {}) => {
  const query = new URLSearchParams({ origin, ...(next ? { next } : {}) });
  const start = await browser.get(`/api/auth/microsoft/login?${query}`);
  assert.equal(start.status, 302, start.text);
  const { state, verifier } = fakeMicrosoft.last;
  const code = `code-${state}`;
  fakeMicrosoft.codes.set(code, { verifier, claims });
  const callback = await browser.get(`/api/auth/microsoft/callback?code=${code}&state=${state}`);
  assert.equal(callback.status, 200);
  return { start, callback, result: readResult(callback.text) };
};

const loggedInAs = async (email, password) => {
  const browser = new Browser();
  const res = await browser.post("/api/auth/login", { email, password });
  assert.equal(res.status, 200, res.text);
  return browser;
};

const findAccount = async (admin, email) => {
  const res = await admin.get("/api/admin/users");
  assert.equal(res.status, 200, res.text);
  return res.json.users.find((user) => user.email === email) || null;
};

const lastEvent = async (admin, eventType) => {
  const res = await admin.get(`/api/admin/auth-events?event_type=${eventType}&limit=1`);
  return res.json.events[0];
};

before(async () => {
  const memoryDb = newDb({ noAstCoverageCheck: true });
  const { Pool } = memoryDb.adapters.createPg();
  pool = new Pool();
  await pool.query(`
    CREATE TABLE public.people (
      people_id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      first_name VARCHAR(100),
      email VARCHAR(255)
    )
  `);

  const config = loadAuthConfig({
    FRONTEND_URL: APP_ORIGIN,
    NODE_ENV: "test",
    AUTH_LOGIN_RATE_LIMIT_PER_IP: "10000",
    AUTH_FORGOT_PASSWORD_RATE_LIMIT_PER_IP: "10000",
    AUTH_TOKEN_RATE_LIMIT_PER_IP: "10000"
  });
  const app = express();
  app.use(bodyParser.json());
  const { authService } = installAuth(app, {
    db: pool,
    config,
    logger: { error: () => {}, log: () => {}, warn: () => {} },
    sendMail: async (message) => {
      sentMails.push(message);
    },
    microsoftAuth: fakeMicrosoft,
    peopleDirectory
  });
  app.get("/api/responsibles/:id/kpi-objects", (req, res) => res.json({ ok: true, email: req.auth?.user?.email || null }));

  await authService.ensureSchema();
  await model.insertUser(pool, {
    email: ADMIN_EMAIL,
    fullName: "First Admin",
    peopleId: null,
    role: "admin",
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    mustChangePassword: false,
    createdByUserId: null,
    now: new Date()
  });

  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ---- tests -----------------------------------------------------------------

test("the sign-in page learns that Microsoft is available", async () => {
  const res = await new Browser().get("/api/auth/providers");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { microsoft: true });
});

test("/login keeps the sign-in in a short-lived HttpOnly cookie and redirects to Microsoft", async () => {
  const browser = new Browser();
  const res = await browser.get(`/api/auth/microsoft/login?origin=${encodeURIComponent(APP_ORIGIN)}&next=/kpi-intake`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `https://login.example.test/authorize?state=${fakeMicrosoft.last.state}`);
  const cookie = res.setCookies.find((value) => value.startsWith("kpi_ms_signin="));
  assert.ok(cookie, "transaction cookie set");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api\/auth\/microsoft/);
  assert.match(cookie, /Max-Age=600/);
});

test("a callback without its cookie or with another state is refused", async () => {
  const stranger = await new Browser().get("/api/auth/microsoft/callback?code=x&state=state-1");
  assert.equal(readResult(stranger.text).error, "expired");
  assert.ok(!stranger.setCookies.some((value) => value.startsWith("kpi_session=")), "no session");

  const browser = new Browser();
  await browser.get(`/api/auth/microsoft/login?origin=${encodeURIComponent(APP_ORIGIN)}`);
  const forged = await browser.get("/api/auth/microsoft/callback?code=x&state=not-the-state");
  assert.equal(readResult(forged.text).error, "expired");
  assert.equal((await browser.get("/api/auth/me")).json.user, null);
});

test("cancelling at Microsoft and Microsoft errors come back with their reason", async () => {
  const browser = new Browser();
  await browser.get(`/api/auth/microsoft/login?origin=${encodeURIComponent(APP_ORIGIN)}`);
  const cancelled = await browser.get(
    `/api/auth/microsoft/callback?error=access_denied&error_description=AADSTS65004%3A+User+declined&state=${fakeMicrosoft.last.state}`
  );
  assert.deepEqual(
    { error: readResult(cancelled.text).error, detail: readResult(cancelled.text).detail },
    { error: "cancelled", detail: "AADSTS65004" }
  );
});

test("the result page posts only to the app's origin and never returns to another site", async () => {
  const email = "nobody@avocarbon.com";
  const { result, callback } = await signInWithMicrosoft(new Browser(), microsoftAccount(email), {
    origin: "https://evil.example.com",
    next: "//evil.example.com/x"
  });
  assert.equal(result.error, "no_account");
  assert.ok(callback.text.includes(`var origin = "${APP_ORIGIN}";`), "posts to the allowed origin only");
  assert.equal(result.fallback, `${APP_ORIGIN}/login?microsoft_error=no_account`);
  assert.match(callback.headers.get("content-security-policy"), /script-src 'nonce-/);
});

test("an account created by an administrator signs in with Microsoft and gets linked", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "invited.user@avocarbon.com";
  await addPerson({ email, firstName: "Invited", name: "USER" });
  const created = await admin.post("/api/admin/users", { email, role: "user" });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.user.status, "invited");

  const browser = new Browser();
  const { result } = await signInWithMicrosoft(browser, microsoftAccount(email), { next: "/kpi-intake" });
  assert.equal(result.ok, true);
  assert.equal(result.fallback, `${APP_ORIGIN}/login?next=%2Fkpi-intake`);
  const me = await browser.get("/api/auth/me");
  assert.equal(me.json.user.email, email);

  const account = await findAccount(admin, email);
  assert.equal(account.has_microsoft, true);
  assert.equal(account.has_password, false);
  assert.equal(account.status, "active", "a Microsoft account is not an invitation");
  assert.equal(account.created_via, "admin");
  assert.equal(account.last_login_method, "microsoft");
  assert.equal((await lastEvent(admin, "login.success")).details.method, "microsoft");
  assert.equal((await lastEvent(admin, "user.microsoft_linked")).email, email);
});

test("the e-mail is matched whatever claim Microsoft puts it in, and the link then wins over the e-mail", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "claims.user@avocarbon.com";
  await addPerson({ email });
  await admin.post("/api/admin/users", { email, role: "user" });

  const claims = microsoftAccount("upn-differs@avocarbon.onmicrosoft.com", { email: "Claims.User@avocarbon.com" });
  assert.equal((await signInWithMicrosoft(new Browser(), claims)).result.ok, true);

  // Same Microsoft account, e-mail no longer in the token: found by its link.
  const again = await signInWithMicrosoft(new Browser(), { ...claims, email: undefined, preferred_username: "renamed@avocarbon.com" });
  assert.equal(again.result.ok, true);
});

test("a temporary password is dropped at the first Microsoft sign-in", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "temporary.user@avocarbon.com";
  await addPerson({ email });
  const created = await admin.post("/api/admin/users", { email, role: "user", temporary_password: "Temporary-Pass-2026" });
  assert.equal(created.json.user.status, "password_change_required");

  const browser = new Browser();
  assert.equal((await signInWithMicrosoft(browser, microsoftAccount(email))).result.ok, true);
  assert.equal((await browser.get("/api/auth/me")).json.user.must_change_password, false);

  const account = await findAccount(admin, email);
  assert.equal(account.has_password, false);
  assert.equal(account.status, "active");
  const passwordLogin = await new Browser().post("/api/auth/login", { email, password: "Temporary-Pass-2026" });
  assert.equal(passwordLogin.status, 401, "the temporary password no longer works");
  assert.equal((await lastEvent(admin, "password.temporary_removed")).email, email);
});

test("a person with an allowed role gets an account at their first Microsoft sign-in", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "zone.manager@avocarbon.com";
  const peopleId = await addPerson({
    email,
    firstName: "Zoe",
    name: "MANAGER",
    orgRole: { role: "zone_manager", label: "Zone managers" }
  });

  const browser = new Browser();
  const claims = microsoftAccount(email);
  const { result } = await signInWithMicrosoft(browser, claims);
  assert.equal(result.ok, true);
  const me = (await browser.get("/api/auth/me")).json.user;
  assert.equal(me.people_id, peopleId);
  assert.equal(me.role, "zone_manager");
  assert.equal(me.full_name, "Zoe MANAGER");
  const dashboard = await browser.get(`/api/responsibles/${peopleId}/kpi-objects`);
  assert.equal(dashboard.status, 200, "opens their own dashboard");

  const account = await findAccount(admin, email);
  assert.equal(account.created_via, "microsoft");
  assert.equal(account.has_password, false);
  assert.equal(account.has_microsoft, true);
  assert.deepEqual(account.org_role, { role: "zone_manager", label: "Zone managers" });
  const createdEvent = await lastEvent(admin, "user.created");
  assert.equal(createdEvent.details.mode, "microsoft");
  assert.equal(createdEvent.actor_user_id, null);

  // Signing in again uses the same account.
  assert.equal((await signInWithMicrosoft(new Browser(), claims)).result.ok, true);
  const users = (await admin.get("/api/admin/users")).json.users.filter((user) => user.email === email);
  assert.equal(users.length, 1);

  // A token without its account id or e-mail is refused.
  assert.equal((await signInWithMicrosoft(new Browser(), { ...claims, oid: undefined })).result.error, "microsoft_incomplete");
});

test("a role outside the list gets no account; the administrator can open it to that role", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "kam@avocarbon.com";
  await addPerson({ email, orgRole: { role: "user", label: "KAM" } });

  const refused = await signInWithMicrosoft(new Browser(), microsoftAccount(email));
  assert.deepEqual({ error: refused.result.error, detail: refused.result.detail }, { error: "role_not_allowed", detail: "KAM" });
  assert.equal(await findAccount(admin, email), null, "no account created");
  const failure = await lastEvent(admin, "login.failure");
  assert.equal(failure.details.reason, "role_not_allowed");
  assert.equal(failure.details.org_role_label, "KAM");

  const settings = await admin.get("/api/admin/settings/microsoft-sign-in");
  assert.deepEqual(settings.json.settings.auto_create_roles, ["ceo", "vp", "zone_manager", "plant_manager"]);
  assert.equal(settings.json.settings.enabled, false, "AZURE_* not set in this test config");

  const invalid = await admin.put("/api/admin/settings/microsoft-sign-in", { auto_create_roles: ["admin"] });
  assert.equal(invalid.status, 400, "admin is never given automatically");
  const saved = await admin.put("/api/admin/settings/microsoft-sign-in", {
    auto_create_roles: ["user", "vp", "ceo", "zone_manager", "plant_manager"]
  });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.settings.auto_create_roles, ["ceo", "vp", "zone_manager", "plant_manager", "user"]);
  assert.equal(saved.json.settings.updated_by.email, ADMIN_EMAIL);
  assert.equal((await lastEvent(admin, "settings.updated")).details.setting, "microsoft_sign_in");

  const allowed = await signInWithMicrosoft(new Browser(), microsoftAccount(email));
  assert.equal(allowed.result.ok, true);
  assert.equal((await findAccount(admin, email)).role, "user");

  await admin.put("/api/admin/settings/microsoft-sign-in", { auto_create_roles: ["ceo", "vp", "zone_manager", "plant_manager"] });
});

test("only administrators read or change the Microsoft settings", async () => {
  const anonymous = await new Browser().get("/api/admin/settings/microsoft-sign-in");
  assert.equal(anonymous.status, 401);
  const email = "plant.manager@avocarbon.com";
  await addPerson({ email, orgRole: { role: "plant_manager", label: "Plant manager" } });
  const manager = new Browser();
  assert.equal((await signInWithMicrosoft(manager, microsoftAccount(email))).result.ok, true);
  const asManager = await manager.put("/api/admin/settings/microsoft-sign-in", { auto_create_roles: ["user"] });
  assert.equal(asManager.status, 403);
});

test("no person, an inactive person or a disabled account: no sign-in", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal((await signInWithMicrosoft(new Browser(), microsoftAccount("stranger@avocarbon.com"))).result.error, "no_account");

  const leaverEmail = "leaver@avocarbon.com";
  await addPerson({ email: leaverEmail, active: false, orgRole: { role: "vp", label: "VP Finance" } });
  assert.equal((await signInWithMicrosoft(new Browser(), microsoftAccount(leaverEmail))).result.error, "person_inactive");
  assert.equal(await findAccount(admin, leaverEmail), null);

  const disabledEmail = "disabled.user@avocarbon.com";
  await addPerson({ email: disabledEmail });
  const created = await admin.post("/api/admin/users", { email: disabledEmail, role: "user" });
  await admin.request("PATCH", `/api/admin/users/${created.json.user.user_id}`, { body: { is_active: false } });
  assert.equal((await signInWithMicrosoft(new Browser(), microsoftAccount(disabledEmail))).result.error, "disabled");
});

test("an account linked to another Microsoft account is refused until an administrator unlinks it", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "replaced.account@avocarbon.com";
  await addPerson({ email });
  const created = await admin.post("/api/admin/users", { email, role: "user" });
  assert.equal((await signInWithMicrosoft(new Browser(), microsoftAccount(email))).result.ok, true);

  const replacement = microsoftAccount(email);
  assert.equal((await signInWithMicrosoft(new Browser(), replacement)).result.error, "linked_to_other_microsoft_account");

  const unlinked = await admin.post(`/api/admin/users/${created.json.user.user_id}/unlink-microsoft`);
  assert.equal(unlinked.status, 200, unlinked.text);
  assert.equal(unlinked.json.user.has_microsoft, false);
  assert.equal(unlinked.json.user.status, "invited", "no password, no Microsoft account any more");
  assert.equal((await signInWithMicrosoft(new Browser(), replacement)).result.ok, true);
});

test("a Microsoft account can still get a password: the admin link is a reset link", async () => {
  const admin = await loggedInAs(ADMIN_EMAIL, ADMIN_PASSWORD);
  const email = "zone.manager@avocarbon.com";
  const account = await findAccount(admin, email);
  const res = await admin.post(`/api/admin/users/${account.user_id}/password-link`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.purpose, "reset");
});

test("without the AZURE_* settings the Microsoft button is hidden and the routes say so", async () => {
  const app = express();
  const config = loadAuthConfig({ FRONTEND_URL: APP_ORIGIN, NODE_ENV: "test" });
  assert.equal(config.microsoft.enabled, false);
  installAuth(app, { db: pool, config, logger: { error: () => {}, log: () => {}, warn: () => {} }, sendMail: async () => {} });
  const other = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const url = `http://127.0.0.1:${other.address().port}`;
    assert.deepEqual(await (await fetch(`${url}/api/auth/providers`)).json(), { microsoft: false });
    const login = await fetch(`${url}/api/auth/microsoft/login`, { redirect: "manual" });
    assert.equal(readResult(await login.text()).error, "not_configured");
  } finally {
    await new Promise((resolve) => other.close(resolve));
  }
});
