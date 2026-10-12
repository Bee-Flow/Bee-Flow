// @typecheck
/**
 * stores/lib/managedParts.js: the write guard for parts a Solution stage owns.
 *
 * A part is MANAGED when its project is a stage project (UAT or PRD of a
 * Solution, `projects.stage_of` set). It is derived, never stored on the part:
 * `projectStore.stageOfProject` answers it, with a cache (a negative for an
 * existing row for the process lifetime, a positive for 10 s). A managed part
 * is changed in Dev and deployed; a builder on the stage may only touch the
 * fields of ALLOWED (sharing, on/off, scheduler bookkeeping, ...).
 *
 * The capability to write anything else is `opts.managedWrite = { deploymentId }`,
 * valid while that deployment row is active (queued .. compensating) for
 * exactly the stage project being written. A deploy passes it explicitly; no
 * async context hands it out implicitly.
 *
 * Before refusing, the guard re-reads the stage uncached
 * (`stageOfProjectFresh`), so a `detachStage` on another replica takes effect
 * at the next write instead of up to 10 s later.
 *
 * Platform: requires only stores/ (lazily, through the default deps) and
 * telemetry. Never core/: a store may not require core/http/errors.js, so the
 * error carries its own `{status, code, errorClass, expose, details}`, which the
 * terminal handler passes through.
 */

'use strict';

const log = require('../../telemetry/log');

/**
 * Per kind: the fields editable on a managed part without a deploy (design 5.2).
 * Keys are the camelCase keys the stores' update functions take. Ownership
 * (ownerId, userId) is never on a list.
 */
const ALLOWED = Object.freeze({
    automation: Object.freeze([
        // On/off; never to true without a live copy (assertManagedWrite).
        'isActive', 'isDraft', 'needsFirstRunConfirm',
        // Derived from the live runPolicy at activation.
        'runTimeoutMs',
        // Scheduler bookkeeping.
        'nextRunAt', 'lastRunAt', 'lastStatus',
        'folderId',
        // Sharing and form audience (never ownership).
        'shares', 'sharedGroups', 'audience', 'formAudience', 'visibility',
    ]),
    app: Object.freeze([
        // Through studioAppStore.setStudioAppAudience only.
        'isPublished', 'sharedGroups', 'organizationId',
        'members', 'roles', 'publicPages', 'nextcloudMenu',
    ]),
    webpage: Object.freeze([
        'isPublished', 'audience', 'sharedGroups', 'organizationId', 'accessMode', 'publicShare',
        // The page's own data.db and its thumbnail.
        'dbSha', 'dbSize', 'thumbnailSha', 'thumbnailSize',
    ]),
    agent: Object.freeze(['sharedGroups', 'organizationId', 'isPublished', 'shares', 'embedEnabled', 'categoryId']),
    datatable: Object.freeze([
        'rows', 'grants', 'shares', 'sharing',
        'lawfulBasis', 'retentionDays', 'retentionField', 'subjectColumn',
    ]),
    // A knowledge base in shell mode: its documents and sources stay the stage's own.
    knowledge_base: Object.freeze(['documents', 'sources', 'isPublished', 'sharedGroups', 'organizationId']),
    // A knowledge base whose content the release carries: publish and audience only.
    knowledge_base_carry: Object.freeze(['isPublished', 'sharedGroups', 'organizationId']),
    skill: Object.freeze(['sharedGroups', 'organizationId', 'visibility', 'isPublished', 'shares']),
    document: Object.freeze(['sharedGroups', 'organizationId', 'visibility', 'isPublished', 'shares']),
    // The stage project row itself: only knowledgeBaseIds is guarded
    // (projectStore.updateProject), and it is not editable without a deploy.
    project: Object.freeze([]),
});

/**
 * An error a store throws for the client to see: status, code and details
 * pass through the terminal handler because `expose` is true. `errorClass`
 * repeats the code for routes that answer `code: err.errorClass`.
 *
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, any>} [details]
 */
function storeError(status, code, message, details) {
    return Object.assign(new Error(message), {
        status, code, errorClass: code, expose: true,
        ...(details ? { details } : {}),
    });
}

