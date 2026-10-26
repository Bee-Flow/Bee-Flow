// @typecheck
'use strict';
/**
 * Skills filed into projects: the project listing and counts, filing and
 * unfiling, and the deployment path that writes a MANAGED skill into a
 * Solution stage project (see ../skillStore.js on managed parts).
 */

const crypto = require('crypto');
const { run, getOne, getAll } = require('../../db');
const { buildUpdate } = require('../lib/sqlBuilder');
const managedParts = require('../managedPartsDefault');
const log = require('../../telemetry/log');
const { initDB } = require('./schema');
const { SKILL_COLUMNS, mapRow } = require('./rows');
const { resolveBodyWrite, validateOutputSchema, validateIdList } = require('../../utils/skillStructure');

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
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number | null }> }} client
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

module.exports = { listProjectSkills, countProjectSkills, setSkillProject, clearProjectFromSkills, writeManagedSkill };
