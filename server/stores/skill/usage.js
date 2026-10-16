// @typecheck
'use strict';
/**
 * Where a skill is used ("Used by"): agents (draft and published config)
 * and automation steps, per skill and as a summary. The delete guard in
 * ../skillStore.js reads this list.
 */

const { getAll } = require('../../db');
const { initDB } = require('./schema');

/**
 * An agent carries its skills TWICE: `config` is the draft the Builder edits,
 * `published_config` is the copy the runtime reads (A1). Both matter here,
 * and the way they are combined is a safety decision, not a style one.
 *
 * ── UNION, NEVER COALESCE ───────────────────────────────────────────
 * `COALESCE(published_config, config)` reads only the PUBLISHED copy the
 * moment an agent has ever been published. An agent that attaches this skill
 * in its draft alone then falls out of the usage list — and the 409 guard on
 * delete, which is built from exactly this list, would answer "nothing uses
 * this" and let the delete quietly break that draft. Unknown must never
 * become the roomier answer, so the two are OR-ed: the skill is in use if it
 * is in EITHER copy.
 *
 * `attachedSkillIds` lives inside the JSON blob, so the test is ARRAY-ELEMENT
 * containment: `(config::jsonb->'attachedSkillIds') ? $1`. A bare
 * `config::jsonb ? $1` would test for a top-level KEY and never match — and
 * the 409 guard would never fire (critique finding, verified). Scoped to the
 * skill's own organisation.
 *
 * `agents.config` is TEXT (stores/agent/initSchema.js), so `''::jsonb` would
 * abort the WHOLE query — and with it the usage list and the delete guard —
 * over one empty row. `NULLIF(config, '')` is part of the same expression,
 * so it cannot be reordered after the cast the way a separate `config <> ''`
 * predicate could. `published_config` is JSONB and nullable, so it needs no
 * such guard: `NULL->'x'` is NULL and `jsonb_typeof(NULL)` is NULL.
 */
const _DRAFT_SKILLS = "NULLIF(config, '')::jsonb->'attachedSkillIds'";
const _PUBLISHED_SKILLS = "published_config->'attachedSkillIds'";

/** `<expr>` holds skill $1 as an array element. */
const _holdsSkill = (expr) => `(jsonb_typeof(${expr}) = 'array' AND (${expr}) ? $1)`;

/**
 * An install whose `agents` table predates A1 has no `published_config`.
 * There is then no published copy to miss, so the draft-only query is the
 * COMPLETE answer — this narrows, it never widens. Anything else rethrows:
 * a usage scan that fails must fail loudly, because the delete guard reads it.
 */
function _isMissingPublishedConfig(err) {
    return err?.code === '42703' || /column .*published_config.* does not exist/i.test(err?.message || '');
}

async function _agentScan(sql, params) {
    try {
        return await getAll(sql(true), params);
    } catch (err) {
        if (!_isMissingPublishedConfig(err)) throw err;
        return getAll(sql(false), params);
    }
}

async function _agentsUsingSkill(skillId, orgId) {
    const sql = (withPublished) => `
        SELECT id, name, owner_id, organization_id, updated_at
           FROM agents
          WHERE organization_id IS NOT DISTINCT FROM $2
            AND (${_holdsSkill(_DRAFT_SKILLS)}${withPublished ? ` OR ${_holdsSkill(_PUBLISHED_SKILLS)}` : ''})
          ORDER BY name ASC`;
    return _agentScan(sql, [skillId, orgId || null]);
}

/**
 * Which automation AI steps apply this skill (`ai_step.skillIds`, Track R2):
 * root steps and steps inside `definition_json.layers.<key>.steps`.
 */