/** The refusal of a write to a managed part (409 managed_part). */
function managedPartError(info) {
    return storeError(409, 'managed_part',
        'This part is managed by a Solution stage. Change it in Dev and deploy.',
        { solutionId: info?.solutionId ?? null, stage: info?.stage ?? null });
}

// ── changedKeysOf ──────────────────────────────────────────────────────────

function parseIfJson(v) {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return v;
    try { return JSON.parse(t); } catch (_) { return v; }
}

function stable(v) {
    if (v === undefined || v === null || v === '') return 'null';
    if (v instanceof Date) return JSON.stringify(v.toISOString());
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (typeof v === 'object') {
        return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
            .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    }
    if (typeof v === 'number' || typeof v === 'bigint') return JSON.stringify(String(v));
    return JSON.stringify(String(v));
}

/** Same value for the guard's purpose: null, undefined and '' are one; JSON text equals its parse. */
function sameValue(a, b) {
    return stable(parseIfJson(a)) === stable(parseIfJson(b));
}

/**
 * The incoming keys whose value differs from the locked row. For positional
 * full-row writers (updateAgent): the route sends every field, so the
 * allow-list must see only what actually changes.
 *
 * `columnMap` maps an incoming key to its column (a string, or `{col, transform}`
 * as stores/lib/sqlBuilder takes it). A key without a mapping is compared with
 * the row's property of the same name. `undefined` means "not supplied".
 *
 * @param {Record<string, any>|null} lockedRow  the row as read under the lock (snake_case columns)
 * @param {Record<string, any>} incoming
 * @param {Record<string, string|{col: string, transform?: (v: any) => any}>} [columnMap]
 * @returns {string[]}
 */
function changedKeysOf(lockedRow, incoming, columnMap = {}) {
    const row = lockedRow || {};
    const out = [];
    for (const [key, value] of Object.entries(incoming || {})) {
        if (value === undefined) continue;
        const spec = columnMap[key];
        const col = spec && typeof spec === 'object' ? spec.col : (typeof spec === 'string' ? spec : key);
        const next = spec && typeof spec === 'object' && typeof spec.transform === 'function'
            ? spec.transform(value) : value;
        if (!Object.prototype.hasOwnProperty.call(row, col)) { out.push(key); continue; }
        if (!sameValue(row[col], next)) out.push(key);
    }
    return out;
}

// ── The guard ──────────────────────────────────────────────────────────────

/**
 * @typedef {{ solutionId: string, stage: 'uat'|'prd', projectId: string }} StageOf
 * @typedef {{
 *   stageOfProject: (projectId: string) => Promise<StageOf|null>,
 *   stageOfProjectFresh: (projectId: string) => Promise<StageOf|null>,
 *   isActiveDeployment: (deploymentId: string, stageProjectId: string, client?: any) => Promise<boolean>,
 *   kbStageInfo?: (kbId: string) => Promise<{ stageProjectId: string, ref: string|null, contentMode: 'shell'|'carry' }|null>,
 * }} ManagedPartsDeps
 */

