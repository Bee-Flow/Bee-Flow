// @typecheck
/**
 * Skill Store — PostgreSQL-backed reusable instruction pack management.
 *
 * Skills are scoped to an organization. A skill can be:
 *   - personal (visible only to the creator)
 *   - shared with the whole org (is_shared=true, shared_groups=[])
 *   - shared with specific groups (is_shared=true, shared_groups=["g1","g2"])
 *
 * ── STRUCTURE NEXT TO TEXT (Bee Flow Builder redesign, Sep 2026, S1) ──
 * The Studio edits `steps` / `rules_v2` / `examples_v2` / `output_schema`;
 * the runtime and GitHub sync read `workflow` / `rules` / `examples`. Both
 * are stored, and core/skills/skillStructure.js `resolveBodyWrite` decides
 * per facet which one a request is the source of:
 *   - structure sent → text regenerated from it;
 *   - text only sent → text stored as-is AND parsed into structure;
 *   - neither sent   → facet untouched. NEVER regenerate text from stored
 *     structure on a request that did not send it (mobile sends text only).
 * A string in a structured column is a 400 (SkillStructureError), not a
 * silent parse.
 *
 * `steps` / `rules_v2` / `examples_v2` are NULL until the one-time parse in
 * migrations/skills-structured-fields.js has visited the row (it runs from
 * initDB, idempotent), and `[]` afterwards; mapRow presents both as [].
 *
 * `version` bumps on every save that changes content (name, description,
 * instructions, any facet, output schema, KB / automation grants) — not on
 * a sharing or icon change, and not on a save that changes nothing.
 *
 * Editing: the owner, OR anyone holding `manage_skills` in the skill's own
 * organisation (`managerOrgId`). The route proves the permission; the store
 * only ever widens to the CALLER'S organisation, so a manager of org A can
 * never touch org B's skill through this path.
 *
 * ── PROJECTS AND SOLUTION STAGES ──
 * `project_id` files a skill into a project (soft reference, like agents).
 * A skill filed into a Solution STAGE project (UAT / PRD) is MANAGED: it is
 * changed in Dev and deployed. `updateSkill` and `deleteSkill` refuse it with
 * 409 `managed_part` unless only sharing changes or the caller holds a
 * deployment's capability (`opts.managedWrite`, stores/lib/managedParts.js);
 * filing into or out of a stage needs the capability too. The deploy writes
 * through `writeManagedSkill` on its own transaction. A stage skill is never
 * pushed to GitHub sync: Dev is its source.
 */

const crypto = require('crypto');
const { run, getOne } = require('../db');
const { buildUpdate } = require('./lib/sqlBuilder');
const managedParts = require('./managedPartsDefault');
const {
    resolveBodyWrite,
    validateOutputSchema,
    validateIdList,
} = require('../utils/skillStructure');
const log = require('../telemetry/log');
// The store is split by concern under stores/skill/; this file keeps create,
// update and delete, and re-exports the rest under the names it always had.
const { initDB, TEST_RUNS_KEEP } = require('./skill/schema');
const { SKILL_COLUMNS, mapRow } = require('./skill/rows');
const { getAvailableSkills, getSkill, getSkillScope, getSkillsByIds, canEditSkill } = require('./skill/reads');
const { listProjectSkills, countProjectSkills, setSkillProject, clearProjectFromSkills, writeManagedSkill } = require('./skill/projects');
const { listSkillUsage, getUsageSummary } = require('./skill/usage');
const { recordTestRun, listTestRuns, getLastTestBySkillIds, TEST_STATUSES } = require('./skill/testRuns');

// ── GitHub Sync hook (fire-and-forget) ───────────────────────────
// A skill in a Solution stage project is a deployed copy of a Dev skill: Dev
// is what syncs, so the stage copy never becomes a pending GitHub change.
async function _notifySkillSync(orgId, skillId, action = 'pending', projectId = null) {
    if (!orgId) return;
    try {
        if (projectId && await managedParts.managedInfo(projectId)) return;
        const syncStore = require('./githubSyncStore');
        const config = await syncStore.getOrgSyncConfig(orgId);
        if (!config) return;
        if (action === 'deleted') {
            await syncStore.markDeleted(orgId, 'skill', skillId);
        } else {
            await syncStore.markPending(orgId, 'skill', skillId);
        }
        // When auto-sync is enabled, push the change to GitHub (debounced).
        if (config.autoSync === true) {
            require('../services/githubSyncService').autoSyncResource(orgId, 'skill', skillId, action);
        }
    } catch (e) { /* non-fatal */ }
}

