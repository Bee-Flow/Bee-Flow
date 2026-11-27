// @typecheck strict
'use strict';
/**
 * The automation module's part of "where is a skill used?" (stores/skill/usage.js asks for it
 * by name): the automation AI steps that apply a skill (`ai_step.skillIds`, Track R2), root
 * steps and steps inside `definition_json.layers.<key>.steps`.
 */

/** @typedef {(sql: string, params?: unknown[]) => Promise<any[]>} GetAll */

/**
 * Which automation AI steps apply this skill, scoped to the skill's own organisation.
 * @param {GetAll} getAll
 * @param {string} skillId
 * @param {string | null | undefined} orgId
 */
async function stepsUsingSkill(getAll, skillId, orgId) {
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
 * Per skill, how many distinct automations apply it: rows `{ skill_id, n }`.
 * @param {GetAll} getAll
 * @param {string | null | undefined} orgId
 * @param {string[]} ids
 */
async function automationCountsBySkill(getAll, orgId, ids) {
    return getAll(
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
}

module.exports = { stepsUsingSkill, automationCountsBySkill };