async function _automationStepsUsingSkill(skillId, orgId) {
    return getAll(
        `SELECT a.id, a.title, a.user_id, a.last_run_at, a.is_active,
                step->>'id' AS step_id, step->>'label' AS step_label, NULL AS layer_key
           FROM automations a,
                jsonb_array_elements(CASE WHEN jsonb_typeof(a.definition_json->'steps') = 'array' THEN a.definition_json->'steps' ELSE '[]'::jsonb END) step
          WHERE a.organization_id IS NOT DISTINCT FROM $2
            AND step->>'type' = 'ai_step'
            AND jsonb_typeof(step->'skillIds') = 'array'
            AND (step->'skillIds') ? $1
         UNION ALL
         SELECT a.id, a.title, a.user_id, a.last_run_at, a.is_active,
                step->>'id' AS step_id, step->>'label' AS step_label, layer.key AS layer_key
           FROM automations a,
                jsonb_each(CASE WHEN jsonb_typeof(a.definition_json->'layers') = 'object' THEN a.definition_json->'layers' ELSE '{}'::jsonb END) layer,
                jsonb_array_elements(CASE WHEN jsonb_typeof(layer.value->'steps') = 'array' THEN layer.value->'steps' ELSE '[]'::jsonb END) step
          WHERE a.organization_id IS NOT DISTINCT FROM $2
            AND step->>'type' = 'ai_step'
            AND jsonb_typeof(step->'skillIds') = 'array'
            AND (step->'skillIds') ? $1`,
        [skillId, orgId || null],
    );
}

/**
 * "Used by" for one skill: `{ rows, unchecked }`.
 *
 *   rows       the shared/UsedByTab.jsx contract —
 *              { kind:'agent'|'automation', id, title, role:'chat'|'ai_step',
 *                siteLabel?, lastAt, ownerId, stepId? }
 *              agents first, then automations.
 *   unchecked  the kinds this scan could NOT look at, by name.
 *
 * ── WHY THE PAIR, AND NOT JUST THE ROWS ─────────────────────────────
 * The automations half is allowed to be absent: an install with no automations
 * has no `automations` table, and that is a supported shape rather than an
 * error. But swallowing it into `[]` made "no automation uses this skill" and
 * "I never looked at automations" the same answer, and the two callers of this
 * function make the loudest possible claims off it — the Used-by tab prints
 * "No agent or automation uses this skill yet", and the delete confirmation
 * prints "can be deleted without breaking anything else". Neither of those may
 * be said about a kind nobody scanned, so the gap travels out with the rows
 * (`{ unchecked: ['automation'] }`, the same shape K5 established) instead of
 * being dropped at this boundary.
 */
async function listSkillUsage(skillId, orgId) {
    await initDB();
    if (!skillId) return { rows: [], unchecked: [] };
    const unchecked = [];
    const [agents, steps] = await Promise.all([
        _agentsUsingSkill(skillId, orgId),
        _automationStepsUsingSkill(skillId, orgId).catch(err => {
            // automations may not exist on an install without automations. Not an
            // error — but not a count either, so it is named rather than zeroed.
            if (/relation .*automations.* does not exist/i.test(err.message)) {
                unchecked.push('automation');
                return [];
            }
            throw err;
        }),
    ]);
    let lastByAgent = {};
    try {
        lastByAgent = await require('../skillActivations').getLastActivationByAgent(skillId, (agents || []).map(a => a.id));
    } catch (_) { /* telemetry is optional */ }
    /** @type {Array<{kind: string, id: any, title: any, role: string, lastAt: any, ownerId?: any, siteLabel?: string, stepId?: any, [key: string]: any}>} */
    const rows = (agents || []).map(a => ({
        kind: 'agent',
        id: a.id,
        title: a.name || null,
        role: 'chat',
        lastAt: lastByAgent[a.id] || null,
        ownerId: a.owner_id || null,
    }));
    for (const s of steps || []) {
        rows.push({
            kind: 'automation',
            id: s.id,
            title: s.title || null,
            role: 'ai_step',
            siteLabel: s.step_label ? `step ${s.step_label}` : (s.step_id ? `step ${s.step_id}` : undefined),
            stepId: s.step_id || null,
            layerKey: s.layer_key || null,
            lastAt: s.last_run_at ? new Date(s.last_run_at).toISOString() : null,
            ownerId: s.user_id || null,
        });
    }
    return { rows, unchecked };
}

