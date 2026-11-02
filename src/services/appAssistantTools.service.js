// The tools the AI Assistant calls to read live KPI data (OpenAI function
// calling). Read-only, and always scoped by the signed-in account in code --
// never by the prompt:
// - not signed in: only the KPI catalog (find_kpis), public like /api/kpis;
// - signed in: their own KPIs, plus the responsibles of their scope for plant /
//   zone managers, VP, CEO and administrators (services/kpiAnalyticsScope.service.js,
//   the same rule as "My KPI Analytics").
//
// The Action Plan, training and knowledge-base readers are passed in (server.js),
// so this module only needs a database handle and can be tested against pg-mem.

const { createHttpError } = require("../utils/httpError");
const {
  getDashboardSubmissionStatus,
  normalizeMetricNumberByUnit,
  inferKpiDirection
} = require("./kpiShared.service");

const DAY_MS = 24 * 60 * 60 * 1000;

const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const cleanText = (value, maxLength = 120) => {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : "";
};

const searchKey = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const matchesSearch = (search, ...fields) => {
  const words = searchKey(search).split(" ").filter(Boolean);
  if (!words.length) return true;
  const haystack = searchKey(fields.filter(Boolean).join(" "));
  return words.every((word) => haystack.includes(word));
};

const personName = (firstName, name, fallbackId = null) =>
  [firstName, name].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ") ||
  (fallbackId ? `Person ${fallbackId}` : "");

const pad = (number) => String(number).padStart(2, "0");

// DATE columns come back from node-postgres as local midnight: local getters
// give the stored day back.
const toDay = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value.slice(0, 10) : null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(typeof value === "string" ? value.replace(",", ".") : value);
  return Number.isFinite(parsed) ? parsed : null;
};

const round = (value, digits = 4) => (value === null ? null : Number(Number(value).toFixed(digits)));

const firstDefined = (...values) => values.find((value) => value !== null && value !== undefined && value !== "") ?? null;

const STATUS_ORDER = { off_target: 0, no_value: 1, on_target: 2 };

const ALLOCATION_COLUMNS = `
  kta.kpi_target_allocation_id,
  kta.kpi_id,
  kta.set_by_people_id,
  kta.target_value AS allocation_target,
  kta.target_unit,
  kta.target_start_date,
  kta.target_end_date,
  kta.target_status,
  k.kpi_name,
  k.kpi_sub_title,
  k.kpi_code,
  k.unit AS kpi_unit,
  k.frequency,
  k.target_value AS kpi_target,
  k.low_limit AS kpi_low_limit,
  k.high_limit AS kpi_high_limit,
  k.target_direction,
  k.tolerance_type,
  k.up_tolerance,
  k.low_tolerance,
  p.first_name,
  p.name AS last_name,
  work_unit.unit_name AS work_unit_name,
  plant.unit_name AS plant_name
`;

const ALLOCATION_JOINS = `
  FROM public.kpi_target_allocation kta
  JOIN public.kpi k ON k.kpi_id = kta.kpi_id
  LEFT JOIN public.people p ON p.people_id = kta.set_by_people_id
  LEFT JOIN public.unit work_unit ON work_unit.unit_id = p.work_at_unit_id
  LEFT JOIN public.unit plant ON plant.unit_id = kta.plant_id
`;

