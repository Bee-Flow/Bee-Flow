// @typecheck
'use strict';
/**
 * The smallest group a result may show. Two floors apply: the environment's
 * (AUTOMATION_TABLE_MIN_GROUP_FLOOR) and the organisation's own, stored under
 * `org_<orgId>_automation_table_policy` as { minGroupSize }. The higher wins;
 * a step can ask for more, never for less.
 */

const log = require('../../../telemetry/log');

const policyKey = (orgId) => `org_${orgId}_automation_table_policy`;

const whole = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** max(what the step asks for, the floor). */
function effectiveMinN(stepMinN, floor) {
    return Math.max(whole(Number(stepMinN)), whole(Number(floor)));
}

/**
 * @param {string|null|undefined} orgId
 * @param {{ getConfig?: (key: string) => Promise<any>, limits?: { minGroupFloor: number } }} [deps]
 * @returns {Promise<number>}
 */
async function minGroupFloorFor(orgId, deps = {}) {
    const limits = deps.limits || require('./limits').tableLimits();
    const envFloor = whole(limits.minGroupFloor);
    if (!orgId) return envFloor;
    try {
        const getConfig = deps.getConfig || ((key) => require('../../../stores/configStore').getConfigFresh(key));
        const raw = await getConfig(policyKey(orgId));
        const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Math.max(envFloor, whole(doc && doc.minGroupSize));
    } catch (e) {
        log.warn('[tables] group policy unreadable, using the environment floor', { message: e && e.message });
        return envFloor;
    }
}

module.exports = { policyKey, effectiveMinN, minGroupFloorFor };
