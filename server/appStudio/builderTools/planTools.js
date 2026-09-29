/**
 * App Studio builder tools — plan-first UX (app_propose_plan, app_mark_phase).
 * The route owns the real side effects (plan SSE, checkpoint snapshots);
 * these bound and validate the artifacts. boundPlanArtifact is reused
 * route-side on plan approval.
 */

'use strict';

const { capStr, capStrArray } = require('./shared');

// ── Plan-first UX, phases & templates (Wave 5) ───────────────────────
//
// app_propose_plan and app_mark_phase are READ tools whose real side effects
// (mint planId + emit plan SSE + persist pendingPlan + end the turn; emit
// phase/checkpoint SSE + write a version snapshot) are owned by the ROUTE —
// it intercepts these two by name in the tool-call loop. The tools here just
// validate/bound their arguments and hand a clean artifact back.

const PLAN_LIMITS = {
    TITLE: 120, SUMMARY: 400, PURPOSE: 200, DESC: 200, LABEL: 80, STR: 120,
    MAX_TABLES: 20, MAX_FIELDS: 40, MAX_ROLES: 20, MAX_SCREENS: 30,
    MAX_OPTIONS: 40, MAX_CONTENTS: 30, MAX_DATASETS: 20, MAX_ACTIONS: 40,
    MAX_PHASES: 12, MAX_QUESTIONS: 12, MAX_SEED: 50,
};

/**
 * Validate + bound a plan artifact from app_propose_plan args into a compact,
 * size-limited object the route stores (pendingPlan) and emits (plan SSE). The
 * plan is presented to the user and persisted — never executed — so this only
 * caps lengths/array sizes and drops junk; it does not cross-check ids. Returns
 * { plan } or { error, _fixHint }.
 */