const TOOL_DEFINITIONS = [
  {
    name: "find_kpis",
    label: "Searching the KPI catalog",
    public: true,
    description:
      "Search the KPI catalog (definitions, not results): name, subtitle, code, unit, frequency, direction, target, limits, calculation mode and explanation. Use it to explain what a KPI means or how it is calculated, or to find a kpi_id.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words of the KPI name, subtitle, code or definition, e.g. 'scrap rate' or 'OTD'." },
        limit: { type: "integer", description: "Maximum KPIs to return (default 8, max 25)." }
      },
      required: ["query"]
    }
  },
  {
    name: "get_kpi_status_overview",
    label: "Reading the latest KPI results",
    description:
      "Latest value and status (on_target / off_target / no_value) of every active KPI allocation of a responsible, a unit or the whole scope, with counts and, for several people, a per-responsible summary with their last entry date (use it for 'who has not entered values'). Use it for 'how are my KPIs', 'which KPIs are red', plant comparisons.",
    parameters: {
      type: "object",
      properties: {
        responsible: {
          type: "string",
          description:
            "Whose KPIs: 'me' = only the user's own (default); 'all' = every responsible of the user's scope — use it for questions about 'my plant', 'my zone', 'my team', 'everyone' or 'who...'; or a people_id, or a person's name."
        },
        unit_id: { type: "integer", description: "Only the responsibles working at this unit / plant (managers)." },
        kpi_search: { type: "string", description: "Only KPIs whose name, subtitle or code contains these words." },
        status: {
          type: "string",
          enum: ["all", "off_target", "on_target", "no_value"],
          description: "Only allocations with this status (default all)."
        },
        limit: { type: "integer", description: "Maximum allocations listed (default 40, max 100); counts always cover everything." }
      }
    }
  },
  {
    name: "get_kpi_trend",
    label: "Reading the KPI history",
    description:
      "Month-by-month history of one KPI for a responsible (latest value of each month, with target, limits and status), the most recent entries, and statistics (average, best, worst, months on / off target, trend). Use it for trends, comparisons over time and before giving improvement advice.",
    parameters: {
      type: "object",
      properties: {
        kpi: { type: "string", description: "The kpi_id, or words of the KPI name / subtitle / code." },
        responsible: { type: "string", description: "'me' (default), a people_id or a person's name." },
        months: { type: "integer", description: "How many months back (default 12, max 36)." }
      },
      required: ["kpi"]
    }
  },
  {
    name: "get_target_allocations",
    label: "Reading the target allocations",
    description:
      "Target allocations (the target of a KPI for a plant / zone / unit / product / customer scope, with its dates and status) of a responsible or of the user's scope.",
    parameters: {
      type: "object",
      properties: {
        responsible: {
          type: "string",
          description: "'me' = the user's own (default); 'all' = everyone in the user's scope (their plant / zone / team); a people_id or a person's name."
        },
        unit_id: { type: "integer", description: "Only the responsibles working at this unit / plant (managers)." },
        kpi_search: { type: "string", description: "Only KPIs whose name, subtitle or code contains these words." },
        include_ended: { type: "boolean", description: "Also list allocations whose end date has passed (default false)." },
        limit: { type: "integer", description: "Maximum allocations listed (default 40, max 100)." }
      }
    }
  },
  {
    name: "get_corrective_actions",
    label: "Reading the corrective actions",
    description:
      "Corrective actions of the Action Plan linked to the KPI allocations of a responsible or of the scope: root cause, implemented solution, owner, due date (and whether it is overdue), importance, urgency, status.",
    parameters: {
      type: "object",
      properties: {
        responsible: {
          type: "string",
          description: "'me' = the user's own (default); 'all' = everyone in the user's scope (their plant / zone / team); a people_id or a person's name."
        },
        status: { type: "string", enum: ["open", "closed", "all"], description: "Default open." },
        kpi_search: { type: "string", description: "Only actions of KPIs whose name contains these words." },
        limit: { type: "integer", description: "Maximum actions listed (default 30, max 100)." }
      }
    }
  },
  {
    name: "get_kpi_knowledge",
    label: "Consulting the KPI knowledge base",
    description:
      "The knowledge base stored for one KPI (subject tree, related topics, improvement levers), searched with a question. Use it to explain a KPI in depth or to suggest root causes and actions.",
    parameters: {
      type: "object",
      properties: {
        kpi_id: { type: "integer", description: "The KPI (find it first with find_kpis or the overview)." },
        question: { type: "string", description: "What to look for, e.g. 'root causes of a high scrap rate'." }
      },
      required: ["kpi_id"]
    }
  },
  {
    name: "get_my_trainings",
    label: "Reading your KPI trainings",
    description:
      "The KPI trainings and tests assigned to the signed-in user: status, due date, score, passed, reminders / escalation level.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "list_people_in_scope",
    label: "Looking up the people in your scope",
    description:
      "The responsibles (with KPI results) and units the user may look at, to find a people_id or unit_id, or to answer 'who reports to my plant'.",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Words of a person's or unit's name." },
        unit_id: { type: "integer", description: "Only the people of this unit." }
      }
    }
  }
];

