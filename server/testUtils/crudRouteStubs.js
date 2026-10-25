// @typecheck noImplicitAny
'use strict';

/**
 * The collaborators routes/automation/crud.js and versions.js pull in, stubbed
 * for the route tests that call their handlers directly. Install BEFORE the
 * router is required. `store` is the automationStore double; `users` answers
 * userStore.getUser and audience resolves everyone into `orgId`.
 */

const path = require('path');
const { preloadStubs } = require('./stubRequire');

const SERVER = path.join(__dirname, '..');
const at = (/** @type {string} */ p) => path.join(SERVER, p);

/**
 * @param {{ store: Record<string, unknown>, orgId?: string }} opts
 */
function installCrudRouteStubs({ store, orgId = 'org1' }) {
    const realPortability = require(at('automation/portability'));
    preloadStubs(require, {
        [at('stores/automationStore')]: store,
        [at('automation/validate')]: { validateDefinition: () => ({ ok: true, warnings: /** @type {string[]} */ ([]) }) },
        [at('automation/summarise')]: { summariseDefinition: () => ({ summary: '' }) },
        [at('automation/deliverableEvents')]: { getDeliverableEvents: () => /** @type {unknown[]} */ ([]) },
        [at('automation/toolRegistry')]: { TOOL_REGISTRY: [], loadTools: () => /** @type {unknown[]} */ ([]) },
        [at('automation/triggerBus')]: {
            getPublicBaseUrl: () => /** @type {string | null} */ (null), loadSession: async () => /** @type {unknown} */ (null), revokeSubscription: async () => {},
            fetchLatestGmailMatch: async () => /** @type {unknown} */ (null), dispatchEvent: async () => /** @type {unknown[]} */ ([]),
        },
        [at('automation/portability')]: {
            buildExport: () => ({}), sanitizeImport: () => ({ automation: /** @type {unknown} */ (null), errors: ['not used'] }),
            rekeyDefinition: (/** @type {unknown} */ d) => ({ definition: d }), collectPinnedNodes: realPortability.collectPinnedNodes,
        },
        [at('core/integrations/integrationTools')]: { getUserPermittedApps: async () => new Set() },
        [at('stores/userStore')]: { getUser: async (/** @type {string} */ id) => ({ id, organizationId: orgId, groups: /** @type {string[]} */ ([]) }) },
        [at('auth/permissions')]: { hasPermission: async () => false, validateSharedGroupsForOrg: async (/** @type {string} */ _o, /** @type {string[]} */ ids) => ids },
        [at('auth/audience')]: {
            resolveAudienceContext: async (/** @type {import('express').Request} */ req) => ({ userId: req.session.user.id, orgIds: new Set([orgId]), userGroups: /** @type {string[]} */ ([]) }),
            resolveUserGroups: async () => /** @type {string[]} */ ([]),
        },
        [at('utils/perUserRateLimit')]: { perUserRateLimit: () => (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => next() },
    });
}

module.exports = { installCrudRouteStubs };
