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
const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');
const { buildUpdate } = require('./lib/sqlBuilder');
const userStore = require('./userStore');
const managedParts = require('./lib/managedParts');
const {
    resolveBodyWrite,
    validateOutputSchema,
    validateIdList,
} = require('../utils/skillStructure');
const log = require('../telemetry/log');

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
const TEST_RUNS_KEEP = 20;

const initDB = makeStoreInit('SkillStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS skills (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            workflow TEXT DEFAULT '',
            rules TEXT DEFAULT '',
            examples TEXT DEFAULT '',
            icon TEXT DEFAULT '⚡',
            is_shared BOOLEAN DEFAULT false,
            dynamic_activation BOOLEAN DEFAULT false,
            shared_groups TEXT DEFAULT '[]',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE skills ADD COLUMN IF NOT EXISTS dynamic_activation BOOLEAN DEFAULT false;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS shared_groups TEXT DEFAULT '[]';
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS automation_id TEXT DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS enabled_integrations TEXT DEFAULT '[]';

        -- Structured fields (S1). Same statements as migrations/skills-structured-fields.js:
        -- either side may run first on a rolling deploy.
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS steps JSONB DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS rules_v2 JSONB DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS examples_v2 JSONB DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS knowledge_base_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS allowed_automation_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS output_schema JSONB DEFAULT NULL;
        -- The project a skill is filed into (soft reference; a Solution stage
        -- project makes it a managed part).
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS project_id TEXT DEFAULT NULL;

        CREATE INDEX IF NOT EXISTS idx_skills_org ON skills(org_id);
        CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id);
        CREATE INDEX IF NOT EXISTS idx_skills_created ON skills(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_skills_project ON skills(project_id) WHERE project_id IS NOT NULL;

        -- Test-tab results (S3 writes, S1 owns): the last ${TEST_RUNS_KEEP} per skill.
        CREATE TABLE IF NOT EXISTS skill_test_runs (
            id TEXT PRIMARY KEY,
            skill_id TEXT NOT NULL,
            agent_id TEXT,
            question TEXT NOT NULL DEFAULT '',
            results JSONB NOT NULL DEFAULT '[]'::jsonb,
            status TEXT NOT NULL DEFAULT 'ok',
            advice TEXT,
            ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_skill_test_runs_skill ON skill_test_runs(skill_id, ran_at DESC);
    `);

    // Personal skills: a user without an organisation owns skills directly
    // (org_id NULL, scoped to user_id — the same model owner-owned KBs use).
    // Drop the original NOT NULL so org-less accounts can create skills.
    // DROP NOT NULL is zelf idempotent; via runDdl is elke fout hier dus een
    // échte en wordt hij luid gerapporteerd i.p.v. stil ingeslikt.
    await runDdl('skillStore', [
        `ALTER TABLE skills ALTER COLUMN org_id DROP NOT NULL`,
    ]);
    log.info('[SkillStore] PostgreSQL initialized');

    // One-time parse of the free text into structure. Idempotent (only NULL
    // facets), so it costs one SELECT per boot once applied. Registered here
    // — the house pattern of automationStore/core.js — so it can never be
    // forgotten in a boot list.
    setImmediate(() => {
        require('../migrations/skills-structured-fields').up().catch(err =>
            log.warn('[SkillStore] skills-structured-fields migration error:', err.message));
    });
}

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
async function _getUserGroupIds(userId) {
    if (!userId) return [];
    try {
        const user = await userStore.getUser(userId);
        if (!user) return [];
        if (Array.isArray(user.groups)) return user.groups;
        try { return JSON.parse(user.groups || '[]'); } catch (_) { return []; }
    } catch (_) {
        return [];
    }
}

// Build the shared visibility WHERE fragment + params for a single user.
//   "skill is owned by user, OR (is_shared AND (no group restriction OR user is in one of the groups))"
// Returns { sql, params } where the params slot in starting at `nextParamIdx`.
function _buildVisibilityClause(userId, userGroups, nextParamIdx) {
    const params = [userId];
    let userIdx = nextParamIdx;
    let sql = `(user_id = $${userIdx}`;
    sql += ` OR (is_shared = true AND (shared_groups IS NULL OR shared_groups = '' OR shared_groups = '[]'`;
    if (userGroups && userGroups.length > 0) {
        const groupParams = userGroups.map((_, i) => `$${userIdx + 1 + i}`);
        sql += ` OR shared_groups::jsonb ?| array[${groupParams.join(', ')}]`;
        params.push(...userGroups);
    }
    sql += `)))`;
    return { sql, params };
}

/**
 * May `userId` edit this (mapped) skill? Owner, or — when the viewer holds
 * manage_skills (`canManage`) — any skill of the viewer's own organisation.
 * Pure: the route decides `canManage`, the store never guesses a permission.
 */
function canEditSkill(skill, userId, { orgId = null, canManage = false } = {}) {
    if (!skill || !userId || canManage !== true) return false;
    if (skill.userId === userId) return true;
    return !!skill.orgId && !!orgId && skill.orgId === orgId;
}

/** Attach per-row view fields (`canEdit`) for a viewer. */
function _withViewer(rows, userId, viewer) {
    if (!viewer) return rows;
    return rows.map(s => ({ ...s, canEdit: canEditSkill(s, userId, viewer) }));
}

/**
 * Get all skills available to a user: their own personal (org-less) skills,
 * plus — when they belong to an org — the org skills visible to them.
 *
 * @param {string|null} orgId
 * @param {string} userId
 * @param {{ canManage?: boolean, withLastTest?: boolean }} [viewer]
 *        when given, rows carry `canEdit`; `withLastTest` adds `lastTest`
 *        `{status, adviceCount, ranAt} | null` from skill_test_runs.
 */
async function getAvailableSkills(orgId, userId, viewer = null) {
    await initDB();
    let rows;
    if (!orgId) {
        // Org-less user → only their personal skills.
        rows = await getAll(
            `SELECT * FROM skills WHERE org_id IS NULL AND user_id = $1 ORDER BY created_at DESC`,
            [userId]
        );
    } else {
        const userGroups = await _getUserGroupIds(userId);
        // $1 = orgId, $2 = userId (personal), visibility clause starts at $3
        const { sql: visSql, params: visParams } = _buildVisibilityClause(userId, userGroups, 3);
        rows = await getAll(
            `SELECT * FROM skills
             WHERE (org_id = $1 AND ${visSql}) OR (org_id IS NULL AND user_id = $2)
             ORDER BY created_at DESC`,
            [orgId, userId, ...visParams]
        );
    }
    let skills = _withViewer(rows.map(mapRow), userId, viewer ? { orgId, canManage: viewer.canManage === true } : null);
    if (viewer?.withLastTest && skills.length > 0) {
        const lastTest = await getLastTestBySkillIds(skills.map(s => s.id));
        skills = skills.map(s => ({ ...s, lastTest: lastTest[s.id] || null }));
    }
    return skills;
}

/**
 * Get a single skill by ID (with access check). Personal skills (org_id NULL)
 * are visible only to their owner.
 * @param {{ canManage?: boolean }} [viewer] when given, the row carries `canEdit`.
 */
async function getSkill(id, orgId, userId, viewer = null) {
    await initDB();
    let r;
    if (!orgId) {
        r = await getOne(
            `SELECT * FROM skills WHERE id = $1 AND org_id IS NULL AND user_id = $2`,
            [id, userId]
        );
    } else {
        const userGroups = await _getUserGroupIds(userId);
        // $1 = id, $2 = orgId, $3 = userId (personal), visibility clause starts at $4
        const { sql: visSql, params: visParams } = _buildVisibilityClause(userId, userGroups, 4);
        r = await getOne(
            `SELECT * FROM skills WHERE id = $1 AND ((org_id = $2 AND ${visSql}) OR (org_id IS NULL AND user_id = $3))`,
            [id, orgId, userId, ...visParams]
        );
    }
    if (!r) return null;
    const skill = mapRow(r);
    return viewer ? { ...skill, canEdit: canEditSkill(skill, userId, { orgId, canManage: viewer.canManage === true }) } : skill;
}

/**
 * Get the org + owner of a skill WITHOUT any per-user visibility check.
 *
 * Used by validateAgentConfigReferences: the agent-config anti-leak invariant
 * needs "which org does this skill belong to, and who owns it" — NOT "can this
 * exact user see it in their picker". (getSkill's visibility clause wrongly
 * rejected same-org skills created by a different member.)
 *
 * @returns {Promise<{org_id:string|null, user_id:string}|null>} or null if missing.
 */
async function getSkillScope(id) {
    await initDB();
    if (!id) return null;
    const r = await getOne('SELECT org_id, user_id FROM skills WHERE id = $1', [id]);
    return r ? { org_id: r.org_id || null, user_id: r.user_id } : null;
}

/**
 * Get multiple skills by IDs (for chat injection). Includes the user's personal
 * skills so an org-less agent's attached skills still resolve at chat time.
 */
async function getSkillsByIds(ids, orgId, userId) {
    await initDB();
    if (!ids || ids.length === 0) return [];
    if (!orgId) {
        const placeholders = ids.map((_, i) => `$${2 + i}`).join(', ');
        const rows = await getAll(
            `SELECT * FROM skills WHERE org_id IS NULL AND user_id = $1 AND id IN (${placeholders})`,
            [userId, ...ids]
        );
        return rows.map(mapRow);
    }
    const userGroups = await _getUserGroupIds(userId);
    // $1 = orgId, $2 = userId (personal), visibility clause starts at $3, then IN-list
    const { sql: visSql, params: visParams } = _buildVisibilityClause(userId, userGroups, 3);
    const baseParamCount = 2 + visParams.length; // orgId + userId + visibility params
    const placeholders = ids.map((_, i) => `$${baseParamCount + 1 + i}`).join(', ');
    const rows = await getAll(
        `SELECT * FROM skills
         WHERE ((org_id = $1 AND ${visSql}) OR (org_id IS NULL AND user_id = $2)) AND id IN (${placeholders})`,
        [orgId, userId, ...visParams, ...ids]
    );
    return rows.map(mapRow);
}

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
 * The writable columns of a skill. A text facet and its structured twin are
 * always written together — resolveBodyWrite never produces one without the
 * other — so they sit next to each other here too.
 */
const SKILL_COLUMNS = {
    name: 'name',
    description: 'description',
    instructions: 'instructions',
    icon: 'icon',
    workflow: 'workflow',
    steps: { col: 'steps', cast: 'jsonb', transform: v => JSON.stringify(v) },
    rules: 'rules',
    rulesV2: { col: 'rules_v2', cast: 'jsonb', transform: v => JSON.stringify(v) },
    examples: 'examples',
    examplesV2: { col: 'examples_v2', cast: 'jsonb', transform: v => JSON.stringify(v) },
    outputSchema: { col: 'output_schema', cast: 'jsonb', transform: v => (v === null ? null : JSON.stringify(v)) },
    knowledgeBaseIds: { col: 'knowledge_base_ids', cast: 'jsonb', transform: v => JSON.stringify(v) },
    allowedAutomationIds: { col: 'allowed_automation_ids', cast: 'jsonb', transform: v => JSON.stringify(v) },
    isShared: { col: 'is_shared', transform: v => v === true },
    dynamicActivation: { col: 'dynamic_activation', transform: v => v === true },
    sharedGroups: { col: 'shared_groups', transform: v => JSON.stringify(Array.isArray(v) ? v : []) },
    automationId: { col: 'automation_id', transform: v => v || null },
    enabledIntegrations: { col: 'enabled_integrations', transform: v => JSON.stringify(Array.isArray(v) ? v : []) },
};

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
 * @param {Object} updates camelCase fields; `undefined` = leave as-is. Text
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

// ── Projects ─────────────────────────────────────────────────────

/**
 * Refuse filing into or out of a Solution stage project without a
 * deployment's capability. `projectIds` are the source and the target; a
 * null (no project) is skipped.
 */
async function _assertStageFiling(projectIds, managedWrite) {
    for (const projectId of new Set(projectIds.filter(Boolean))) {
        await managedParts.assertManagedWrite({ kind: 'skill', projectId, changedKeys: ['projectId'], managedWrite: managedWrite || null });
    }
}

/**
 * The skills filed into one project, in a narrow projection: a project member
 * sees WHICH skills the project holds; the instructions and grants stay behind
 * the skills routes and their own checks.
 */
async function listProjectSkills(projectId) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT id, name, description, icon, user_id, project_id, updated_at
           FROM skills WHERE project_id = $1 ORDER BY updated_at DESC`,
        [projectId],
    );
    return (rows || []).map(r => ({
        id: r.id,
        name: r.name,
        description: r.description || '',
        icon: r.icon || '⚡',
        ownerId: r.user_id,
        projectId: r.project_id || null,
        updatedAt: r.updated_at,
    }));
}

