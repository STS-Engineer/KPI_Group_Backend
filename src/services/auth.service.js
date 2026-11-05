const validator = require("validator");
const model = require("../models/auth.model");
const { createHttpError } = require("../utils/httpError");
const {
  hashPassword,
  verifyPassword,
  getPasswordPolicyErrors,
  formatPasswordPolicyErrors,
  generateToken,
  hashToken
} = require("../utils/password");
const { buildInvitationEmail, buildPasswordResetEmail } = require("./authEmail.templates");
const { createPeopleDirectory } = require("./peopleDirectory.service");
const { getEmailCandidates } = require("./microsoftAuth.service");

const { USER_ROLES } = model;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
const MAX_RESET_REQUESTS_PER_HOUR = 3;

// Sign in with Microsoft: someone without an account gets one at their first
// Microsoft sign-in when the role of their assignments is in this list (set
// from the administration; "admin" is never given automatically).
const MICROSOFT_SETTINGS_KEY = "microsoft_sign_in";
const MICROSOFT_ROLE_CHOICES = ["ceo", "vp", "zone_manager", "plant_manager", "user"];
const DEFAULT_MICROSOFT_AUTO_CREATE_ROLES = ["ceo", "vp", "zone_manager", "plant_manager"];

// code: what the sign-in page tells the user (see the Microsoft callback route).
const createMicrosoftError = (code, message, details = {}) =>
  Object.assign(createHttpError(403, message), { code, details });

const INVALID_CREDENTIALS_MESSAGE = "Incorrect e-mail or password.";
const TOO_MANY_ATTEMPTS_MESSAGE =
  "Too many failed attempts. Try again in a few minutes or reset your password.";
const INVALID_LINK_MESSAGE = "This link is invalid or has expired. Request a new one.";
// Every account except an administrator's signs in to the Responsible KPI
// Dashboard of its person (its id is the people_id), so it needs one.
const needsPerson = (role) => role !== "admin";
const PERSON_REQUIRED_MESSAGE =
  "Choose the person this account belongs to: the user signs in to that person's KPI dashboard.";

const normalizeEmail = (value) => {
  const email = String(value ?? "").trim().toLowerCase();
  return email && email.length <= 255 && validator.isEmail(email) ? email : null;
};

const normalizeName = (value) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 255);

const parseOptionalId = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN;
};

const toIso = (value) => (value ? new Date(value).toISOString() : null);

const getPersonDisplayName = (person) =>
  normalizeName([person?.first_name, person?.name].filter(Boolean).join(" "));

const assertPasswordPolicy = (password, email) => {
  const errors = getPasswordPolicyErrors(password, { email });
  if (errors.length) throw createHttpError(400, formatPasswordPolicyErrors(errors));
};

const getUserStatus = (row, now) => {
  if (!row.is_active) return "disabled";
  if (row.locked_until && new Date(row.locked_until) > now) return "locked";
  // A Microsoft account signs in without a password: not an invitation.
  if (!row.password_hash && !row.microsoft_oid) return "invited";
  if (row.must_change_password) return "password_change_required";
  return "active";
};

// What the logged-in user may see about themselves.
const toSessionUser = (row) => ({
  user_id: row.user_id,
  email: row.email,
  full_name: row.full_name,
  role: row.role,
  people_id: row.people_id,
  must_change_password: Boolean(row.must_change_password),
  last_login_at: toIso(row.last_login_at)
});

// What an administrator sees in the user list (never the password hash).
// orgRole: the role the person's assignments give ({ role, label }), if known.
const toAdminUser = (row, now, orgRole = null) => ({
  ...toSessionUser(row),
  is_active: Boolean(row.is_active),
  status: getUserStatus(row, now),
  has_password: Boolean(row.password_hash),
  has_microsoft: Boolean(row.microsoft_oid),
  microsoft_linked_at: toIso(row.microsoft_linked_at),
  created_via: row.created_via || "admin",
  last_login_method: row.last_login_method || null,
  org_role: orgRole,
  failed_login_count: Number(row.failed_login_count || 0),
  locked_until: toIso(row.locked_until),
  password_changed_at: toIso(row.password_changed_at),
  created_at: toIso(row.created_at),
  updated_at: toIso(row.updated_at),
  active_sessions: Number(row.active_sessions || 0),
  pending_invites: Number(row.pending_invites || 0),
  person: row.people_id
    ? {
        people_id: row.people_id,
        full_name: getPersonDisplayName({ first_name: row.person_first_name, name: row.person_name }),
        email: row.person_email || ""
      }
    : null
});