/** Keep the last N test runs per skill (plan S1). */

// ── CRUD ─────────────────────────────────────────

/**
 * Create a new skill. Text fields and/or structured fields; see the
 * precedence rule in the module header. Throws SkillStructureError (400)
 * on a malformed structured field.
 */
async function createSkill({
    orgId, userId, name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation,
    sharedGroups, automationId, enabledIntegrations,
    steps, rulesV2, examplesV2, outputSchema, knowledgeBaseIds, allowedAutomationIds,
}) {
    await initDB();
    const id = crypto.randomUUID();
    const groupsJson = JSON.stringify(Array.isArray(sharedGroups) ? sharedGroups : []);
    const integrationsJson = JSON.stringify(Array.isArray(enabledIntegrations) ? enabledIntegrations : []);
    const linkedAutomationId = automationId || null;

    const body = resolveBodyWrite({ workflow, rules, examples, steps, rulesV2, examplesV2 });
    const cleanSteps = body.steps ?? [];
    const cleanRules = body.rulesV2 ?? [];
    const cleanExamples = body.examplesV2 ?? [];
    const cleanSchema = validateOutputSchema(outputSchema);
    const kbIds = validateIdList(knowledgeBaseIds, 'knowledgeBaseIds');
    const autoIds = validateIdList(allowedAutomationIds, 'allowedAutomationIds');

    await run(
        `INSERT INTO skills (id, org_id, user_id, name, description, instructions, workflow, rules, examples, icon, is_shared, dynamic_activation, shared_groups, automation_id, enabled_integrations,
                             steps, rules_v2, examples_v2, output_schema, knowledge_base_ids, allowed_automation_ids, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, 1)`,
        [id, orgId, userId, name, description || '', instructions || '', body.workflow ?? '', body.rules ?? '', body.examples ?? '', icon || '⚡', isShared === true, dynamicActivation === true, groupsJson, linkedAutomationId, integrationsJson,
            JSON.stringify(cleanSteps), JSON.stringify(cleanRules), JSON.stringify(cleanExamples), cleanSchema === null ? null : JSON.stringify(cleanSchema), JSON.stringify(kbIds), JSON.stringify(autoIds)]
    );
    log.info(`[SkillStore] Created skill "${name}" for org ${orgId}${linkedAutomationId ? ` (linked automation ${linkedAutomationId})` : ''}`);
    _notifySkillSync(orgId, id);
    const now = new Date().toISOString();
    return {
        id, orgId, userId, name, description: description || '', instructions: instructions || '',
        workflow: body.workflow ?? '', rules: body.rules ?? '', examples: body.examples ?? '',
        icon: icon || '⚡', isShared: isShared === true, dynamicActivation: dynamicActivation === true,
        sharedGroups: Array.isArray(sharedGroups) ? sharedGroups : [],
        automationId: linkedAutomationId,
        enabledIntegrations: Array.isArray(enabledIntegrations) ? enabledIntegrations : [],
        steps: cleanSteps, rulesV2: cleanRules, examplesV2: cleanExamples,
        outputSchema: cleanSchema, knowledgeBaseIds: kbIds, allowedAutomationIds: autoIds,
        projectId: null, version: 1, lastUsedAt: null,
        createdAt: now, updatedAt: now,
    };
}

// Resolve the user's group IDs (used for sharedGroups visibility checks).

// Fields whose change bumps `version`.
const CONTENT_TEXT_FIELDS = ['name', 'description', 'instructions', 'workflow', 'rules', 'examples'];