function boundPlanArtifact(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { error: 'app_propose_plan needs a plan object { title, summary, screens, tables?, roles?, datasets?, actions?, phases? }.' };
    }
    const L = PLAN_LIMITS;
    const plan = {};
    const title = capStr(args.title, L.TITLE);
    if (title) plan.title = title;
    const summary = capStr(args.summary, L.SUMMARY);
    if (summary) plan.summary = summary;

    if (Array.isArray(args.tables)) {
        const tables = args.tables.slice(0, L.MAX_TABLES).map((t) => {
            const row = {};
            const k = capStr(t?.key, L.STR); if (k) row.key = k;
            const n = capStr(t?.name, L.STR); if (n) row.name = n;
            if (Array.isArray(t?.fields)) {
                const fields = t.fields.slice(0, L.MAX_FIELDS).map((f) => {
                    const fr = {};
                    const fk = capStr(f?.key, L.STR); if (fk) fr.key = fk;
                    const ft = capStr(f?.type, L.STR); if (ft) fr.type = ft;
                    const opts = capStrArray(f?.options, L.MAX_OPTIONS, L.STR); if (opts) fr.options = opts;
                    const rel = capStr(f?.relationTo, L.STR); if (rel) fr.relationTo = rel;
                    return fr;
                }).filter((fr) => fr.key);
                if (fields.length) row.fields = fields;
            }
            if (Number.isFinite(t?.seedCount)) row.seedCount = Math.max(0, Math.min(L.MAX_SEED, Math.floor(t.seedCount)));
            return row;
        }).filter((t) => t.key);
        if (tables.length) plan.tables = tables;
    }

    if (Array.isArray(args.roles)) {
        const roles = args.roles.slice(0, L.MAX_ROLES).map((r) => {
            const row = {};
            const k = capStr(r?.key, L.STR); if (k) row.key = k;
            const lbl = capStr(r?.label, L.LABEL); if (lbl) row.label = lbl;
            return row;
        }).filter((r) => r.key);
        if (roles.length) plan.roles = roles;
    }

    if (Array.isArray(args.screens)) {
        const screens = args.screens.slice(0, L.MAX_SCREENS).map((s) => {
            const row = {};
            const n = capStr(s?.name, L.STR); if (n) row.name = n;
            const ic = capStr(s?.icon, L.STR); if (ic) row.icon = ic;
            const p = capStr(s?.purpose, L.PURPOSE); if (p) row.purpose = p;
            const contents = capStrArray(s?.contents, L.MAX_CONTENTS, L.STR); if (contents) row.contents = contents;
            const forRoles = capStrArray(s?.forRoles, L.MAX_ROLES, L.STR); if (forRoles) row.forRoles = forRoles;
            return row;
        }).filter((s) => s.name);
        if (screens.length) plan.screens = screens;
    }

    if (Array.isArray(args.datasets)) {
        const datasets = args.datasets.slice(0, L.MAX_DATASETS).map((d) => {
            const row = {};
            const n = capStr(d?.name, L.STR); if (n) row.name = n;
            const tk = capStr(d?.tableKey, L.STR); if (tk) row.tableKey = tk;
            const p = capStr(d?.purpose, L.PURPOSE); if (p) row.purpose = p;
            return row;
        }).filter((d) => d.name);
        if (datasets.length) plan.datasets = datasets;
    }

    if (Array.isArray(args.actions)) {
        const actions = args.actions.slice(0, L.MAX_ACTIONS).map((a) => {
            const row = {};
            const n = capStr(a?.name, L.STR); if (n) row.name = n;
            const k = capStr(a?.kind, L.STR); if (k) row.kind = k;
            const d = capStr(a?.description, L.DESC); if (d) row.description = d;
            return row;
        }).filter((a) => a.name);
        if (actions.length) plan.actions = actions;
    }

    if (Array.isArray(args.phases)) {
        const phases = args.phases.slice(0, L.MAX_PHASES).map((p) => {
            const row = {};
            const lbl = capStr(p?.label, L.LABEL); if (lbl) row.label = lbl;
            const covers = capStrArray(p?.covers, L.MAX_CONTENTS, L.STR); if (covers) row.covers = covers;
            return row;
        }).filter((p) => p.label);
        if (phases.length) plan.phases = phases;
    }

    const openQuestions = capStrArray(args.openQuestions, L.MAX_QUESTIONS, L.SUMMARY);
    if (openQuestions) plan.openQuestions = openQuestions;
    const baseTemplateId = capStr(args.baseTemplateId, L.STR);
    if (baseTemplateId) plan.baseTemplateId = baseTemplateId;

    if (!plan.title && !plan.summary && !plan.screens && !plan.tables) {
        return {
            error: 'The plan is empty — include at least a title/summary and the screens or tables you intend to build.',
            _fixHint: 'app_propose_plan { title, summary, screens:[{name,purpose,contents}], tables?:[…], phases?:[…] }.',
        };
    }
    return { plan };
}

/**
 * app_propose_plan — bound the plan and acknowledge. The route reads `plan`
 * off this result to mint a planId, emit the plan SSE and end the turn; the
 * model itself only sees `{ presented: true }` (the route strips `plan` from
 * the tool message so it is not echoed back).
 */
function applyProposePlan(draftWrap, args) {
    const bounded = boundPlanArtifact(args);
    if (bounded.error) return bounded;
    return { presented: true, plan: bounded.plan };
}

/**
 * app_mark_phase — validate the phase announcement. The route emits the phase
 * SSE and writes the checkpoint version snapshot; this just bounds the args.
 */
function applyMarkPhase(draftWrap, args) {
    const index = Number.isFinite(args?.index) ? Math.max(0, Math.floor(args.index)) : null;
    if (index === null) return { error: 'index must be a number (the 0-based phase index from the approved plan).' };
    const label = capStr(args?.label, PLAN_LIMITS.LABEL);
    if (!label) return { error: 'label must be a non-empty string naming the phase.' };
    return { ok: true, index, label };
}

module.exports = {
    boundPlanArtifact,
    applyProposePlan,
    applyMarkPhase,
    PLAN_LIMITS,
};
