// @typecheck
'use strict';
/**
 * Reading skills: who may see which (personal, org-wide, group-shared), who
 * may edit, and the readers built on that (../skillStore.js re-exports them).
 */

const { getOne, getAll } = require('../../db');
const userStore = require('../userStore');
const { initDB } = require('./schema');
const { mapRow } = require('./rows');
const { getLastTestBySkillIds } = require('./testRuns');

/**
 * @param {string} userId
 */
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
/**
 * @param {string} userId
 * @param {number} nextParamIdx
 */
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
 * @param {string} userId
 */
function canEditSkill(skill, userId, { orgId = null, canManage = false } = {}) {
    if (!skill || !userId || canManage !== true) return false;
    if (skill.userId === userId) return true;
    return !!skill.orgId && !!orgId && skill.orgId === orgId;
}

/**
 * Attach per-row view fields (`canEdit`) for a viewer.
 * @param {string} userId
 * @param {{ orgId: string | null; canManage: boolean; } | null} viewer
 */
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
 * @param {string} userId
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
 * @param {string} userId
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

module.exports = { getAvailableSkills, getSkill, getSkillScope, getSkillsByIds, canEditSkill };
