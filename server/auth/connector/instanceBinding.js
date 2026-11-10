// @typecheck strict
/**
 * Nextcloud Connector: linking an organisation to a Nextcloud instance.
 *
 * A Nextcloud instance is linked to one organisation, and a code (a pairing
 * code, the emailed verification code, an administrator's approval) links it
 * only to the organisation that code was issued for. So:
 *
 *   - bindOrgToNcInstance answers with the organisation it was asked to bind,
 *     as stored, or throws;
 *   - an organisation is linked to one Nextcloud instance: the bind sets the
 *     instance id only on an organisation that has none or has this one;
 *   - a bootstrap that presents a code for an instance id that belongs to
 *     another organisation is refused with 409 `nc_instance_bound_elsewhere`:
 *     the code stays unused and the answer carries no tenant key.
 *
 * Used by the pairing-code branch (bootstrapBranches.js), the verification
 * route (auth/connectorBootstrap.js) and, through that file's `helpers`, the
 * approval handler in ncBindingRoutes.js.
 */

const log = require('../../telemetry/log');
const userStore = require('../../stores/userStore');
const { orgHealth } = require('./serviceDeps');
// The catalog itself, not provisioning.js's copy: this module sits below it.
const { NC_INTEGRATION_IDS } = require('../../utils/ncIntegrationCatalog');

/** @typedef {NonNullable<Awaited<ReturnType<typeof userStore.getOrganization>>>} OrgRow */
/** @typedef {{ ncInstanceId: string, ncBaseUrl: string, ncAdminUid: string, connectorCallbackUrl?: string|null }} BindParams */

const NC_INSTANCE_BOUND_ELSEWHERE = 'nc_instance_bound_elsewhere';
const ORG_LINKED_TO_OTHER_INSTANCE = 'org_linked_to_other_instance';

// Recorded against the organisation the code was issued for; resolved once
// that organisation is linked.
const INSTANCE_BOUND_ELSEWHERE_PROBLEM = 'bootstrap.instance_bound_elsewhere';

class NcInstanceBoundElsewhereError extends Error {
    constructor() {
        super('This Nextcloud instance is already linked to another Bee Flow organisation');
        this.name = 'NcInstanceBoundElsewhereError';
        this.code = NC_INSTANCE_BOUND_ELSEWHERE;
        this.statusCode = 409;
    }
}

class OrgLinkedToOtherInstanceError extends Error {
    constructor() {
        super('This organisation is already linked to a different Nextcloud instance');
        this.name = 'OrgLinkedToOtherInstanceError';
        this.code = ORG_LINKED_TO_OTHER_INSTANCE;
        this.statusCode = 409;
    }
}

/**
 * True when `ncInstanceId` is linked to an organisation other than `orgId`.
 * @param {string} orgId
 * @param {string} ncInstanceId
 */
async function ncInstanceBoundElsewhere(orgId, ncInstanceId) {
    const holder = await userStore.getOrganizationByNcInstanceId(ncInstanceId);
    return !!holder && holder.id !== orgId;
}

/**
 * Bind an un-bound org to this NC instance.
 * @param {OrgRow} org
 * @param {BindParams} params
 * @returns {Promise<OrgRow>} `org` as stored after the bind
 * @throws {NcInstanceBoundElsewhereError} the instance id belongs to another organisation
 * @throws {OrgLinkedToOtherInstanceError} the organisation has another instance id
 */
async function bindOrgToNcInstance(org, params) {
    const { ncInstanceId, ncBaseUrl, ncAdminUid, connectorCallbackUrl } = params;
    if (await ncInstanceBoundElsewhere(org.id, ncInstanceId)) throw new NcInstanceBoundElsewhereError();
    let existingIntegrations = [];
    if (Array.isArray(org.enabledIntegrations)) {
        existingIntegrations = org.enabledIntegrations;
    } else if (typeof org.enabledIntegrations === 'string' && org.enabledIntegrations) {
        try { existingIntegrations = JSON.parse(org.enabledIntegrations) || []; } catch (_) { existingIntegrations = []; }
    }
    const merged = Array.from(new Set([...existingIntegrations, ...NC_INTEGRATION_IDS]));
    // The instance id first, in one statement; the rest of the link follows it.
    if (!(await userStore.claimNcInstanceForOrganization(org.id, ncInstanceId))) {
        if (await ncInstanceBoundElsewhere(org.id, ncInstanceId)) throw new NcInstanceBoundElsewhereError();
        throw new OrgLinkedToOtherInstanceError();
    }
    await userStore.updateOrganization(org.id, {
        authMethod: 'nextcloud_connector',
        autoApproveSSO: true,
        connectorCallbackUrl: connectorCallbackUrl || null,
        ncBaseUrl,
        ncAdminUid,
        ncProvisionedAt: new Date().toISOString(),
        enabledIntegrations: merged,
    });
    // Read back the organisation this instance id is linked to.
    const bound = await userStore.getOrganizationByNcInstanceId(ncInstanceId);
    if (!bound) throw new Error(`the Nextcloud binding of organization ${org.id} was not stored`);
    if (bound.id !== org.id) throw new NcInstanceBoundElsewhereError();
    return bound;
}

