// Read-only lookups in public.people for "Continue with Microsoft": the person
// behind a Microsoft e-mail, whether they are still active, and the account
// role their role assignments give them (people_role_assignment, the same
// source as services/kpiAnalyticsScope.service.js).
//
// Assignment -> account role (the highest wins when a person has several):
//   "CEO" -> ceo, level "VP" -> vp, "Zone managers" -> zone_manager,
//   "Plant manager" -> plant_manager, anything else (or none) -> user.
// "admin" never comes from the assignments: only an administrator gives it.

const ORG_ROLE_RANK = ["user", "plant_manager", "zone_manager", "vp", "ceo"];

const ACTIVE_ASSIGNMENT = `
  UPPER(pra.assignment_status) = 'ACTIVE'
  AND (pra.start_date IS NULL OR pra.start_date <= CURRENT_DATE)
  AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
`;

const PERSON_COLUMNS = `
  p.people_id,
  p.first_name,
  p.name,
  p.email,
  LOWER(TRIM(COALESCE(p.status, ''))) = 'active' AS active
`;

const createPeopleDirectory = ({ db }) => {
  // Exact, case-insensitive match; null unless exactly one person has this e-mail.
  const findPersonByEmail = async (email) => {
    const result = await db.query(
      `SELECT ${PERSON_COLUMNS} FROM public.people p WHERE LOWER(TRIM(p.email)) = $1 ORDER BY p.people_id LIMIT 2`,
      [String(email || "").trim().toLowerCase()]
    );
    return result.rows.length === 1 ? result.rows[0] : null;
  };

  const getPerson = async (peopleId) => {
    const result = await db.query(`SELECT ${PERSON_COLUMNS} FROM public.people p WHERE p.people_id = $1`, [peopleId]);
    return result.rows[0] || null;
  };

  // people_id -> { role, label }: label is the assignment the role comes from.
  // People without any active assignment are left out (role "user").
  const getOrgRoles = async (peopleIds) => {
    const ids = [...new Set(peopleIds.map(Number).filter(Number.isInteger))];
    const roles = new Map();
    if (!ids.length) return roles;

    const result = await db.query(
      `
      SELECT
        pra.people_id,
        r.role_name,
        CASE
          WHEN r.role_name ILIKE 'ceo' THEN 'ceo'
          WHEN r.role_level ILIKE 'vp' THEN 'vp'
          WHEN r.role_name ILIKE 'zone manager%' THEN 'zone_manager'
          WHEN r.role_name ILIKE 'plant manager%' THEN 'plant_manager'
          ELSE 'user'
        END AS app_role
      FROM public.people_role_assignment pra
      JOIN public.role r ON r.role_id = pra.role_id
      WHERE pra.people_id = ANY($1::int[]) AND ${ACTIVE_ASSIGNMENT}
      ORDER BY pra.people_id, COALESCE(pra.is_primary, FALSE) DESC, pra.assignment_id
      `,
      [ids]
    );
    for (const row of result.rows) {
      const peopleId = Number(row.people_id);
      const current = roles.get(peopleId);
      if (!current || ORG_ROLE_RANK.indexOf(row.app_role) > ORG_ROLE_RANK.indexOf(current.role)) {
        roles.set(peopleId, { role: row.app_role, label: row.role_name });
      }
    }
    return roles;
  };

  const getOrgRole = async (peopleId) =>
    (await getOrgRoles([peopleId])).get(Number(peopleId)) || { role: "user", label: null };

  return { findPersonByEmail, getPerson, getOrgRoles, getOrgRole };
};

module.exports = { ORG_ROLE_RANK, createPeopleDirectory };