const createAuthService = ({
  db,
  sendMail,
  config,
  now = () => new Date(),
  logger = console,
  peopleDirectory = createPeopleDirectory({ db })
}) => {
  let schemaPromise = null;
  let dummyHashPromise = null;
  const pendingDeliveries = new Set();

  const ensureSchema = () => {
    if (!schemaPromise) {
      schemaPromise = model.ensureAuthSchema(db).catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  };

  // Verifying against a throwaway hash when the account does not exist keeps
  // the response time of a wrong e-mail and a wrong password the same.
  const getDummyHash = () => {
    if (!dummyHashPromise) dummyHashPromise = hashPassword(generateToken());
    return dummyHashPromise;
  };

  const logEvent = async (eventType, { user = null, actor = null, email = null, meta = {}, details = null } = {}) => {
    try {
      await model.insertAuthEvent(db, {
        eventType,
        userId: user?.user_id || null,
        actorUserId: actor?.user_id || null,
        email: email || user?.email || null,
        ipAddress: meta.ipAddress ? String(meta.ipAddress).slice(0, 64) : null,
        userAgent: meta.userAgent ? String(meta.userAgent).slice(0, 512) : null,
        details,
        now: now()
      });
    } catch (error) {
      logger.error(`[Auth] Failed to record ${eventType} event:`, error.message);
    }
  };

  const createPasswordLink = async (user, purpose) => {
    const currentTime = now();
    const ttlMs = purpose === "invite" ? config.inviteTokenTtlMs : config.resetTokenTtlMs;
    const token = generateToken();

    await model.invalidateUserPasswordTokens(db, user.user_id, currentTime);
    await model.insertPasswordToken(db, {
      userId: user.user_id,
      tokenHash: hashToken(token),
      purpose,
      expiresAt: new Date(currentTime.getTime() + ttlMs),
      now: currentTime
    });

    const query = new URLSearchParams({ token });
    if (purpose === "invite") query.set("mode", "invite");
    return {
      link: `${config.appUrl}/reset-password?${query.toString()}`,
      ttlMs,
      requestedAt: currentTime,
      expiresAt: new Date(currentTime.getTime() + ttlMs)
    };
  };

  // actor: the administrator behind the e-mail (inviter / sender), if any.
  const sendPasswordEmail = async (user, purpose, { link, ttlMs, requestedAt, expiresAt }, actor = null) => {
    const common = {
      fullName: user.full_name,
      email: user.email,
      link,
      ttlMs,
      expiresAt,
      loginUrl: `${config.appUrl}/login`
    };
    const actorInfo = actor?.full_name ? { full_name: actor.full_name, email: actor.email } : null;
    const { subject, text, html, attachments } =
      purpose === "invite"
        ? buildInvitationEmail({ ...common, role: user.role, inviter: actorInfo })
        : buildPasswordResetEmail({ ...common, requestedAt, sentBy: actorInfo });
    await sendMail({ from: config.mailFrom, to: user.email, subject, text, html, attachments });
  };

  // Admin flows wait for the e-mail and report whether it left; if it did not,
  // the administrator gets the link to pass on by another channel.
  const createAndSendPasswordLink = async (user, purpose, actor = null) => {
    const passwordLink = await createPasswordLink(user, purpose);
    const { link } = passwordLink;
    try {
      await sendPasswordEmail(user, purpose, passwordLink, actor);
      return { email_sent: true };
    } catch (error) {
      logger.error(`[Auth] Failed to send the ${purpose} e-mail to ${user.email}:`, error.message);
      return { email_sent: false, manual_link: link, email_error: error.message };
    }
  };

  const requireUser = async (userId) => {
    const parsedId = parseOptionalId(userId);
    if (!parsedId) throw createHttpError(400, "Invalid user id.");
    const user = await model.findUserById(db, parsedId);
    if (!user) throw createHttpError(404, "User not found.");
    return user;
  };

  const resolvePeopleLink = async (peopleIdInput, { exceptUserId = null } = {}) => {
    const peopleId = parseOptionalId(peopleIdInput);
    if (peopleId === null) return { peopleId: null, person: null };
    if (Number.isNaN(peopleId)) throw createHttpError(400, "Invalid person.");

    const person = await model.findPersonById(db, peopleId);
    if (!person) throw createHttpError(400, "The selected person does not exist.");

    const linkedUser = await model.findUserByPeopleId(db, peopleId);
    if (linkedUser && linkedUser.user_id !== exceptUserId) {
      throw createHttpError(409, `This person is already linked to the account ${linkedUser.email}.`);
    }
    return { peopleId, person };
  };

  // The role each linked person's assignments give; null when they cannot be
  // read (the list of accounts still loads without them).
  const loadOrgRoles = async (peopleIds) => {
    try {
      return await peopleDirectory.getOrgRoles(peopleIds.filter(Boolean));
    } catch (error) {
      logger.error("[Auth] Failed to read the role assignments:", error.message);
      return null;
    }
  };

  const orgRoleOf = (orgRoles, peopleId) => {
    if (!orgRoles || !peopleId) return null;
    return orgRoles.get(Number(peopleId)) || { role: "user", label: null };
  };

  const assertKeepsAnActiveAdmin = async (target, { nextRole, nextActive }) => {
    const losesAdmin = target.role === "admin" && target.is_active && (nextRole !== "admin" || !nextActive);
    if (!losesAdmin) return;
    if ((await model.countActiveAdmins(db)) <= 1) {
      throw createHttpError(400, "At least one active administrator is required.");
    }
  };

  // ---- authentication ------------------------------------------------------

  // A new session for a user who proved who they are (method: "password" or
  // "microsoft"); details are added to the login.success event.
  const startSession = async (user, meta, method, details = {}) => {
    const currentTime = now();
    const token = generateToken();
    const expiresAt = new Date(currentTime.getTime() + config.sessionTtlMs);
    await model.insertSession(db, {
      userId: user.user_id,
      tokenHash: hashToken(token),
      expiresAt,
      ipAddress: meta.ipAddress ? String(meta.ipAddress).slice(0, 64) : null,
      userAgent: meta.userAgent ? String(meta.userAgent).slice(0, 512) : null,
      now: currentTime
    });
    await model.registerSuccessfulLogin(db, user.user_id, currentTime, method);
    await logEvent("login.success", { user, meta, details: { method, ...details } });

    return { user: toSessionUser({ ...user, last_login_at: currentTime }), token, expiresAt };
  };

  const login = async ({ email, password }, meta = {}) => {
    await ensureSchema();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !password) {
      throw createHttpError(400, "Enter your e-mail and password.");
    }

    const user = await model.findUserByEmail(db, normalizedEmail);
    const currentTime = now();

    if (user?.locked_until && new Date(user.locked_until) > currentTime) {
      await logEvent("login.blocked", { user, meta, details: { reason: "locked" } });
      throw createHttpError(429, TOO_MANY_ATTEMPTS_MESSAGE);
    }

    const passwordMatches = user?.password_hash
      ? await verifyPassword(password, user.password_hash)
      : (await verifyPassword(password, await getDummyHash()), false);

    if (!passwordMatches) {
      if (user) {
        const failedCount = await model.registerFailedLogin(db, user.user_id, {
          maxFailedLogins: config.maxFailedLogins,
          lockedUntil: new Date(currentTime.getTime() + config.lockoutMs),
          now: currentTime
        });
        if (failedCount >= config.maxFailedLogins) {
          await logEvent("account.locked", { user, meta, details: { failed_login_count: failedCount } });
        }
      }
      await logEvent("login.failure", {
        user,
        email: normalizedEmail,
        meta,
        details: { reason: !user ? "unknown_email" : user.password_hash ? "wrong_password" : "no_password_set" }
      });
      throw createHttpError(401, INVALID_CREDENTIALS_MESSAGE);
    }

    if (!user.is_active) {
      await logEvent("login.failure", { user, meta, details: { reason: "disabled" } });
      throw createHttpError(403, "This account is disabled. Contact an administrator.");
    }

    return startSession(user, meta, "password");
  };

  // ---- sign in with Microsoft ----------------------------------------------

  const readMicrosoftSettings = async () => {
    const row = await model.getSetting(db, MICROSOFT_SETTINGS_KEY);
    const saved = row?.value?.auto_create_roles;
    return {
      auto_create_roles: Array.isArray(saved)
        ? MICROSOFT_ROLE_CHOICES.filter((role) => saved.includes(role))
        : DEFAULT_MICROSOFT_AUTO_CREATE_ROLES,
      updated_at: toIso(row?.updated_at),
      updated_by_user_id: row?.updated_by_user_id || null
    };
  };

  // First Microsoft sign-in of a person without an account: an account linked
  // to the person and to the Microsoft account, with the role of their
  // assignments, and no password.
  const createMicrosoftAccount = async ({ person, orgRole, microsoftOid, claims, matchedEmail }, meta) => {
    const email = normalizeEmail(person.email) || matchedEmail;
    const fullName = getPersonDisplayName(person) || normalizeName(claims.name) || email;
    try {
      const user = await model.insertUser(db, {
        email,
        fullName,
        peopleId: person.people_id,
        role: orgRole.role,
        passwordHash: null,
        mustChangePassword: false,
        createdByUserId: null,
        createdVia: "microsoft",
        microsoftOid,
        now: now()
      });
      await logEvent("user.created", {
        user,
        meta,
        details: { role: orgRole.role, mode: "microsoft", org_role_label: orgRole.label }
      });
      return user;
    } catch (error) {
      // Two first sign-ins at the same time: the other one created it.
      if (error.code !== "23505") throw error;
      const existing = (await model.findUserByMicrosoftOid(db, microsoftOid)) || (await model.findUserByPeopleId(db, person.people_id));
      if (!existing) throw error;
      return existing;
    }
  };

  // claims: the ID token of the Microsoft account (microsoftAuth.completeSignIn).
  // An existing account -- found by its Microsoft link, its e-mail or its
  // person -- signs in whatever its role; someone without one gets an account
  // when the role of their assignments is allowed (settings). A temporary
  // password is dropped: the account no longer has a password anyone knows.
  const signInWithMicrosoft = async ({ claims = {} }, meta = {}) => {
    await ensureSchema();
    const microsoftOid = String(claims.oid || "").trim().slice(0, 64);
    const emails = getEmailCandidates(claims).map(normalizeEmail).filter(Boolean);

    const refuse = async (code, message, { user = null, details = {} } = {}) => {
      await logEvent("login.failure", {
        user,
        email: user?.email || emails[0] || null,
        meta,
        details: { method: "microsoft", reason: code, ...details }
      });
      return createMicrosoftError(code, message, details);
    };

    if (!microsoftOid || !emails.length) {
      throw await refuse("microsoft_incomplete", "Microsoft did not return your account details. Please try again.");
    }

    let user = await model.findUserByMicrosoftOid(db, microsoftOid);
    for (const email of emails) {
      if (user) break;
      user = await model.findUserByEmail(db, email);
    }
    let person = null;
    let matchedEmail = null;
    if (!user) {
      for (const email of emails) {
        person = await peopleDirectory.findPersonByEmail(email);
        if (person) {
          matchedEmail = email;
          break;
        }
      }
      if (person) user = await model.findUserByPeopleId(db, person.people_id);
    }

    let created = false;
    if (user) {
      if (user.microsoft_oid && user.microsoft_oid !== microsoftOid) {
        throw await refuse(
          "linked_to_other_microsoft_account",
          "This KPI Manager account is linked to another Microsoft account. Ask an administrator.",
          { user }
        );
      }
      if (!user.is_active) {
        throw await refuse("disabled", "This account is disabled. Contact an administrator.", { user });
      }
      const linkedPerson = user.people_id ? person || (await peopleDirectory.getPerson(user.people_id)) : null;
      if (linkedPerson && !linkedPerson.active) {
        throw await refuse("person_inactive", "You are no longer listed as an active employee. Contact an administrator.", {
          user
        });
      }

      const currentTime = now();
      if (!user.microsoft_oid) {
        await model.setMicrosoftLink(db, user.user_id, { microsoftOid, now: currentTime });
        await logEvent("user.microsoft_linked", { user, meta });
      }
      if (user.must_change_password) {
        await model.clearUserPassword(db, user.user_id, currentTime);
        await model.invalidateUserPasswordTokens(db, user.user_id, currentTime);
        await logEvent("password.temporary_removed", { user, meta, details: { method: "microsoft" } });
      }
      user = await model.findUserById(db, user.user_id);
    } else {
      if (!person) {
        throw await refuse("no_account", "No KPI Manager account matches your Microsoft account. Ask an administrator.");
      }
      if (!person.active) {
        throw await refuse("person_inactive", "You are no longer listed as an active employee. Contact an administrator.", {
          details: { people_id: person.people_id }
        });
      }
      const orgRole = await peopleDirectory.getOrgRole(person.people_id);
      const { auto_create_roles: allowedRoles } = await readMicrosoftSettings();
      if (!allowedRoles.includes(orgRole.role)) {
        throw await refuse(
          "role_not_allowed",
          "Your role cannot open a KPI Manager account with Microsoft. Ask an administrator for an account.",
          { details: { people_id: person.people_id, org_role: orgRole.role, org_role_label: orgRole.label } }
        );
      }
      user = await createMicrosoftAccount({ person, orgRole, microsoftOid, claims, matchedEmail }, meta);
      created = true;
    }

    return { ...(await startSession(user, meta, "microsoft", created ? { account_created: true } : {})), created };
  };

  const getMicrosoftSettings = async () => {
    await ensureSchema();
    const settings = await readMicrosoftSettings();
    const updatedBy = settings.updated_by_user_id ? await model.findUserById(db, settings.updated_by_user_id) : null;
    return {
      enabled: Boolean(config.microsoft?.enabled),
      role_choices: MICROSOFT_ROLE_CHOICES,
      auto_create_roles: settings.auto_create_roles,
      updated_at: settings.updated_at,
      updated_by: updatedBy ? { full_name: updatedBy.full_name, email: updatedBy.email } : null
    };
  };

  const updateMicrosoftSettings = async (actor, input = {}, meta = {}) => {
    await ensureSchema();
    if (!Array.isArray(input.auto_create_roles)) throw createHttpError(400, "Choose the roles as a list.");
    const requested = input.auto_create_roles.map((role) => String(role).trim().toLowerCase());
    const invalid = requested.filter((role) => !MICROSOFT_ROLE_CHOICES.includes(role));
    if (invalid.length) throw createHttpError(400, `These roles cannot be chosen: ${invalid.join(", ")}.`);

    const before = await readMicrosoftSettings();
    const roles = MICROSOFT_ROLE_CHOICES.filter((role) => requested.includes(role));
    await model.saveSetting(db, {
      key: MICROSOFT_SETTINGS_KEY,
      value: { auto_create_roles: roles },
      userId: actor.user_id,
      now: now()
    });
    await logEvent("settings.updated", {
      actor,
      meta,
      details: { setting: MICROSOFT_SETTINGS_KEY, auto_create_roles: { from: before.auto_create_roles, to: roles } }
    });
    return getMicrosoftSettings();
  };

  // The next Microsoft sign-in links the account again (by its e-mail): for a
  // person whose Microsoft account was replaced.
  const unlinkMicrosoft = async (actor, userId, meta = {}) => {
    await ensureSchema();
    const target = await requireUser(userId);
    if (!target.microsoft_oid) throw createHttpError(400, "This account is not linked to a Microsoft account.");
    await model.setMicrosoftLink(db, target.user_id, { microsoftOid: null, now: now() });
    await logEvent("user.microsoft_unlinked", { user: target, actor, meta });
    return getUser(target.user_id);
  };

  const getSession = async (token) => {
    if (!token) return null;
    await ensureSchema();
    const currentTime = now();
    const row = await model.findActiveSessionWithUser(db, {
      tokenHash: hashToken(token),
      now: currentTime,
      idleCutoff: new Date(currentTime.getTime() - config.sessionIdleMs)
    });
    if (!row || !row.is_active) return null;

    if (currentTime.getTime() - new Date(row.last_seen_at).getTime() > SESSION_TOUCH_INTERVAL_MS) {
      await model.touchSession(db, row.session_id, currentTime);
    }
    return { sessionId: row.session_id, user: row };
  };

  const logout = async (token, meta = {}) => {
    if (!token) return;
    await ensureSchema();
    const userId = await model.revokeSessionByTokenHash(db, hashToken(token), now());
    if (userId) await logEvent("logout", { user: { user_id: userId }, meta });
  };

  const changePassword = async (sessionUser, sessionId, { currentPassword, newPassword }, meta = {}) => {
    await ensureSchema();
    const user = await requireUser(sessionUser.user_id);

    if (!currentPassword || !(await verifyPassword(currentPassword, user.password_hash))) {
      await logEvent("password.change_failed", { user, meta, details: { reason: "wrong_current_password" } });
      throw createHttpError(400, "The current password is incorrect.");
    }
    assertPasswordPolicy(newPassword, user.email);
    if (await verifyPassword(newPassword, user.password_hash)) {
      throw createHttpError(400, "The new password must be different from the current one.");
    }

    const currentTime = now();
    await model.setUserPassword(db, user.user_id, {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      now: currentTime
    });
    // Signed-in devices other than this one must log in again with the new password.
    const revoked = await model.revokeUserSessions(db, user.user_id, { now: currentTime, exceptSessionId: sessionId });
    await model.invalidateUserPasswordTokens(db, user.user_id, currentTime);
    await logEvent("password.changed", { user, meta, details: { other_sessions_revoked: revoked } });

    return toSessionUser(await model.findUserById(db, user.user_id));
  };

  // Always resolves the same way, whether or not the e-mail matches an account,
  // so the form cannot be used to find out who has an account. The e-mail is
  // sent in the background for the same reason (no timing difference).
  const requestPasswordReset = async ({ email }, meta = {}) => {
    await ensureSchema();
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return;

    const user = await model.findUserByEmail(db, normalizedEmail);
    if (!user || !user.is_active) {
      await logEvent("password.reset_requested", {
        user,
        email: normalizedEmail,
        meta,
        details: { sent: false, reason: user ? "disabled" : "unknown_email" }
      });
      return;
    }

    const currentTime = now();
    const recentRequests = await model.countRecentPasswordTokens(db, {
      userId: user.user_id,
      since: new Date(currentTime.getTime() - 60 * 60 * 1000)
    });
    if (recentRequests >= MAX_RESET_REQUESTS_PER_HOUR) {
      await logEvent("password.reset_requested", { user, meta, details: { sent: false, reason: "rate_limited" } });
      return;
    }

    const passwordLink = await createPasswordLink(user, "reset");
    const delivery = sendPasswordEmail(user, "reset", passwordLink)
      .then(() => logEvent("password.reset_requested", { user, meta, details: { sent: true } }))
      .catch(async (error) => {
        logger.error(`[Auth] Failed to send the reset e-mail to ${user.email}:`, error.message);
        await logEvent("password.reset_requested", {
          user,
          meta,
          details: { sent: false, reason: "email_error", error: error.message }
        });
      })
      .finally(() => pendingDeliveries.delete(delivery));
    pendingDeliveries.add(delivery);
  };

  const flushDeliveries = () => Promise.all(Array.from(pendingDeliveries));

  const validatePasswordToken = async (token) => {
    await ensureSchema();
    const row = token ? await model.findUsablePasswordToken(db, { tokenHash: hashToken(token), now: now() }) : null;
    if (!row || !row.is_active) throw createHttpError(400, INVALID_LINK_MESSAGE);
    return { purpose: row.purpose, email: row.email, full_name: row.full_name };
  };

  const completePasswordReset = async ({ token, password }, meta = {}) => {
    await ensureSchema();
    const tokenHash = hashToken(token);
    const row = token ? await model.findUsablePasswordToken(db, { tokenHash, now: now() }) : null;
    if (!row || !row.is_active) throw createHttpError(400, INVALID_LINK_MESSAGE);

    assertPasswordPolicy(password, row.email);
    const passwordHash = await hashPassword(password);

    const currentTime = now();
    const consumed = await model.consumePasswordToken(db, { tokenHash, now: currentTime });
    if (!consumed) throw createHttpError(400, INVALID_LINK_MESSAGE);

    await model.setUserPassword(db, consumed.user_id, { passwordHash, mustChangePassword: false, now: currentTime });
    const revoked = await model.revokeUserSessions(db, consumed.user_id, { now: currentTime });
    await model.invalidateUserPasswordTokens(db, consumed.user_id, currentTime);
    await logEvent(consumed.purpose === "invite" ? "invite.accepted" : "password.reset", {
      user: { user_id: consumed.user_id, email: row.email },
      meta,
      details: { sessions_revoked: revoked }
    });

    return { email: row.email };
  };

  // ---- administration ------------------------------------------------------

  const listUsers = async ({ search, role, status } = {}) => {
    await ensureSchema();
    const currentTime = now();
    const normalizedRole = USER_ROLES.includes(role) ? role : null;
    const rows = await model.listUsers(db, {
      search: String(search || "").trim() || null,
      role: normalizedRole,
      now: currentTime
    });
    const orgRoles = await loadOrgRoles(rows.map((row) => row.people_id));
    const users = rows.map((row) => toAdminUser(row, currentTime, orgRoleOf(orgRoles, row.people_id)));
    return status ? users.filter((user) => user.status === status) : users;
  };

  const getUser = async (userId) => {
    await ensureSchema();
    const user = await requireUser(userId);
    const currentTime = now();
    const [counters, person, orgRoles] = await Promise.all([
      model.getUserCounters(db, user.user_id, currentTime),
      user.people_id ? model.findPersonById(db, user.people_id) : null,
      loadOrgRoles([user.people_id])
    ]);
    return toAdminUser(
      {
        ...user,
        ...counters,
        person_first_name: person?.first_name,
        person_name: person?.name,
        person_email: person?.email
      },
      currentTime,
      orgRoleOf(orgRoles, user.people_id)
    );
  };

  const createUser = async (actor, input = {}, meta = {}) => {
    await ensureSchema();
    const email = normalizeEmail(input.email);
    if (!email) throw createHttpError(400, "Enter a valid e-mail address.");

    const role = String(input.role || "user").trim().toLowerCase();
    if (!USER_ROLES.includes(role)) throw createHttpError(400, "Invalid role.");

    if (await model.findUserByEmail(db, email)) {
      throw createHttpError(409, "An account already exists for this e-mail.");
    }

    // No person picked: the person with the same e-mail in public.people, if any.
    const personWithEmail =
      parseOptionalId(input.people_id) === null ? await model.findPersonByEmail(db, email) : null;
    const { peopleId, person } = await resolvePeopleLink(personWithEmail ? personWithEmail.people_id : input.people_id);
    if (needsPerson(role) && !peopleId) throw createHttpError(400, PERSON_REQUIRED_MESSAGE);

    const fullName = normalizeName(input.full_name) || getPersonDisplayName(person);
    if (!fullName) throw createHttpError(400, "Enter the user's full name.");

    const temporaryPassword = input.temporary_password ? String(input.temporary_password) : "";
    if (temporaryPassword) assertPasswordPolicy(temporaryPassword, email);

    const user = await model.insertUser(db, {
      email,
      fullName,
      peopleId,
      role,
      passwordHash: temporaryPassword ? await hashPassword(temporaryPassword) : null,
      mustChangePassword: Boolean(temporaryPassword),
      createdByUserId: actor.user_id,
      now: now()
    });

    const delivery = temporaryPassword ? { email_sent: false } : await createAndSendPasswordLink(user, "invite", actor);
    await logEvent("user.created", {
      user,
      actor,
      meta,
      details: { role, mode: temporaryPassword ? "temporary_password" : "invitation", email_sent: delivery.email_sent }
    });

    return { user: await getUser(user.user_id), ...delivery };
  };

  const updateUser = async (actor, userId, input = {}, meta = {}) => {
    await ensureSchema();
    const target = await requireUser(userId);

    const nextRole = input.role === undefined ? target.role : String(input.role).trim().toLowerCase();
    if (!USER_ROLES.includes(nextRole)) throw createHttpError(400, "Invalid role.");
    const nextActive = input.is_active === undefined ? Boolean(target.is_active) : Boolean(input.is_active);
    const nextName = input.full_name === undefined ? target.full_name : normalizeName(input.full_name);
    if (!nextName) throw createHttpError(400, "Enter the user's full name.");

    if (target.user_id === actor.user_id) {
      if (nextRole !== "admin") throw createHttpError(400, "You cannot remove your own administrator role.");
      if (!nextActive) throw createHttpError(400, "You cannot disable your own account.");
    }
    await assertKeepsAnActiveAdmin(target, { nextRole, nextActive });

    const nextPeopleId =
      input.people_id === undefined
        ? target.people_id
        : (await resolvePeopleLink(input.people_id, { exceptUserId: target.user_id })).peopleId;
    // Checked only when the role or the person changes, so an older account
    // without a person can still be disabled or renamed.
    const touchesLink = input.people_id !== undefined || input.role !== undefined;
    if (touchesLink && needsPerson(nextRole) && !nextPeopleId) throw createHttpError(400, PERSON_REQUIRED_MESSAGE);

    const currentTime = now();
    await model.updateUserProfile(db, target.user_id, {
      fullName: nextName,
      peopleId: nextPeopleId,
      role: nextRole,
      isActive: nextActive,
      now: currentTime
    });

    const changes = {};
    if (nextName !== target.full_name) changes.full_name = { from: target.full_name, to: nextName };
    if (nextRole !== target.role) changes.role = { from: target.role, to: nextRole };
    if (nextActive !== Boolean(target.is_active)) changes.is_active = { from: Boolean(target.is_active), to: nextActive };
    if ((nextPeopleId || null) !== (target.people_id || null)) {
      changes.people_id = { from: target.people_id || null, to: nextPeopleId || null };
    }

    if (target.is_active && !nextActive) {
      changes.sessions_revoked = await model.revokeUserSessions(db, target.user_id, { now: currentTime });
    }
    if (Object.keys(changes).length) {
      await logEvent("user.updated", { user: target, actor, meta, details: changes });
    }
    return getUser(target.user_id);
  };

  const deleteUser = async (actor, userId, meta = {}) => {
    await ensureSchema();
    const target = await requireUser(userId);
    if (target.user_id === actor.user_id) throw createHttpError(400, "You cannot delete your own account.");
    await assertKeepsAnActiveAdmin(target, { nextRole: null, nextActive: false });

    await model.deleteUser(db, target.user_id);
    await logEvent("user.deleted", {
      actor,
      email: target.email,
      meta,
      details: { deleted_user_id: target.user_id, role: target.role }
    });
  };

  // Invitation link while the user never signed in (no password, no Microsoft
  // account), reset link afterwards -- also to give a Microsoft account a password.
  const sendPasswordLink = async (actor, userId, meta = {}) => {
    await ensureSchema();
    const target = await requireUser(userId);
    if (!target.is_active) throw createHttpError(400, "Enable the account before sending a link.");

    const purpose = target.password_hash || target.microsoft_oid ? "reset" : "invite";
    const delivery = await createAndSendPasswordLink(target, purpose, actor);
    await logEvent("user.password_link_sent", {
      user: target,
      actor,
      meta,
      details: { purpose, email_sent: delivery.email_sent }
    });
    return { purpose, ...delivery };
  };

  const setTemporaryPassword = async (actor, userId, { password } = {}, meta = {}) => {
    await ensureSchema();
    const target = await requireUser(userId);
    if (target.user_id === actor.user_id) {
      throw createHttpError(400, "Use \"Change password\" to change your own password.");
    }
    assertPasswordPolicy(password, target.email);

    const currentTime = now();
    await model.setUserPassword(db, target.user_id, {
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      now: currentTime
    });
    const revoked = await model.revokeUserSessions(db, target.user_id, { now: currentTime });
    await model.invalidateUserPasswordTokens(db, target.user_id, currentTime);
    await logEvent("user.temporary_password_set", { user: target, actor, meta, details: { sessions_revoked: revoked } });
    return getUser(target.user_id);
  };

  const unlockUser = async (actor, userId, meta = {}) => {
    await ensureSchema();
    const target = await requireUser(userId);
    await model.unlockUser(db, target.user_id, now());
    await logEvent("user.unlocked", { user: target, actor, meta });
    return getUser(target.user_id);
  };

  // An administrator revoking their own sessions keeps the one they are using.
  const revokeSessions = async (actor, actorSessionId, userId, meta = {}) => {
    await ensureSchema();
    const target = await requireUser(userId);
    const revoked = await model.revokeUserSessions(db, target.user_id, {
      now: now(),
      exceptSessionId: target.user_id === actor.user_id ? actorSessionId : null
    });
    await logEvent("user.sessions_revoked", { user: target, actor, meta, details: { sessions_revoked: revoked } });
    return { sessions_revoked: revoked };
  };

  const listEvents = async ({ userId, eventType, limit } = {}) => {
    await ensureSchema();
    const parsedUserId = parseOptionalId(userId);
    const parsedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = await model.listAuthEvents(db, {
      userId: Number.isNaN(parsedUserId) ? null : parsedUserId,
      eventType: String(eventType || "").trim() || null,
      limit: parsedLimit
    });
    return rows.map((row) => ({
      ...row,
      details: typeof row.details === "string" ? JSON.parse(row.details) : row.details,
      created_at: toIso(row.created_at)
    }));
  };

  const searchPeople = async (search) => {
    await ensureSchema();
    const term = String(search || "").trim();
    if (term.length < 2) return [];
    const rows = await model.searchPeople(db, { search: term.slice(0, 100), limit: 20 });
    return rows.map((row) => ({
      people_id: row.people_id,
      full_name: getPersonDisplayName(row),
      email: row.email || "",
      linked_user_id: row.linked_user_id || null
    }));
  };

  return {
    ensureSchema,
    login,
    signInWithMicrosoft,
    getMicrosoftSettings,
    updateMicrosoftSettings,
    unlinkMicrosoft,
    getSession,
    logout,
    changePassword,
    requestPasswordReset,
    flushDeliveries,
    validatePasswordToken,
    completePasswordReset,
    listUsers,
    getUser,
    createUser,
    updateUser,
    deleteUser,
    sendPasswordLink,
    setTemporaryPassword,
    unlockUser,
    revokeSessions,
    listEvents,
    searchPeople,
    toSessionUser
  };
};

module.exports = {
  USER_ROLES,
  MICROSOFT_ROLE_CHOICES,
  DEFAULT_MICROSOFT_AUTO_CREATE_ROLES,
  createAuthService,
  normalizeEmail,
  getUserStatus
};