/**
 * Answer 409: the instance id belongs to another organisation than the one
 * the presented code was issued for.
 * @param {{ res: import('express').Response, ncInstanceId: string }} ctx
 * @param {{ id: string }} org the organisation the code was issued for
 * @param {'pairing_code' | 'email_verification'} via
 */
function refuseInstanceBoundElsewhere({ res, ncInstanceId }, org, via) {
    log.warn(`[ConnectorBootstrap] instance_bound_elsewhere org=${org.id} ncInstance=${ncInstanceId} via=${via}`);
    orgHealth.problem(INSTANCE_BOUND_ELSEWHERE_PROBLEM, {
        orgId: org.id, source: 'connectorBootstrap',
        meta: { ncInstanceId, reason: via },
    });
    return res.status(409).json({
        error: 'This Nextcloud instance is already linked to another Bee Flow organisation.',
        code: NC_INSTANCE_BOUND_ELSEWHERE,
        remediation: 'A Nextcloud is linked to one Bee Flow organisation. To reconnect it, generate a pairing code in the organisation it is linked to (Settings → Organisation → Pair a new Nextcloud). To link it to a different organisation, ask the administrator of this Bee Flow server to remove the existing link first.',
    });
}

/**
 * Answer 409: the organisation the presented code was issued for is linked to
 * another Nextcloud instance.
 * @param {import('express').Response} res
 * @param {'pairing_code' | 'email_verification'} via
 */
function refuseOrgLinkedToOtherInstance(res, via) {
    return res.status(409).json(via === 'pairing_code'
        ? { error: 'Target organisation is already bound to a different Nextcloud instance', code: 'pairing_code_org_already_bound' }
        : alreadyLinkedAnswer());
}

// The emailed code links a Nextcloud to an organisation that has none. The
// `error` text carries the next step: it is what the setup screen shows.
function alreadyLinkedAnswer() {
    return {
        error: 'This organisation is already linked to a Nextcloud. To connect again, ask a Bee Flow organisation admin for a pairing code (Settings → Organisation → Pair a new Nextcloud) and enter it on the Bee Flow setup page.',
        code: 'already_bound',
        remediation: 'To connect again, ask a Bee Flow organisation admin to generate a pairing code (Settings → Organisation → Pair a new Nextcloud) and enter it on the Bee Flow setup page.',
    };
}

/**
 * Bind `org` to the instance; when the instance id belongs to another
 * organisation, or the organisation has another instance id, answer the
 * refusal above and return null.
 * @param {{ res: import('express').Response, ncInstanceId: string }} ctx
 * @param {OrgRow} org
 * @param {Omit<BindParams, 'ncInstanceId'>} params
 * @param {'pairing_code' | 'email_verification'} via
 */
async function bindOrRefuse(ctx, org, params, via) {
    try {
        return await bindOrgToNcInstance(org, { ...params, ncInstanceId: ctx.ncInstanceId });
    } catch (e) {
        if (e instanceof OrgLinkedToOtherInstanceError) {
            refuseOrgLinkedToOtherInstance(ctx.res, via);
            return null;
        }
        if (!(e instanceof NcInstanceBoundElsewhereError)) throw e;
        refuseInstanceBoundElsewhere(ctx, org, via);
        return null;
    }
}

module.exports = {
    NC_INSTANCE_BOUND_ELSEWHERE,
    INSTANCE_BOUND_ELSEWHERE_PROBLEM,
    NcInstanceBoundElsewhereError,
    OrgLinkedToOtherInstanceError,
    alreadyLinkedAnswer,
    ncInstanceBoundElsewhere,
    bindOrgToNcInstance,
    refuseInstanceBoundElsewhere,
    bindOrRefuse,
};