/** How many skills each of these projects holds: ONE query, Map(projectId → n). */
async function countProjectSkills(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM skills
          WHERE project_id = ANY($1) GROUP BY project_id`,
        [ids],
    );
    return new Map((rows || []).map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * File a skill into a project, or take it out (`projectId = null`). Owner
 * only, matched in the WHERE clause. Moving into or out of a Solution stage
 * project needs a deployment's capability (`opts.managedWrite`): 409
 * managed_part otherwise. `version` is not bumped: filing changes no content.
 *
 * @param {string} id
 * @param {string} userId
 * @param {string|null} projectId
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 * @returns {Promise<boolean>}
 */
async function setSkillProject(id, userId, projectId, opts = {}) {
    await initDB();
    if (!id || !userId) return false;
    const row = await getOne('SELECT project_id FROM skills WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!row) return false;
    const target = projectId || null;
    if ((row.project_id || null) === target) return true;
    await _assertStageFiling([row.project_id, target], opts.managedWrite);
    const { rowCount } = await run(
        'UPDATE skills SET project_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [target, id, userId],
    );
    return rowCount > 0;
}

/**
 * Detach every skill from a deleted project (soft reference: the skills
 * survive their project). A stage project's skills are detached only with a
 * deployment's capability (a `remove` deployment's teardown).
 *
 * @param {string} projectId
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 * @returns {Promise<number>}
 */
async function clearProjectFromSkills(projectId, opts = {}) {
    await initDB();
    if (!projectId) return 0;
    await _assertStageFiling([projectId], opts.managedWrite);
    const { rowCount } = await run('UPDATE skills SET project_id = NULL WHERE project_id = $1', [projectId]);
    return rowCount;
}

/**
 * The deploy's writer of a skill in a Solution stage: insert or update one
 * row on the caller's transaction (`client`), owned by `ownerId` (the stage's
 * run-as user) in `orgId`, filed into the stage project. Requires the
 * capability of a deployment that is active for exactly that stage project,
 * read on the same client, so a deployment row of the same transaction counts.
 *
 * `fields` follows the precedence rule of the module header; on an update a
 * key left out keeps its value. Sharing is never carried: a new stage skill
 * starts unshared, an existing one keeps its sharing. No GitHub sync: Dev is
 * the source.
 *
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }} client
 * @param {{ id?: string|null, ownerId: string, orgId: string|null, projectId: string,
 *           fields?: Record<string, any>, managedWrite: { deploymentId?: string }|null }} args
 * @returns {Promise<ReturnType<typeof mapRow>>}
 */
async function writeManagedSkill(client, { id = null, ownerId, orgId, projectId, fields = {}, managedWrite }) {
    await initDB();
    if (!client || typeof client.query !== 'function') throw new TypeError('writeManagedSkill: a transaction client is required.');
    if (typeof projectId !== 'string' || !projectId) throw new TypeError('writeManagedSkill: projectId is required.');
    if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('writeManagedSkill: ownerId is required.');
    if (!(await managedParts.hasCapability({ managedWrite, projectId, client }))) {
        throw managedParts.managedPartError(await managedParts.managedInfo(projectId));
    }

    const f = fields || {};
    const body = resolveBodyWrite({
        workflow: f.workflow, rules: f.rules, examples: f.examples, steps: f.steps, rulesV2: f.rulesV2, examplesV2: f.examplesV2,
    });
    const write = {};
    for (const k of ['name', 'description', 'instructions', 'icon', 'dynamicActivation', 'automationId', 'enabledIntegrations']) {
        if (f[k] !== undefined) write[k] = f[k];
    }
    for (const k of ['workflow', 'steps', 'rules', 'rulesV2', 'examples', 'examplesV2']) {
        if (body[k] !== undefined) write[k] = body[k];
    }
    if (f.outputSchema !== undefined) write.outputSchema = validateOutputSchema(f.outputSchema);
    if (f.knowledgeBaseIds !== undefined) write.knowledgeBaseIds = validateIdList(f.knowledgeBaseIds, 'knowledgeBaseIds');
    if (f.allowedAutomationIds !== undefined) write.allowedAutomationIds = validateIdList(f.allowedAutomationIds, 'allowedAutomationIds');

    const existing = id
        ? (await client.query('SELECT id, project_id FROM skills WHERE id = $1 FOR UPDATE', [id])).rows[0]
        : null;
    if (existing && existing.project_id !== projectId) {
        throw managedParts.storeError(409, 'skill_not_in_stage', 'This skill belongs to another project.', { skillId: id });
    }

    let row;
    if (existing) {
        const built = buildUpdate({
            table: 'skills',
            updates: { ...write, userId: ownerId, orgId: orgId || null },
            columnMap: { ...SKILL_COLUMNS, userId: 'user_id', orgId: 'org_id' },
            extraSet: ['version = version + 1', 'updated_at = NOW()'],
            where: [{ col: 'id', value: id }],
            returning: '*',
        });
        // Never null: owner and organisation are always written.
        row = (await client.query(/** @type {{sql: string}} */ (built).sql, /** @type {{params: any[]}} */ (built).params)).rows[0];
    } else {
        const newId = id || crypto.randomUUID();
        const v = (k, dflt) => (write[k] !== undefined ? write[k] : dflt);
        const kbIds = v('knowledgeBaseIds', []);
        const autoIds = v('allowedAutomationIds', []);
        const schema = v('outputSchema', null);
        row = (await client.query(
            `INSERT INTO skills (id, org_id, user_id, project_id, name, description, instructions, workflow, rules, examples, icon,
                                 is_shared, dynamic_activation, shared_groups, automation_id, enabled_integrations,
                                 steps, rules_v2, examples_v2, output_schema, knowledge_base_ids, allowed_automation_ids, version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, $12, '[]', $13, $14,
                     $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb, 1)
             RETURNING *`,
            [newId, orgId || null, ownerId, projectId, v('name', 'Skill'), v('description', ''), v('instructions', ''),
                v('workflow', ''), v('rules', ''), v('examples', ''), v('icon', '⚡'), v('dynamicActivation', false) === true,
                v('automationId', null) || null, JSON.stringify(Array.isArray(v('enabledIntegrations', [])) ? v('enabledIntegrations', []) : []),
                JSON.stringify(v('steps', [])), JSON.stringify(v('rulesV2', [])), JSON.stringify(v('examplesV2', [])),
                schema === null ? null : JSON.stringify(schema), JSON.stringify(kbIds), JSON.stringify(autoIds)],
        )).rows[0];
    }
    log.info(`[SkillStore] Deployed skill ${row.id} into stage project ${projectId}`);
    return mapRow(row);
}

// ── Usage ("Gebruikt door") ──────────────────────────────────────

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
        lastByAgent = await require('./skillActivations').getLastActivationByAgent(skillId, (agents || []).map(a => a.id));
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

// ── Test runs (S3 writes them; the overview reads `lastTest`) ────

const TEST_STATUSES = Object.freeze(['ok', 'warning', 'error']);

/**
 * Persist one Test-tab run and keep the last TEST_RUNS_KEEP per skill.
 *
 * A status this store does not recognise — or none at all — is stored as
 * `error`, NOT as `ok`. The Test tab reads this row back as a verdict about
 * somebody's skill, and `ok` is the reassuring one: coercing an unknown value
 * to it turns a caller's bug into a green tick nobody earned. The grader
 * itself already narrows the same way (skillTest.parseGrading: an unreported
 * step is `warning`, never `ok`), and this is that rule at the last gate.
 *
 * @param {{ skillId:string, agentId?:string|null, question:string, results:Array<{stepId,title,evidence,status}>, status:'ok'|'warning'|'error', advice?:string|null }} p
 */
async function recordTestRun({ skillId, agentId = null, question = '', results = [], status, advice = null }) {
    await initDB();
    if (!skillId) throw new Error('skillId required');
    const id = crypto.randomUUID();
    let st = status;
    if (!TEST_STATUSES.includes(st)) {
        log.warn(`[skillStore] recordTestRun: unknown status ${JSON.stringify(status)} — stored as "error".`);
        st = 'error';
    }
    const res = Array.isArray(results) ? results : [];
    await run(
        `INSERT INTO skill_test_runs (id, skill_id, agent_id, question, results, status, advice)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [id, skillId, agentId || null, String(question || '').slice(0, 4000), JSON.stringify(res), st, advice ? String(advice).slice(0, 4000) : null],
    );
    await run(
        `DELETE FROM skill_test_runs
          WHERE skill_id = $1
            AND id NOT IN (SELECT id FROM skill_test_runs WHERE skill_id = $1 ORDER BY ran_at DESC LIMIT $2)`,
        [skillId, TEST_RUNS_KEEP],
    );
    return { id, skillId, agentId: agentId || null, question, results: res, status: st, advice: advice || null, ranAt: new Date().toISOString() };
}

