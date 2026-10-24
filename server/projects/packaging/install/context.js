// @typecheck
/**
 * The context every install function reads, and the deferred stamp pass.
 *
 * Split out of install.js: the part installers (install/parts/), the reference
 * pass (install/patch.js) and the stage engine all take a ctx from
 * `makeInstallCtx` and write through `writeOpts`; `stampAll` runs once every
 * reference is in place. install.js re-exports every public name here unchanged.
 */

'use strict';

const { currentPayload } = require('./payload');
const log = require('../../../telemetry/log');

/**
 * What an entity looked like the moment it was installed.
 *
 * hashDefinition is App Studio's, reused rather than rewritten: jsonb does not
 * preserve key order, so a second hasher would disagree with the first on
 * documents that are identical, and upgrade would then call a pristine entity
 * dirty. One hasher.
 */
function installHashOf(payload) {
    const { hashDefinition } = require('../../../appStudio/templateUpgrade');
    return hashDefinition(payload);
}

/** The installed version every stamp of this install carries. */
function versionOf(solution) {
    const v = Number(solution?.version);
    return Number.isInteger(v) && v > 0 ? v : 1;
}

/**
 * The context every install function reads, with the defaults an install has.
 *
 *   ownerId / projectId / organizationId  who owns what is created, and where
 *     it is filed. The stage engine passes the run-as user and the stage
 *     project; a gallery install the installer and the new Solution.
 *   rekey            fresh step ids per automation (default). The stage engine
 *     passes false: a stage keeps Dev's step ids (design D3).
 *   scope            the datatable scope; default the organisation, else the owner.
 *   datatableKeyFor  (entity) → the physical table key; default `entity.key`.
 *     A key that differs from the bundle's is recorded as `logical_key`.
 *   dataModelOptions passed to studioAppDataStore.saveDataModel.
 *   managedWrite     a deployment's capability (`{ deploymentId }`), for the
 *     stage engine filing a part INTO a stage project: the store guards
 *     (stores/lib/managedParts.js) refuse that write with 409 managed_part
 *     without it. Handed to every guarded store write this file makes
 *     (`writeOpts`); null for a gallery install or an upgrade.
 *   installedVersion the version every stamp carries.
 *   wiring           the installer's resolutions; null applies none.
 *   templateVersions (filled by the installer) template id → revision id.
 *
 * `stamp` only COLLECTS `{ ref, kind, entityId, payload, stepIdMap }`;
 * `stampAll` writes them once every reference is patched (F2).
 *
 * @param {{
 *   ownerId?: string, organizationId?: string|null, projectId?: string|null, refMap?: Map<any, any>,
 *   can?: Function, req?: any, wiring?: any, rekey?: boolean, scope?: any, datatableKeyFor?: any,
 *   dataModelOptions?: any, managedWrite?: any, installedVersion?: number, releaseId?: any, deps?: Record<string, any>,
 * }} [opts]
 */
function makeInstallCtx({
    ownerId, organizationId = null, projectId = null, refMap = new Map(), can = () => true, req = null,
    wiring = null, rekey = true, scope = null, datatableKeyFor = null, dataModelOptions = null,
    managedWrite = null, installedVersion = 1, releaseId = undefined, deps = {},
} = {}) {
    const ctx = {
        ownerId, organizationId, projectId, refMap, can, req, wiring, rekey, scope, datatableKeyFor,
        dataModelOptions, managedWrite, installedVersion, releaseId, deps, stamped: [],
        // Template id → the revision a fill_document step is pinned to (installDocumentTemplates).
        templateVersions: new Map(),
    };
    ctx.stamp = async (entry) => { ctx.stamped.push(entry); };
    return ctx;
}

/**
 * The options a guarded store write takes from this ctx: the deployment's
 * capability when the stage engine handed one over, nothing otherwise (a
 * gallery install or an upgrade writes outside any stage).
 */
function writeOpts(ctx) {
    return ctx && ctx.managedWrite ? { managedWrite: ctx.managedWrite } : {};
}

/** The kinds whose CURRENT payload an upgrade compares; the rest keep the payload install wrote. */
const READ_BACK_KINDS = new Set(['automation', 'app', 'webpage', 'agent']);

/**
 * Write the stamps collected in `ctx.stamped`, after every reference and every
 * resolution is in place (F2). The hash is of what the entity looks like NOW,
 * read through install/payload.currentPayload: that is the payload a later upgrade
 * compares against, so an untouched entity reads as pristine. A kind upgrade
 * never rereads (tables, knowledge bases) keeps the payload install wrote.
 *
 * Best-effort, never fatal: a Solution that installed but cannot be upgraded
 * later is a smaller problem than one that refused to install. A missing stamp
 * makes that entity ineligible for an automatic upgrade, the safe default.
 */
async function stampAll(ctx, report) {
    const blueprintStore = require('../../../stores/blueprintStore');
    const byRef = new Map();
    for (const entry of ctx.stamped.splice(0)) byRef.set(entry.ref, entry);
    for (const entry of byRef.values()) {
        let payload = entry.payload;
        if (READ_BACK_KINDS.has(entry.kind)) {
            try {
                const now = await currentPayload(entry.kind, entry.entityId);
                if (now !== null && now !== undefined) payload = now;
            } catch (err) {
                log.warn(`[Blueprint] could not read "${entry.ref}" back for its stamp: ${err.message}`);
            }
        }
        try {
            await blueprintStore.upsertStamp(null, {
                projectId: ctx.projectId, ref: entry.ref, kind: entry.kind, entityId: entry.entityId,
                installHash: installHashOf(payload ?? {}),
                installedVersion: ctx.installedVersion,
                ...(entry.stepIdMap !== undefined ? { stepIdMap: entry.stepIdMap } : {}),
                ...(ctx.releaseId !== undefined ? { releaseId: ctx.releaseId } : {}),
            });
        } catch (err) {
            report.warnings.push(`Could not record how "${entry.ref}" was installed, so it will not be offered future updates automatically: ${err.message}`);
        }
    }
}

module.exports = { installHashOf, versionOf, makeInstallCtx, writeOpts, READ_BACK_KINDS, stampAll };