const createAppAssistantTools = ({
  db,
  analyticsScope,
  loadCorrectiveActions = null,
  loadTrainingAssignments = null,
  loadKpiKnowledge = null,
  getStatus = getDashboardSubmissionStatus,
  now = () => new Date()
}) => {
  const requireViewer = (viewer) => {
    if (!viewer) throw createHttpError(401, "The user is not signed in: this data needs a session. Suggest [Sign in](/login).");
    return viewer;
  };

  // "me" / "all" / people_id / name -> the people ids, checked against the scope.
  const resolvePeople = async (viewer, { responsible, unit_id: unitId } = {}) => {
    requireViewer(viewer);
    const ownerId = viewer.people_id ? Number(viewer.people_id) : null;
    let wanted = cleanText(responsible) || "me";

    if (!/^(me|all|\d+)$/i.test(wanted)) {
      const filters = await analyticsScope.getFilters(viewer);
      const candidates = filters.responsibles.filter((person) => matchesSearch(wanted, person.full_name));
      if (ownerId && matchesSearch(wanted, viewer.full_name)) wanted = "me";
      else if (candidates.length === 1) wanted = String(candidates[0].people_id);
      else if (candidates.length > 1) {
        throw createHttpError(
          409,
          `Several people match "${wanted}": ${candidates
            .slice(0, 8)
            .map((person) => `${person.full_name} (people_id ${person.people_id}, ${person.unit_name || "no unit"})`)
            .join("; ")}. Ask which one.`
        );
      } else {
        throw createHttpError(404, `Nobody named "${wanted}" in the user's scope (they see ${filters.level === "own" ? "only their own KPIs" : "their scope only"}).`);
      }
    }

    if (wanted.toLowerCase() === "me" && !ownerId) {
      throw createHttpError(400, "This account is not linked to a person, so it has no KPIs of its own: ask for a responsible or 'all'.");
    }
    return analyticsScope.resolveSelection(viewer, { ownerId, responsible: wanted.toLowerCase(), unitId });
  };

  const loadAllocations = async (peopleIds, { includeEnded = false, kpiId = null } = {}) => {
    if (!peopleIds.length) return [];
    const params = [peopleIds];
    const conditions = ["kta.set_by_people_id = ANY($1::int[])", "k.is_active IS NOT FALSE"];
    if (!includeEnded) {
      params.push(toDay(now()));
      conditions.push(`(kta.target_end_date IS NULL OR kta.target_end_date >= $${params.length}::date)`);
    }
    if (kpiId) {
      params.push(kpiId);
      conditions.push(`kta.kpi_id = $${params.length}`);
    }
    const result = await db.query(
      `SELECT ${ALLOCATION_COLUMNS} ${ALLOCATION_JOINS} WHERE ${conditions.join(" AND ")} ORDER BY k.kpi_name, kta.kpi_target_allocation_id`,
      params
    );
    return result.rows;
  };

  // The latest result with a value of each allocation.
  const loadLatestResults = async (allocationIds) => {
    if (!allocationIds.length) return new Map();
    const result = await db.query(
      `
      SELECT DISTINCT ON (kr.kpi_target_allocation_id)
        kr.kpi_target_allocation_id, kr.raw_value, kr.week, kr.period_label, kr.result_date, kr.recorded_at,
        kr.target_value, kr.lower_limit, kr.upper_limit, kr.unit
      FROM public.kpi_result kr
      WHERE kr.kpi_target_allocation_id = ANY($1::int[]) AND kr.raw_value IS NOT NULL
      ORDER BY kr.kpi_target_allocation_id, COALESCE(kr.result_date::timestamp, kr.recorded_at) DESC NULLS LAST,
        kr.recorded_at DESC NULLS LAST, kr.kpi_result_id DESC
      `,
      [allocationIds]
    );
    return new Map(result.rows.map((row) => [Number(row.kpi_target_allocation_id), row]));
  };

  // Status as the dashboard computes it: the result's own target / limits
  // first, then the allocation's target, then the KPI's.
  const evaluate = (allocation, result) => {
    const unit = firstDefined(result?.unit, allocation.target_unit, allocation.kpi_unit) || "";
    const kpi = {
      kpi_id: allocation.kpi_id,
      value: result?.raw_value ?? null,
      unit,
      target: firstDefined(result?.target_value, allocation.allocation_target, allocation.kpi_target),
      low_limit: firstDefined(result?.lower_limit, allocation.kpi_low_limit),
      high_limit: firstDefined(result?.upper_limit, allocation.kpi_high_limit),
      target_direction: allocation.target_direction,
      tolerance_type: allocation.tolerance_type,
      up_tolerance: allocation.up_tolerance,
      low_tolerance: allocation.low_tolerance,
      subject: allocation.kpi_name,
      indicator_sub_title: allocation.kpi_sub_title
    };
    const statusInfo = getStatus(kpi);
    const value = normalizeMetricNumberByUnit(kpi.value, unit);
    const target = normalizeMetricNumberByUnit(kpi.target, unit);
    return {
      unit,
      value,
      target,
      low_limit: normalizeMetricNumberByUnit(kpi.low_limit, unit),
      high_limit: normalizeMetricNumberByUnit(kpi.high_limit, unit),
      direction: statusInfo.direction || inferKpiDirection(kpi),
      status: statusInfo.isGood === true ? "on_target" : statusInfo.isGood === false ? "off_target" : "no_value",
      gap_to_target: value !== null && target !== null ? round(value - target) : null
    };
  };

  const describeAllocation = (allocation) => ({
    allocation_id: Number(allocation.kpi_target_allocation_id),
    kpi_id: Number(allocation.kpi_id),
    kpi: allocation.kpi_name || allocation.kpi_sub_title || `KPI ${allocation.kpi_id}`,
    subtitle: allocation.kpi_sub_title || undefined,
    code: allocation.kpi_code || undefined,
    frequency: allocation.frequency || undefined,
    responsible_id: Number(allocation.set_by_people_id),
    responsible: personName(allocation.first_name, allocation.last_name, allocation.set_by_people_id),
    plant: allocation.plant_name || allocation.work_unit_name || undefined
  });

  // Calendar days between the entry and today.
  const daysSince = (value) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const today = now();
    const dayStart = (day) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    return Math.max(0, Math.round((dayStart(today) - dayStart(date)) / DAY_MS));
  };

  const tools = {
    async find_kpis(_viewer, args) {
      const words = searchKey(args.query).split(" ").filter((word) => word.length > 1).slice(0, 6);
      if (!words.length) throw createHttpError(400, "Give a few words of the KPI to look for.");
      const limit = clampInt(args.limit, 8, 1, 25);
      const params = words.map((word) => `%${word}%`);
      const clauses = params.map(
        (_value, index) =>
          `(COALESCE(k.kpi_name, '') ILIKE $${index + 1} OR COALESCE(k.kpi_sub_title, '') ILIKE $${index + 1} OR COALESCE(k.kpi_code, '') ILIKE $${index + 1} OR COALESCE(k.kpi_explanation, '') ILIKE $${index + 1})`
      );
      const result = await db.query(
        `
        SELECT k.kpi_id, k.kpi_name, k.kpi_sub_title, k.kpi_code, k.unit, k.frequency, k.target_direction,
          k.target_value, k.low_limit, k.high_limit, k.calculation_mode, k.calculation_on, k.kpi_explanation
        FROM public.kpi k
        WHERE k.is_active IS NOT FALSE AND (${clauses.join(" OR ")})
        ORDER BY k.kpi_name
        LIMIT 300
        `,
        params
      );
      const scored = result.rows
        .map((row) => {
          const name = searchKey(`${row.kpi_name || ""} ${row.kpi_code || ""}`);
          const subtitle = searchKey(row.kpi_sub_title);
          const explanation = searchKey(row.kpi_explanation);
          const score = words.reduce(
            (total, word) =>
              total + (name.includes(word) ? 3 : 0) + (subtitle.includes(word) ? 2 : 0) + (explanation.includes(word) ? 1 : 0),
            0
          );
          return { row, score };
        })
        .sort((left, right) => right.score - left.score);
      return {
        total_matches: scored.length,
        kpis: scored.slice(0, limit).map(({ row }) => ({
          kpi_id: Number(row.kpi_id),
          name: row.kpi_name || "",
          subtitle: row.kpi_sub_title || undefined,
          code: row.kpi_code || undefined,
          unit: row.unit || undefined,
          frequency: row.frequency || undefined,
          direction: row.target_direction || undefined,
          target: toNumber(row.target_value),
          low_limit: toNumber(row.low_limit),
          high_limit: toNumber(row.high_limit),
          calculation_mode: row.calculation_mode || undefined,
          calculation_on: row.calculation_on || undefined,
          definition: cleanText(row.kpi_explanation, 700) || undefined
        }))
      };
    },

    async get_kpi_status_overview(viewer, args) {
      const peopleIds = await resolvePeople(viewer, args);
      const allocations = await loadAllocations(peopleIds);
      const latest = await loadLatestResults(allocations.map((row) => Number(row.kpi_target_allocation_id)));

      const items = allocations.map((allocation) => {
        const result = latest.get(Number(allocation.kpi_target_allocation_id));
        const evaluation = evaluate(allocation, result);
        return {
          ...describeAllocation(allocation),
          period: result ? firstDefined(result.week, result.period_label, toDay(result.result_date)) : null,
          ...evaluation,
          last_entry: result ? toDay(result.recorded_at || result.result_date) : null,
          days_since_entry: result ? daysSince(result.recorded_at || result.result_date) : null
        };
      });

      const counts = { allocations: items.length, on_target: 0, off_target: 0, no_value: 0 };
      const byResponsible = new Map();
      for (const item of items) {
        counts[item.status] += 1;
        if (!byResponsible.has(item.responsible_id)) {
          byResponsible.set(item.responsible_id, {
            responsible_id: item.responsible_id,
            responsible: item.responsible,
            plant: item.plant,
            allocations: 0,
            on_target: 0,
            off_target: 0,
            no_value: 0,
            last_entry: null
          });
        }
        const summary = byResponsible.get(item.responsible_id);
        summary.allocations += 1;
        summary[item.status] += 1;
        if (item.last_entry && (!summary.last_entry || item.last_entry > summary.last_entry)) summary.last_entry = item.last_entry;
      }

      const status = ["off_target", "on_target", "no_value"].includes(args.status) ? args.status : null;
      const limit = clampInt(args.limit, 40, 1, 100);
      const listed = items
        .filter((item) => (!status || item.status === status) && matchesSearch(args.kpi_search, item.kpi, item.subtitle, item.code))
        .sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || left.kpi.localeCompare(right.kpi));

      return {
        people_in_selection: peopleIds.length,
        counts,
        by_responsible:
          byResponsible.size > 1
            ? [...byResponsible.values()]
                .sort((left, right) => right.off_target - left.off_target || right.no_value - left.no_value)
                .slice(0, 60)
            : undefined,
        items: listed.slice(0, limit),
        items_not_listed: Math.max(0, listed.length - limit)
      };
    },

    async get_kpi_trend(viewer, args) {
      const peopleIds = await resolvePeople(viewer, { responsible: args.responsible || "me" });
      const kpiText = cleanText(args.kpi);
      if (!kpiText) throw createHttpError(400, "Which KPI?");
      const kpiId = /^\d+$/.test(kpiText) ? Number(kpiText) : null;
      const months = clampInt(args.months, 12, 1, 36);

      const all = await loadAllocations(peopleIds, { includeEnded: true, kpiId });
      const allocations = kpiId ? all : all.filter((row) => matchesSearch(kpiText, row.kpi_name, row.kpi_sub_title, row.kpi_code));
      if (!allocations.length) {
        const own = kpiId ? await loadAllocations(peopleIds, { includeEnded: true }) : all;
        return {
          message: `No KPI matching "${kpiText}" among the allocations of this selection.`,
          kpis_available: [...new Set(own.map((row) => row.kpi_name).filter(Boolean))].slice(0, 25)
        };
      }

      const selected = allocations.slice(0, 6);
      const ids = selected.map((row) => Number(row.kpi_target_allocation_id));
      const result = await db.query(
        `
        SELECT kr.kpi_result_id, kr.kpi_target_allocation_id, kr.raw_value, kr.week, kr.period_label, kr.result_date,
          kr.recorded_at, kr.target_value, kr.lower_limit, kr.upper_limit, kr.unit
        FROM public.kpi_result kr
        WHERE kr.kpi_target_allocation_id = ANY($1::int[]) AND kr.raw_value IS NOT NULL
        ORDER BY kr.kpi_target_allocation_id, COALESCE(kr.result_date::timestamp, kr.recorded_at) ASC NULLS FIRST,
          kr.recorded_at ASC NULLS FIRST, kr.kpi_result_id ASC
        `,
        [ids]
      );

      const start = now();
      const cutoff = new Date(start.getFullYear(), start.getMonth() - months + 1, 1);
      const resultsByAllocation = new Map(ids.map((id) => [id, []]));
      for (const row of result.rows) {
        const when = row.result_date || row.recorded_at;
        const date = when ? new Date(when) : null;
        if (!date || Number.isNaN(date.getTime()) || date < cutoff) continue;
        resultsByAllocation.get(Number(row.kpi_target_allocation_id))?.push({ ...row, when: date });
      }

      const series = selected.map((allocation) => {
        const rows = resultsByAllocation.get(Number(allocation.kpi_target_allocation_id)) || [];
        // The latest entry of each month, as "My KPI Analytics" plots it.
        const byMonth = new Map();
        for (const row of rows) byMonth.set(`${row.when.getFullYear()}-${pad(row.when.getMonth() + 1)}`, row);
        const points = [...byMonth.entries()].map(([month, row]) => {
          const evaluation = evaluate(allocation, row);
          return {
            month,
            period: firstDefined(row.week, row.period_label),
            value: evaluation.value,
            target: evaluation.target,
            status: evaluation.status
          };
        });
        const last = rows[rows.length - 1];
        const lastEvaluation = last ? evaluate(allocation, last) : evaluate(allocation, null);
        const values = points.map((point) => point.value).filter((value) => value !== null);
        const higherIsBetter = lastEvaluation.direction !== "down";
        const average = values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
        let trend = "not enough data";
        if (values.length >= 4) {
          const half = Math.min(3, Math.floor(values.length / 2));
          const recent = values.slice(-half).reduce((sum, value) => sum + value, 0) / half;
          const before = values.slice(-2 * half, -half).reduce((sum, value) => sum + value, 0) / half;
          const change = before === 0 ? recent - before : (recent - before) / Math.abs(before);
          trend = Math.abs(change) < 0.02 ? "stable" : (change > 0) === higherIsBetter ? "improving" : "worsening";
        }
        return {
          ...describeAllocation(allocation),
          unit: lastEvaluation.unit,
          direction: lastEvaluation.direction,
          current: last
            ? {
                period: firstDefined(last.week, last.period_label, toDay(last.result_date)),
                value: lastEvaluation.value,
                target: lastEvaluation.target,
                low_limit: lastEvaluation.low_limit,
                high_limit: lastEvaluation.high_limit,
                status: lastEvaluation.status
              }
            : null,
          monthly: points,
          recent_entries: rows.slice(-8).map((row) => {
            const evaluation = evaluate(allocation, row);
            return { period: firstDefined(row.week, row.period_label, toDay(row.result_date)), value: evaluation.value, status: evaluation.status };
          }),
          stats: {
            months_with_data: points.length,
            average,
            best: values.length ? (higherIsBetter ? Math.max(...values) : Math.min(...values)) : null,
            worst: values.length ? (higherIsBetter ? Math.min(...values) : Math.max(...values)) : null,
            months_on_target: points.filter((point) => point.status === "on_target").length,
            months_off_target: points.filter((point) => point.status === "off_target").length,
            trend
          }
        };
      });

      return {
        months,
        series,
        other_matching_allocations: Math.max(0, allocations.length - selected.length) || undefined
      };
    },

    async get_target_allocations(viewer, args) {
      const peopleIds = await resolvePeople(viewer, args);
      const rows = await loadAllocations(peopleIds, { includeEnded: args.include_ended === true });
      const limit = clampInt(args.limit, 40, 1, 100);
      const listed = rows.filter((row) => matchesSearch(args.kpi_search, row.kpi_name, row.kpi_sub_title, row.kpi_code));
      return {
        total: listed.length,
        allocations: listed.slice(0, limit).map((row) => ({
          ...describeAllocation(row),
          target: toNumber(firstDefined(row.allocation_target, row.kpi_target)),
          unit: firstDefined(row.target_unit, row.kpi_unit) || undefined,
          low_limit: toNumber(row.kpi_low_limit),
          high_limit: toNumber(row.kpi_high_limit),
          direction: row.target_direction || undefined,
          start_date: toDay(row.target_start_date),
          end_date: toDay(row.target_end_date),
          status: row.target_status || undefined
        })),
        not_listed: Math.max(0, listed.length - limit)
      };
    },

    async get_corrective_actions(viewer, args) {
      if (!loadCorrectiveActions) throw createHttpError(503, "The Action Plan is not available.");
      const peopleIds = await resolvePeople(viewer, args);
      const allocations = (await loadAllocations(peopleIds, { includeEnded: true })).filter((row) =>
        matchesSearch(args.kpi_search, row.kpi_name, row.kpi_sub_title, row.kpi_code)
      );
      if (!allocations.length) return { total: 0, actions: [] };

      const byAllocation = new Map(allocations.map((row) => [String(row.kpi_target_allocation_id), row]));
      const wanted = ["open", "closed", "all"].includes(args.status) ? args.status : "open";
      const today = toDay(now());
      const actions = (await loadCorrectiveActions(allocations.slice(0, 600)))
        .filter((action) => byAllocation.has(String(action.kpi_target_allocation_id)))
        .filter((action) => wanted === "all" || (wanted === "closed") === Boolean(action.is_closed))
        .map((action) => {
          const allocation = byAllocation.get(String(action.kpi_target_allocation_id));
          const dueDate = toDay(action.due_date);
          return {
            action_id: action.id,
            kpi: allocation.kpi_name || `KPI ${allocation.kpi_id}`,
            kpi_id: Number(allocation.kpi_id),
            responsible: personName(allocation.first_name, allocation.last_name, allocation.set_by_people_id),
            period: action.period_label || undefined,
            root_cause: cleanText(action.root_cause, 400) || undefined,
            implemented_solution: cleanText(action.implemented_solution, 400) || undefined,
            owner: action.owner || undefined,
            status: action.status,
            due_date: dueDate,
            overdue: Boolean(!action.is_closed && dueDate && dueDate < today),
            importance: action.importance || undefined,
            urgency: action.urgency || undefined,
            created: toDay(action.created_date),
            closed: toDay(action.closed_date)
          };
        })
        .sort((left, right) => Number(right.overdue) - Number(left.overdue) || String(left.due_date || "9999").localeCompare(String(right.due_date || "9999")));
      const limit = clampInt(args.limit, 30, 1, 100);
      return {
        total: actions.length,
        overdue: actions.filter((action) => action.overdue).length,
        actions: actions.slice(0, limit),
        not_listed: Math.max(0, actions.length - limit)
      };
    },

    async get_kpi_knowledge(viewer, args) {
      requireViewer(viewer);
      if (!loadKpiKnowledge) throw createHttpError(503, "The KPI knowledge base is not available.");
      const kpiId = clampInt(args.kpi_id, null, 1, Number.MAX_SAFE_INTEGER);
      if (!kpiId) throw createHttpError(400, "Which kpi_id?");
      const knowledge = await loadKpiKnowledge({ kpiId, question: cleanText(args.question, 500) });
      return knowledge || { available: false, message: "No knowledge base is stored for this KPI yet." };
    },

    async get_my_trainings(viewer) {
      requireViewer(viewer);
      if (!viewer.people_id) throw createHttpError(400, "This account is not linked to a person, so it has no trainings.");
      if (!loadTrainingAssignments) throw createHttpError(503, "The training portal is not available.");
      const assignments = await loadTrainingAssignments(Number(viewer.people_id));
      return {
        total: assignments.length,
        training_center: `/kpi-training-center?people_id=${viewer.people_id}`,
        assignments: assignments.slice(0, 40)
      };
    },

    async list_people_in_scope(viewer, args) {
      requireViewer(viewer);
      const filters = await analyticsScope.getFilters(viewer);
      if (filters.level === "own") {
        return {
          level: "own",
          message: "This account only sees its own KPIs.",
          people: viewer.people_id ? [{ people_id: Number(viewer.people_id), full_name: viewer.full_name }] : []
        };
      }
      const unitId = clampInt(args.unit_id, null, 1, Number.MAX_SAFE_INTEGER);
      const people = filters.responsibles.filter(
        (person) => (!unitId || person.unit_id === unitId) && matchesSearch(args.search, person.full_name, person.unit_name)
      );
      return {
        level: filters.level,
        units: filters.units.filter((unit) => matchesSearch(args.search, unit.unit_name) || !args.search).slice(0, 80),
        people: people.slice(0, 80),
        not_listed: Math.max(0, people.length - 80)
      };
    }
  };

  // The function definitions the model may call: only find_kpis without a session.
  const definitionsFor = (viewer) =>
    TOOL_DEFINITIONS.filter((tool) => viewer || tool.public)
      .filter((tool) => tool.name !== "get_corrective_actions" || loadCorrectiveActions)
      .filter((tool) => tool.name !== "get_my_trainings" || (loadTrainingAssignments && viewer?.people_id))
      .filter((tool) => tool.name !== "get_kpi_knowledge" || loadKpiKnowledge)
      .map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }));

  const labelOf = (name) => TOOL_DEFINITIONS.find((tool) => tool.name === name)?.label || "Reading data";

  // Runs one call. Errors come back as { error } so the model can explain them.
  const execute = async (name, rawArgs, { viewer = null } = {}) => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    if (!definition || !tools[name]) return { error: `Unknown tool ${name}.` };
    if (!viewer && !definition.public) return { error: "The user is not signed in: this data needs a session. Suggest [Sign in](/login)." };
    let args = rawArgs;
    if (typeof rawArgs === "string") {
      try {
        args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch {
        return { error: "Invalid arguments (not JSON)." };
      }
    }
    try {
      return await tools[name](viewer, args && typeof args === "object" ? args : {});
    } catch (error) {
      if (error.statusCode) return { error: error.message };
      throw error;
    }
  };

  // What the system prompt says about the user's scope.
  const describeScope = async (viewer) => {
    if (!viewer) return null;
    const filters = await analyticsScope.getFilters(viewer);
    const names = (filters.scope_units?.length ? filters.scope_units : []).map((unit) => unit.unit_name).filter(Boolean);
    return { level: filters.level, unit_names: names.slice(0, 20) };
  };

  return { definitionsFor, execute, labelOf, describeScope };
};

module.exports = { TOOL_DEFINITIONS, createAppAssistantTools };