function _mapTestRun(r) {
    let results = r.results;
    if (typeof results === 'string') { try { results = JSON.parse(results); } catch (_) { results = []; } }
    if (!Array.isArray(results)) results = [];
    return {
        id: r.id,
        skillId: r.skill_id,
        agentId: r.agent_id || null,
        question: r.question || '',
        results,
        status: r.status || 'ok',
        advice: r.advice || null,
        ranAt: r.ran_at ? new Date(r.ran_at).toISOString() : null,
    };
}

/** Newest first, at most TEST_RUNS_KEEP. */
async function listTestRuns(skillId, limit = TEST_RUNS_KEEP) {
    await initDB();
    if (!skillId) return [];
    const n = Math.max(1, Math.min(TEST_RUNS_KEEP, parseInt(limit, 10) || TEST_RUNS_KEEP));
    const rows = await getAll(
        `SELECT * FROM skill_test_runs WHERE skill_id = $1 ORDER BY ran_at DESC LIMIT $2`,
        [skillId, n],
    );
    return (rows || []).map(_mapTestRun);
}

/** `lastTest` per skill: `{ [skillId]: { status, adviceCount, ranAt } }` (skills never tested are absent). */
async function getLastTestBySkillIds(skillIds) {
    await initDB();
    const ids = [...new Set((Array.isArray(skillIds) ? skillIds : []).filter(Boolean))];
    if (ids.length === 0) return {};
    const rows = await getAll(
        `SELECT DISTINCT ON (skill_id) skill_id, status, advice, results, ran_at
           FROM skill_test_runs
          WHERE skill_id = ANY($1::text[])
          ORDER BY skill_id, ran_at DESC`,
        [ids],
    );
    const out = {};
    for (const r of rows || []) {
        const t = _mapTestRun(r);
        const flagged = t.results.filter(x => x && x.status && x.status !== 'ok').length;
        out[r.skill_id] = {
            status: t.status,
            adviceCount: flagged > 0 ? flagged : (t.advice ? 1 : 0),
            ranAt: t.ranAt,
        };
    }
    return out;
}

