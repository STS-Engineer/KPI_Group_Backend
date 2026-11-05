// SQL for the authentication / user administration module. Every function
// takes the database handle (pg Pool or client) as its first argument so the
// module can run against the production pool or an in-memory test database.
//
// The module owns its own tables (kpi_app_*). It never writes to the existing
// tables: public.people is only read, to link an account to a person.

// Account roles. "admin" manages the accounts; the others set how far a user
// sees in "My KPI Analytics" (services/kpiAnalyticsScope.service.js).
const USER_ROLES = ["user", "plant_manager", "zone_manager", "vp", "ceo", "admin"];
const ROLE_CHECK = `CONSTRAINT kpi_app_user_role_check CHECK (role IN (${USER_ROLES.map((role) => `'${role}'`).join(", ")}))`;

const AUTH_SCHEMA_STATEMENTS = [
  `
  CREATE TABLE IF NOT EXISTS public.kpi_app_user (
    user_id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    full_name VARCHAR(255) NOT NULL DEFAULT '',
    people_id INTEGER NULL UNIQUE REFERENCES public.people(people_id) ON DELETE SET NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user' ${ROLE_CHECK},
    password_hash TEXT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ NULL,
    last_login_at TIMESTAMPTZ NULL,
    password_changed_at TIMESTAMPTZ NULL,
    created_by_user_id INTEGER NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `
  CREATE TABLE IF NOT EXISTS public.kpi_app_session (
    session_id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES public.kpi_app_user(user_id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    ip_address VARCHAR(64) NULL,
    user_agent VARCHAR(512) NULL
  )
  `,
  // Tables created before the KPI roles only accept admin/user: replace the
  // check (one statement, so the table is never left without it).
  `ALTER TABLE public.kpi_app_user DROP CONSTRAINT IF EXISTS kpi_app_user_role_check, ADD ${ROLE_CHECK}`,
  `CREATE INDEX IF NOT EXISTS kpi_app_session_user_idx ON public.kpi_app_session (user_id)`,
  `
  CREATE TABLE IF NOT EXISTS public.kpi_app_password_token (
    token_id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES public.kpi_app_user(user_id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('reset', 'invite')),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `CREATE INDEX IF NOT EXISTS kpi_app_password_token_user_idx ON public.kpi_app_password_token (user_id)`,
  `
  CREATE TABLE IF NOT EXISTS public.kpi_app_auth_event (
    event_id SERIAL PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    user_id INTEGER NULL REFERENCES public.kpi_app_user(user_id) ON DELETE SET NULL,
    actor_user_id INTEGER NULL REFERENCES public.kpi_app_user(user_id) ON DELETE SET NULL,
    email VARCHAR(255) NULL,
    ip_address VARCHAR(64) NULL,
    user_agent VARCHAR(512) NULL,
    details JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `CREATE INDEX IF NOT EXISTS kpi_app_auth_event_created_idx ON public.kpi_app_auth_event (created_at)`,
  // Sign in with Microsoft: the Microsoft account (Entra ID object id) linked
  // to the account, how the account was created (by an administrator or by a
  // first Microsoft sign-in) and how it last signed in (password / microsoft).
  `ALTER TABLE public.kpi_app_user ADD COLUMN IF NOT EXISTS microsoft_oid VARCHAR(64) NULL`,
  `ALTER TABLE public.kpi_app_user ADD COLUMN IF NOT EXISTS microsoft_linked_at TIMESTAMPTZ NULL`,
  `ALTER TABLE public.kpi_app_user ADD COLUMN IF NOT EXISTS created_via VARCHAR(20) NOT NULL DEFAULT 'admin'`,
  `ALTER TABLE public.kpi_app_user ADD COLUMN IF NOT EXISTS last_login_method VARCHAR(20) NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS kpi_app_user_microsoft_oid_idx ON public.kpi_app_user (microsoft_oid)`,
  // Settings of the module changed from the administration (JSON per key).
  `
  CREATE TABLE IF NOT EXISTS public.kpi_app_setting (
    setting_key VARCHAR(64) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_by_user_id INTEGER NULL REFERENCES public.kpi_app_user(user_id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `
];

const ensureAuthSchema = async (db) => {
  for (const statement of AUTH_SCHEMA_STATEMENTS) {
    await db.query(statement);
  }
};

const USER_COLUMNS = `
  u.user_id,
  u.email,
  u.full_name,
  u.people_id,
  u.role,
  u.password_hash,
  u.is_active,
  u.must_change_password,
  u.failed_login_count,
  u.locked_until,
  u.last_login_at,
  u.password_changed_at,
  u.created_by_user_id,
  u.created_at,
  u.updated_at,
  u.microsoft_oid,
  u.microsoft_linked_at,
  u.created_via,
  u.last_login_method
`;

const findUserByEmail = async (db, email) => {
  const result = await db.query(
    `SELECT ${USER_COLUMNS} FROM public.kpi_app_user u WHERE u.email = $1`,
    [email]
  );
  return result.rows[0] || null;
};

const findUserById = async (db, userId) => {
  const result = await db.query(
    `SELECT ${USER_COLUMNS} FROM public.kpi_app_user u WHERE u.user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
};

const findUserByPeopleId = async (db, peopleId) => {
  const result = await db.query(
    `SELECT ${USER_COLUMNS} FROM public.kpi_app_user u WHERE u.people_id = $1`,
    [peopleId]
  );
  return result.rows[0] || null;
};

const findUserByMicrosoftOid = async (db, microsoftOid) => {
  const result = await db.query(
    `SELECT ${USER_COLUMNS} FROM public.kpi_app_user u WHERE u.microsoft_oid = $1`,
    [microsoftOid]
  );
  return result.rows[0] || null;
};

// createdVia: "admin" (created from the administration or the setup script),
// "microsoft" (created by a first Microsoft sign-in, already linked to it).
const insertUser = async (
  db,
  { email, fullName, peopleId, role, passwordHash, mustChangePassword, createdByUserId, createdVia = "admin", microsoftOid = null, now }
) => {
  const result = await db.query(
    `
    INSERT INTO public.kpi_app_user (
      email, full_name, people_id, role, password_hash, must_change_password,
      password_changed_at, created_by_user_id, created_via, microsoft_oid, microsoft_linked_at,
      created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
    RETURNING user_id
    `,
    [
      email,
      fullName,
      peopleId,
      role,
      passwordHash,
      Boolean(mustChangePassword),
      passwordHash ? now : null,
      createdByUserId,
      createdVia,
      microsoftOid,
      microsoftOid ? now : null,
      now
    ]
  );
  return findUserById(db, result.rows[0].user_id);
};

// microsoftOid null: the account is no longer linked to a Microsoft account.
const setMicrosoftLink = async (db, userId, { microsoftOid, now }) => {
  await db.query(
    `
    UPDATE public.kpi_app_user
    SET microsoft_oid = $2, microsoft_linked_at = $3, updated_at = $4
    WHERE user_id = $1
    `,
    [userId, microsoftOid, microsoftOid ? now : null, now]
  );
};

// A temporary password dropped at a Microsoft sign-in: the account no longer
// has a password (the user can choose one with "Forgot your password?").
const clearUserPassword = async (db, userId, now) => {
  await db.query(
    `
    UPDATE public.kpi_app_user
    SET password_hash = NULL, must_change_password = FALSE, password_changed_at = $2, updated_at = $2
    WHERE user_id = $1
    `,
    [userId, now]
  );
};

const updateUserProfile = async (db, userId, { fullName, peopleId, role, isActive, now }) => {
  await db.query(
    `
    UPDATE public.kpi_app_user
    SET full_name = $2, people_id = $3, role = $4, is_active = $5, updated_at = $6
    WHERE user_id = $1
    `,
    [userId, fullName, peopleId, role, isActive, now]
  );
  return findUserById(db, userId);
};

const setUserPassword = async (db, userId, { passwordHash, mustChangePassword, now }) => {
  await db.query(
    `
    UPDATE public.kpi_app_user
    SET password_hash = $2,
        must_change_password = $3,
        password_changed_at = $4,
        failed_login_count = 0,
        locked_until = NULL,
        updated_at = $4
    WHERE user_id = $1
    `,
    [userId, passwordHash, Boolean(mustChangePassword), now]
  );
};

// Returns the new consecutive failure count.
const registerFailedLogin = async (db, userId, { maxFailedLogins, lockedUntil, now }) => {
  const result = await db.query(
    `
    UPDATE public.kpi_app_user
    SET failed_login_count = failed_login_count + 1,
        locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN $3::timestamptz ELSE locked_until END,
        updated_at = $4
    WHERE user_id = $1
    RETURNING failed_login_count
    `,
    [userId, maxFailedLogins, lockedUntil, now]
  );
  return Number(result.rows[0]?.failed_login_count || 0);
};

// method: "password" or "microsoft".
const registerSuccessfulLogin = async (db, userId, now, method = "password") => {
  await db.query(
    `
    UPDATE public.kpi_app_user
    SET failed_login_count = 0, locked_until = NULL, last_login_at = $2, last_login_method = $3, updated_at = $2
    WHERE user_id = $1
    `,
    [userId, now, method]
  );
};

const unlockUser = async (db, userId, now) => {
  await db.query(
    `
    UPDATE public.kpi_app_user
    SET failed_login_count = 0, locked_until = NULL, updated_at = $2
    WHERE user_id = $1
    `,
    [userId, now]
  );
};

const deleteUser = async (db, userId) => {
  await db.query(`DELETE FROM public.kpi_app_user WHERE user_id = $1`, [userId]);
};

const countActiveAdmins = async (db) => {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count FROM public.kpi_app_user WHERE role = 'admin' AND is_active = TRUE`
  );
  return Number(result.rows[0]?.count || 0);
};

const listUsers = async (db, { search, role, now }) => {
  const result = await db.query(
    `
    SELECT
      ${USER_COLUMNS},
      COALESCE(s.active_sessions, 0)::int AS active_sessions,
      COALESCE(t.pending_invites, 0)::int AS pending_invites,
      p.first_name AS person_first_name,
      p.name AS person_name,
      p.email AS person_email
    FROM public.kpi_app_user u
    LEFT JOIN public.people p ON p.people_id = u.people_id
    LEFT JOIN (
      SELECT user_id, COUNT(*)::int AS active_sessions
      FROM public.kpi_app_session
      WHERE revoked_at IS NULL AND expires_at > $1
      GROUP BY user_id
    ) s ON s.user_id = u.user_id
    LEFT JOIN (
      SELECT user_id, COUNT(*)::int AS pending_invites
      FROM public.kpi_app_password_token
      WHERE purpose = 'invite' AND used_at IS NULL AND expires_at > $1
      GROUP BY user_id
    ) t ON t.user_id = u.user_id
    WHERE ($2::text IS NULL OR LOWER(u.email) LIKE $2 OR LOWER(u.full_name) LIKE $2)
      AND ($3::text IS NULL OR u.role = $3)
    ORDER BY LOWER(u.full_name), LOWER(u.email)
    `,
    [now, search ? `%${search.toLowerCase()}%` : null, role || null]
  );
  return result.rows;
};

// Same counters as listUsers(), for a single account.
const getUserCounters = async (db, userId, now) => {
  const [sessions, invites] = await Promise.all([
    db.query(
      `
      SELECT COUNT(*)::int AS count
      FROM public.kpi_app_session
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
      `,
      [userId, now]
    ),
    db.query(
      `
      SELECT COUNT(*)::int AS count
      FROM public.kpi_app_password_token
      WHERE user_id = $1 AND purpose = 'invite' AND used_at IS NULL AND expires_at > $2
      `,
      [userId, now]
    )
  ]);
  return {
    active_sessions: Number(sessions.rows[0]?.count || 0),
    pending_invites: Number(invites.rows[0]?.count || 0)
  };
};

// ---- sessions --------------------------------------------------------------

const insertSession = async (db, { userId, tokenHash, expiresAt, ipAddress, userAgent, now }) => {
  await db.query(
    `
    INSERT INTO public.kpi_app_session (user_id, token_hash, created_at, last_seen_at, expires_at, ip_address, user_agent)
    VALUES ($1, $2, $3, $3, $4, $5, $6)
    `,
    [userId, tokenHash, now, expiresAt, ipAddress, userAgent]
  );
};

const findActiveSessionWithUser = async (db, { tokenHash, now, idleCutoff }) => {
  const result = await db.query(
    `
    SELECT s.session_id, s.last_seen_at, s.expires_at, ${USER_COLUMNS}
    FROM public.kpi_app_session s
    JOIN public.kpi_app_user u ON u.user_id = s.user_id
    WHERE s.token_hash = $1
      AND s.revoked_at IS NULL
      AND s.expires_at > $2
      AND s.last_seen_at > $3
    `,
    [tokenHash, now, idleCutoff]
  );
  return result.rows[0] || null;
};

const touchSession = async (db, sessionId, now) => {
  await db.query(`UPDATE public.kpi_app_session SET last_seen_at = $2 WHERE session_id = $1`, [sessionId, now]);
};

const revokeSessionByTokenHash = async (db, tokenHash, now) => {
  const result = await db.query(
    `
    UPDATE public.kpi_app_session
    SET revoked_at = $2
    WHERE token_hash = $1 AND revoked_at IS NULL
    RETURNING user_id
    `,
    [tokenHash, now]
  );
  return result.rows[0]?.user_id || null;
};

// Revokes every live session of a user, optionally keeping one (the caller's).
const revokeUserSessions = async (db, userId, { now, exceptSessionId = null }) => {
  const result = await db.query(
    `
    UPDATE public.kpi_app_session
    SET revoked_at = $2
    WHERE user_id = $1
      AND revoked_at IS NULL
      AND ($3::integer IS NULL OR session_id <> $3)
    RETURNING session_id
    `,
    [userId, now, exceptSessionId]
  );
  return result.rows.length;
};

// ---- password tokens (reset links and invitations) -------------------------

const insertPasswordToken = async (db, { userId, tokenHash, purpose, expiresAt, now }) => {
  await db.query(
    `
    INSERT INTO public.kpi_app_password_token (user_id, token_hash, purpose, expires_at, created_at)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [userId, tokenHash, purpose, expiresAt, now]
  );
};

const findUsablePasswordToken = async (db, { tokenHash, now }) => {
  const result = await db.query(
    `
    SELECT t.token_id, t.user_id, t.purpose, t.expires_at, u.email, u.full_name, u.is_active
    FROM public.kpi_app_password_token t
    JOIN public.kpi_app_user u ON u.user_id = t.user_id
    WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > $2
    `,
    [tokenHash, now]
  );
  return result.rows[0] || null;
};

// Single statement, so two concurrent submissions of the same link cannot both
// succeed: only the first one gets the row back.
const consumePasswordToken = async (db, { tokenHash, now }) => {
  const result = await db.query(
    `
    UPDATE public.kpi_app_password_token
    SET used_at = $2
    WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
    RETURNING token_id, user_id, purpose
    `,
    [tokenHash, now]
  );
  return result.rows[0] || null;
};

// A new link (or a completed reset) makes the user's older links unusable.
const invalidateUserPasswordTokens = async (db, userId, now) => {
  await db.query(
    `
    UPDATE public.kpi_app_password_token
    SET used_at = $2
    WHERE user_id = $1 AND used_at IS NULL
    `,
    [userId, now]
  );
};

const countRecentPasswordTokens = async (db, { userId, since }) => {
  const result = await db.query(
    `
    SELECT COUNT(*)::int AS count
    FROM public.kpi_app_password_token
    WHERE user_id = $1 AND purpose = 'reset' AND created_at > $2
    `,
    [userId, since]
  );
  return Number(result.rows[0]?.count || 0);
};

// ---- audit log -------------------------------------------------------------

const insertAuthEvent = async (db, { eventType, userId, actorUserId, email, ipAddress, userAgent, details, now }) => {
  await db.query(
    `
    INSERT INTO public.kpi_app_auth_event (event_type, user_id, actor_user_id, email, ip_address, user_agent, details, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      eventType,
      userId || null,
      actorUserId || null,
      email || null,
      ipAddress || null,
      userAgent || null,
      details ? JSON.stringify(details) : null,
      now
    ]
  );
};

const listAuthEvents = async (db, { userId, eventType, limit }) => {
  const result = await db.query(
    `
    SELECT
      e.event_id,
      e.event_type,
      e.user_id,
      e.actor_user_id,
      e.email,
      e.ip_address,
      e.user_agent,
      e.details,
      e.created_at,
      actor.email AS actor_email,
      actor.full_name AS actor_full_name
    FROM public.kpi_app_auth_event e
    LEFT JOIN public.kpi_app_user actor ON actor.user_id = e.actor_user_id
    WHERE ($1::integer IS NULL OR e.user_id = $1)
      AND ($2::text IS NULL OR e.event_type = $2)
    ORDER BY e.created_at DESC, e.event_id DESC
    LIMIT $3
    `,
    [userId || null, eventType || null, limit]
  );
  return result.rows;
};

// ---- settings --------------------------------------------------------------

const getSetting = async (db, key) => {
  const result = await db.query(
    `SELECT setting_key, value, updated_by_user_id, updated_at FROM public.kpi_app_setting WHERE setting_key = $1`,
    [key]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, value: typeof row.value === "string" ? JSON.parse(row.value) : row.value };
};

const saveSetting = async (db, { key, value, userId, now }) => {
  await db.query(
    `
    INSERT INTO public.kpi_app_setting (setting_key, value, updated_by_user_id, updated_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (setting_key) DO UPDATE
    SET value = EXCLUDED.value, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = EXCLUDED.updated_at
    `,
    [key, JSON.stringify(value), userId || null, now]
  );
};

// ---- people (read-only) ----------------------------------------------------

const findPersonById = async (db, peopleId) => {
  const result = await db.query(
    `SELECT people_id, name, first_name, email FROM public.people WHERE people_id = $1`,
    [peopleId]
  );
  return result.rows[0] || null;
};

// Exact, case-insensitive match; null unless exactly one person has this e-mail.
const findPersonByEmail = async (db, email) => {
  const result = await db.query(
    `SELECT people_id, name, first_name, email FROM public.people WHERE LOWER(email) = $1 ORDER BY people_id LIMIT 2`,
    [String(email || "").trim().toLowerCase()]
  );
  return result.rows.length === 1 ? result.rows[0] : null;
};

const searchPeople = async (db, { search, limit }) => {
  const result = await db.query(
    `
    SELECT p.people_id, p.name, p.first_name, p.email, linked.user_id AS linked_user_id
    FROM public.people p
    LEFT JOIN public.kpi_app_user linked ON linked.people_id = p.people_id
    WHERE (COALESCE(p.first_name, '') || ' ' || COALESCE(p.name, '')) ILIKE $1
       OR (COALESCE(p.name, '') || ' ' || COALESCE(p.first_name, '')) ILIKE $1
       OR COALESCE(p.email, '') ILIKE $1
    ORDER BY p.name, p.first_name, p.people_id
    LIMIT $2
    `,
    [`%${search}%`, limit]
  );
  return result.rows;
};

module.exports = {
  USER_ROLES,
  AUTH_SCHEMA_STATEMENTS,
  ensureAuthSchema,
  findUserByEmail,
  findUserById,
  findUserByPeopleId,
  findUserByMicrosoftOid,
  insertUser,
  updateUserProfile,
  setUserPassword,
  setMicrosoftLink,
  clearUserPassword,
  registerFailedLogin,
  registerSuccessfulLogin,
  unlockUser,
  deleteUser,
  countActiveAdmins,
  listUsers,
  getUserCounters,
  insertSession,
  findActiveSessionWithUser,
  touchSession,
  revokeSessionByTokenHash,
  revokeUserSessions,
  insertPasswordToken,
  findUsablePasswordToken,
  consumePasswordToken,
  invalidateUserPasswordTokens,
  countRecentPasswordTokens,
  insertAuthEvent,
  listAuthEvents,
  getSetting,
  saveSetting,
  findPersonById,
  findPersonByEmail,
  searchPeople
};