/** JSON with object keys sorted: Postgres JSONB reorders keys on the way back. */
function _stableJson(v) {
    if (v === undefined || v === null) return 'null';
    if (Array.isArray(v)) return `[${v.map(_stableJson).join(',')}]`;
    if (typeof v === 'object' && !(v instanceof Date)) {
        return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
            .map((k) => `${JSON.stringify(k)}:${_stableJson(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
}

/** Same JSON value, independent of object key order. */
function _sameJson(a, b) {
    return _stableJson(a) === _stableJson(b);
}

/**
 * The managed-part allow-list names a skill's on/off-for-others switch
 * `visibility` (stores/lib/managedParts.js ALLOWED.skill); here it is
 * `isShared`. `sharedGroups` is the same word on both sides.
 */
const SKILL_GUARD_KEYS = Object.freeze({ isShared: 'visibility' });

/** null, undefined and '' are one value for the managed-write diff. */
const _blankToNull = (v) => (v === undefined || v === null || v === '' ? null : v);

/** The keys of `write` whose value differs from the stored (mapped) skill. */
function _changedSkillKeys(cur, write) {
    return Object.keys(write).filter((k) => {
        if (k === 'isShared' || k === 'dynamicActivation') return (cur[k] === true) !== (write[k] === true);
        return !_sameJson(_blankToNull(cur[k]), _blankToNull(write[k]));
    });
}

/**
 * Update a skill.
 *
 * @param {string} id
 * @param {string} userId  the caller
 * @param {any} updates camelCase fields; `undefined` = leave as-is. Text
 *        facets and structured facets follow the precedence rule.
 * @param {{ managerOrgId?: string|null, managedWrite?: { deploymentId?: string }|null }} [opts]
 *        `managerOrgId`: the CALLER'S organisation, passed only when the
 *        route has verified `manage_skills`. Widens the WHERE from "owner"
 *        to "owner OR a skill of that organisation". Cross-org is refused
 *        by construction: a skill of another org never matches.
 *        `managedWrite`: a deployment's capability, for a skill in a stage.
 * @returns {Promise<boolean>} true when a row was updated
 * @throws SkillStructureError (status 400) on a malformed structured field
 * @throws 409 managed_part when a stage skill would change more than its sharing
 */
async function updateSkill(id, userId, updates, opts = {}) {
    await initDB();
    const managerOrgId = opts.managerOrgId || null;

    // Precedence rule + validation FIRST, so a 400 never reaches the database.
    const body = resolveBodyWrite({
        workflow: updates.workflow, rules: updates.rules, examples: updates.examples,
        steps: updates.steps, rulesV2: updates.rulesV2, examplesV2: updates.examplesV2,
    });
    const hasSchema = updates.outputSchema !== undefined;
    const cleanSchema = hasSchema ? validateOutputSchema(updates.outputSchema) : undefined;
    const kbIds = updates.knowledgeBaseIds !== undefined ? validateIdList(updates.knowledgeBaseIds, 'knowledgeBaseIds') : undefined;
    const autoIds = updates.allowedAutomationIds !== undefined ? validateIdList(updates.allowedAutomationIds, 'allowedAutomationIds') : undefined;

    // The current row: for the version bump (only on a real content change)
    // and so a text-only write can be compared facet by facet.
    const current = await getOne(
        managerOrgId
            ? `SELECT * FROM skills WHERE id = $1 AND (user_id = $2 OR (org_id IS NOT NULL AND org_id = $3))`
            : `SELECT * FROM skills WHERE id = $1 AND user_id = $2`,
        managerOrgId ? [id, userId, managerOrgId] : [id, userId],
    );
    if (!current) return false;
    const cur = mapRow(current);

    // What to write is decided first and only then turned into SQL: the version
    // bump hangs on `contentChanged`, which is not known until every facet has
    // been compared against the stored row.
    const write = {};
    let contentChanged = false;

    for (const field of ['name', 'description', 'instructions', 'icon']) {
        if (updates[field] !== undefined) {
            write[field] = updates[field];
            if (CONTENT_TEXT_FIELDS.includes(field) && (cur[field] || '') !== (updates[field] || '')) contentChanged = true;
        }
    }
    const facets = [['workflow', 'steps'], ['rules', 'rulesV2'], ['examples', 'examplesV2']];
    for (const [textField, key] of facets) {
        if (body[textField] === undefined) continue;
        const textSent = updates[textField] !== undefined && updates[key] === undefined;
        // A text-only writer (mobile's full-snapshot PUT) that sends the SAME
        // text the row already holds must not replace the structure with a
        // fresh parse: that would mint new step ids and drop the refs the
        // Studio attached. Unchanged text = facet untouched.
        if (textSent && (cur[textField] || '') === (body[textField] || '')) continue;
        write[textField] = body[textField];
        write[key] = body[key];
        if ((cur[textField] || '') !== (body[textField] || '') || !_sameJson(cur[key], body[key])) contentChanged = true;
    }
    if (hasSchema) {
        write.outputSchema = cleanSchema;
        if (!_sameJson(cur.outputSchema, cleanSchema)) contentChanged = true;
    }
    if (kbIds !== undefined) {
        write.knowledgeBaseIds = kbIds;
        if (!_sameJson(cur.knowledgeBaseIds, kbIds)) contentChanged = true;
    }
    if (autoIds !== undefined) {
        write.allowedAutomationIds = autoIds;
        if (!_sameJson(cur.allowedAutomationIds, autoIds)) contentChanged = true;
    }
    if (updates.isShared !== undefined) write.isShared = updates.isShared;
    if (updates.dynamicActivation !== undefined) write.dynamicActivation = updates.dynamicActivation;
    if (updates.sharedGroups !== undefined) write.sharedGroups = updates.sharedGroups;
    if (updates.automationId !== undefined) {
        write.automationId = updates.automationId;
        if ((cur.automationId || null) !== (updates.automationId || null)) contentChanged = true;
    }
    if (updates.enabledIntegrations !== undefined) write.enabledIntegrations = updates.enabledIntegrations;

    // A skill in a Solution stage: only its sharing may change without a
    // deploy. Judged on what actually CHANGES, because mobile and the Studio
    // send the whole skill back on every save.
    if (cur.projectId) {
        const changed = _changedSkillKeys(cur, write);
        if (changed.length > 0) {
            await managedParts.assertManagedWrite({
                kind: 'skill', projectId: cur.projectId, managedWrite: opts.managedWrite || null,
                changedKeys: changed.map(k => SKILL_GUARD_KEYS[k] || k),
            });
        }
    }

    const built = buildUpdate({
        table: 'skills',
        updates: write,
        columnMap: SKILL_COLUMNS,
        extraSet: contentChanged ? ['version = version + 1', 'updated_at = NOW()'] : ['updated_at = NOW()'],
    });
    if (!built) return false;

    // The manager WHERE is a disjunction, which the builder does not model; its
    // placeholders continue where the SET clause left off.
    const params = built.params;
    let idx = params.length + 1;
    let where;
    if (managerOrgId) {
        where = `WHERE id = $${idx++} AND (user_id = $${idx++} OR (org_id IS NOT NULL AND org_id = $${idx++}))`;
        params.push(id, userId, managerOrgId);
    } else {
        where = `WHERE id = $${idx++} AND user_id = $${idx++}`;
        params.push(id, userId);
    }
    const { rowCount } = await run(`${built.sql} ${where}`, params);
    if (rowCount > 0 && cur.orgId) _notifySkillSync(cur.orgId, id, 'pending', cur.projectId);
    return rowCount > 0;
}

/**
 * Delete a skill (owner only, or admin via isAdmin flag).
 *
 * A skill in a Solution stage is deleted only by a deployment (its
 * capability in `opts.managedWrite`): 409 managed_part otherwise. Checked
 * only for a caller who could delete it at all, so a stranger still reads
 * "not found" rather than learning which Solution holds the skill.
 *
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 */
async function deleteSkill(id, userId, isAdmin = false, opts = {}) {
    await initDB();
    // Grab org_id before deleting for sync notification
    const skill = await getOne('SELECT org_id, user_id, project_id FROM skills WHERE id = $1', [id]);
    if (skill?.project_id && (isAdmin || skill.user_id === userId)) {
        await managedParts.assertManagedWrite({
            kind: 'skill', projectId: skill.project_id, changedKeys: ['delete'], managedWrite: opts.managedWrite || null,
        });
    }
    let result;
    if (isAdmin) {
        result = await run('DELETE FROM skills WHERE id = $1', [id]);
    } else {
        result = await run('DELETE FROM skills WHERE id = $1 AND user_id = $2', [id, userId]);
    }
    if (result.rowCount > 0) {
        try { await run('DELETE FROM skill_test_runs WHERE skill_id = $1', [id]); } catch (_) { /* non-fatal */ }
        try { await run('DELETE FROM skill_activations WHERE skill_id = $1', [id]); } catch (_) { /* table may not exist yet */ }
    }
    if (result.rowCount > 0 && skill?.org_id) _notifySkillSync(skill.org_id, id, 'deleted', skill.project_id || null);
    return result.rowCount > 0;
}

module.exports = {
    createSkill,
    getAvailableSkills,
    getSkill,
    getSkillScope,
    getSkillsByIds,
    updateSkill,
    deleteSkill,
    canEditSkill,
    listProjectSkills,
    countProjectSkills,
    setSkillProject,
    clearProjectFromSkills,
    writeManagedSkill,
    _notifySkillSync,
    listSkillUsage,
    getUsageSummary,
    recordTestRun,
    listTestRuns,
    getLastTestBySkillIds,
    TEST_RUNS_KEEP,
    TEST_STATUSES,
    mapRow,
    // Awaitable init entry for migrateDb (memoised: the same promise as the load-time init).
    initDB,
};