// ── Helper ───────────────────────────────────────

function _jsonArray(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined || v === '') return [];
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { return []; } }
    return [];
}

function _jsonObjectOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return null; } }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function mapRow(r) {
    return {
        id: r.id,
        orgId: r.org_id,
        userId: r.user_id,
        name: r.name,
        description: r.description || '',
        instructions: r.instructions || '',
        workflow: r.workflow || '',
        rules: r.rules || '',
        examples: r.examples || '',
        icon: r.icon || '⚡',
        isShared: r.is_shared === true,
        dynamicActivation: r.dynamic_activation === true,
        sharedGroups: _jsonArray(r.shared_groups),
        automationId: r.automation_id || null,
        enabledIntegrations: _jsonArray(r.enabled_integrations),
        // Structured fields (S1). NULL in the DB = not yet parsed; presented as [].
        steps: _jsonArray(r.steps),
        rulesV2: _jsonArray(r.rules_v2),
        examplesV2: _jsonArray(r.examples_v2),
        outputSchema: _jsonObjectOrNull(r.output_schema),
        knowledgeBaseIds: _jsonArray(r.knowledge_base_ids),
        allowedAutomationIds: _jsonArray(r.allowed_automation_ids),
        projectId: r.project_id || null,
        version: Number.isFinite(Number(r.version)) && Number(r.version) > 0 ? Number(r.version) : 1,
        lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
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
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;