/** @param {ManagedPartsDeps} deps */
function makeManagedParts(deps) {
    const { stageOfProject, stageOfProjectFresh, isActiveDeployment, kbStageInfo } = deps;

    const toInfo = (s) => (s ? { solutionId: s.solutionId, stage: s.stage, stageProjectId: s.projectId } : null);

    /** null | {solutionId, stage, stageProjectId}, through the cached stage lookup. */
    async function managedInfo(projectId) {
        if (typeof projectId !== 'string' || !projectId) return null;
        return toInfo(await stageOfProject(projectId));
    }

    /**
     * The stage a knowledge base is managed by (stamped into, or listed on, a
     * stage project), with its content mode, or null.
     *
     * @returns {Promise<null|{solutionId: string, stage: string, stageProjectId: string, ref: string|null, contentMode: 'shell'|'carry'}>}
     */
    async function managedInfoForKb(kbId) {
        if (typeof kbId !== 'string' || !kbId || typeof kbStageInfo !== 'function') return null;
        const hit = await kbStageInfo(kbId);
        if (!hit) return null;
        const info = await managedInfo(hit.stageProjectId);
        return info ? { ...info, ref: hit.ref ?? null, contentMode: hit.contentMode === 'carry' ? 'carry' : 'shell' } : null;
    }

    /** True when `managedWrite` names an active deployment of exactly this stage project. */
    async function hasCapability({ managedWrite, projectId, client = null }) {
        const deploymentId = managedWrite && typeof managedWrite === 'object' ? managedWrite.deploymentId : null;
        if (typeof deploymentId !== 'string' || !deploymentId || !projectId) return false;
        return !!(await isActiveDeployment(deploymentId, projectId, client || undefined));
    }

    /**
     * Refuse a write to a managed part unless it is allow-listed or carries
     * the capability. Returns how the write was let through; throws
     * managedPartError otherwise.
     *
     * `changedKeys` is the list of keys the write changes, or an object of
     * key → new value (then `isActive: true` is read from it). `updates` may
     * give the values next to a key list. With keys only, `isActive` on a
     * automation without a live copy counts as switching it on.
     *
     * @param {{
     *   kind: keyof typeof ALLOWED,
     *   projectId: string|null|undefined,
     *   changedKeys: string[]|Record<string, any>,
     *   updates?: Record<string, any>,
     *   managedWrite?: { deploymentId?: string }|null,
     *   client?: any,
     *   liveVersion?: number|null,
     * }} args
     * @returns {Promise<{ managed: boolean, via?: 'allowlist'|'capability'|'detached' }>}
     */
    async function assertManagedWrite({ kind, projectId, changedKeys, updates, managedWrite = null, client = null, liveVersion }) {
        if (!Object.prototype.hasOwnProperty.call(ALLOWED, kind)) {
            throw new TypeError(`assertManagedWrite: unknown kind ${JSON.stringify(kind)}`);
        }
        const info = await managedInfo(projectId || '');
        if (!info) return { managed: false };

        const keys = Array.isArray(changedKeys) ? changedKeys : Object.keys(changedKeys || {});
        const values = Array.isArray(changedKeys) ? (updates || null) : changedKeys;

        const refuse = async () => {
            if (await hasCapability({ managedWrite, projectId, client })) return { managed: true, via: /** @type {const} */ ('capability') };
            const fresh = await stageOfProjectFresh(/** @type {string} */ (projectId));
            if (!fresh) return { managed: true, via: /** @type {const} */ ('detached') };
            log.debug(`[managedParts] refused ${kind} write on stage project ${projectId}: ${keys.join(',')}`);
            throw managedPartError(toInfo(fresh));
        };

        // Switching a never-live automation on would publish its WORKING copy
        // (LIVE_INVARIANT_SQL): only a deploy may do that.
        if (kind === 'automation' && keys.includes('isActive') && liveVersion == null) {
            const turningOn = values && Object.prototype.hasOwnProperty.call(values, 'isActive')
                ? values.isActive === true : true;
            if (turningOn) return refuse();
        }
        const allowed = ALLOWED[kind];
        if (keys.every((k) => allowed.includes(k))) return { managed: true, via: 'allowlist' };
        return refuse();
    }

    return { ALLOWED, managedInfo, managedInfoForKb, hasCapability, assertManagedWrite, changedKeysOf, managedPartError };
}

// The instance the app uses: the stores' default instances, required lazily
// (projectStore requires this module at load).
const defaultParts = makeManagedParts({
    stageOfProject: (id) => require('../projectStore').stageOfProject(id),
    stageOfProjectFresh: (id) => require('../projectStore').stageOfProjectFresh(id),
    isActiveDeployment: (d, p, c) => require('../solutionStageStore').isActiveDeployment(d, p, c),
    kbStageInfo: (kbId) => require('../solutionStageStore').kbStageInfo(kbId),
});

module.exports = {
    ALLOWED,
    makeManagedParts,
    storeError,
    managedPartError,
    changedKeysOf,
    managedInfo: defaultParts.managedInfo,
    managedInfoForKb: defaultParts.managedInfoForKb,
    hasCapability: defaultParts.hasCapability,
    assertManagedWrite: defaultParts.assertManagedWrite,
};