/**
 * Per-skill usage counts for a set of skills, one query per kind:
 *   { [skillId]: { agents: n, automations: n, lastUsedAt: ISO|null } }
 * Skills with no usage are present with zeros.
 */
async function getUsageSummary(orgId, skillIds) {
    await initDB();
    const ids = [...new Set((Array.isArray(skillIds) ? skillIds : []).filter(Boolean))];
    const out = {};
    if (ids.length === 0) return out;
    for (const id of ids) out[id] = { agents: 0, automations: 0, lastUsedAt: null };

    // Same union as `_agentsUsingSkill`, and `COUNT(DISTINCT agent_id)` for
    // the same reason the automation count uses it: an agent that carries the
    // skill in BOTH its draft and its published copy is one agent, not two.
    // A subline reading "4 agents" for three is a small lie the list would
    // then tell on every load.
    const agentSkills = (column) => `
        SELECT a.id AS agent_id, s AS skill_id
          FROM agents a,
               jsonb_array_elements_text(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END) s
         WHERE a.organization_id IS NOT DISTINCT FROM $1 AND s = ANY($2::text[])`;
    const agentCounts = await _agentScan(
        (withPublished) => `SELECT skill_id, COUNT(DISTINCT agent_id)::int AS n FROM (
            ${agentSkills("NULLIF(a.config, '')::jsonb->'attachedSkillIds'")}
            ${withPublished ? `UNION ALL${agentSkills("a.published_config->'attachedSkillIds'")}` : ''}
        ) u GROUP BY skill_id`,
        [orgId || null, ids],
    );
    for (const r of agentCounts || []) if (out[r.skill_id]) out[r.skill_id].agents = Number(r.n) || 0;

    try {
        const autoCounts = await getAll(
            `SELECT skill_id, COUNT(DISTINCT automation_id)::int AS n FROM (
                SELECT a.id AS automation_id, s AS skill_id
                  FROM automations a,
                       jsonb_array_elements(CASE WHEN jsonb_typeof(a.definition_json->'steps') = 'array' THEN a.definition_json->'steps' ELSE '[]'::jsonb END) step,
                       jsonb_array_elements_text(CASE WHEN step->>'type' = 'ai_step' AND jsonb_typeof(step->'skillIds') = 'array' THEN step->'skillIds' ELSE '[]'::jsonb END) s
                 WHERE a.organization_id IS NOT DISTINCT FROM $1 AND s = ANY($2::text[])
                UNION ALL
                SELECT a.id AS automation_id, s AS skill_id
                  FROM automations a,
                       jsonb_each(CASE WHEN jsonb_typeof(a.definition_json->'layers') = 'object' THEN a.definition_json->'layers' ELSE '{}'::jsonb END) layer,
                       jsonb_array_elements(CASE WHEN jsonb_typeof(layer.value->'steps') = 'array' THEN layer.value->'steps' ELSE '[]'::jsonb END) step,
                       jsonb_array_elements_text(CASE WHEN step->>'type' = 'ai_step' AND jsonb_typeof(step->'skillIds') = 'array' THEN step->'skillIds' ELSE '[]'::jsonb END) s
                 WHERE a.organization_id IS NOT DISTINCT FROM $1 AND s = ANY($2::text[])
             ) u GROUP BY skill_id`,
            [orgId || null, ids],
        );
        for (const r of autoCounts || []) if (out[r.skill_id]) out[r.skill_id].automations = Number(r.n) || 0;
    } catch (err) {
        if (!/relation .*automations.* does not exist/i.test(err.message)) throw err;
        // No automations table on this install: the automations column of every
        // row in this summary is UNKNOWN, not zero. Say so per row rather than
        // letting the list print "not linked yet" off a count nobody made.
        for (const id of ids) out[id].automationsUnchecked = true;
    }

    const lastUsed = await getAll(`SELECT id, last_used_at FROM skills WHERE id = ANY($1::text[])`, [ids]);
    for (const r of lastUsed || []) if (out[r.id]) out[r.id].lastUsedAt = r.last_used_at ? new Date(r.last_used_at).toISOString() : null;
    return out;
}

module.exports = { listSkillUsage, getUsageSummary };
