// @typecheck
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
const at = (p) => path.join(SERVER, p);

function installCrudRouteStubs({ store, orgId = 'org1' }) {
    const realPortability = require(at('automation/portability'));
    preloadStubs(require, {
        [at('stores/automationStore')]: store,
        [at('automation/validate')]: { validateDefinition: () => ({ ok: true, warnings: [] }) },
        [at('automation/summarise')]: { summariseDefinition: () => ({ summary: '' }) },
        [at('automation/deliverableEvents')]: { getDeliverableEvents: () => [] },
        [at('automation/toolRegistry')]: { TOOL_REGISTRY: [], loadTools: () => [] },
        [at('automation/triggerBus')]: {
            getPublicBaseUrl: () => null, loadSession: async () => null, revokeSubscription: async () => {},
            fetchLatestGmailMatch: async () => null, dispatchEvent: async () => [],
        },
        [at('automation/portability')]: {
            buildExport: () => ({}), sanitizeImport: () => ({ automation: null, errors: ['not used'] }),
            rekeyDefinition: (d) => ({ definition: d }), collectPinnedNodes: realPortability.collectPinnedNodes,
        },
        [at('core/integrations/integrationTools')]: { getUserPermittedApps: async () => new Set() },
        [at('stores/userStore')]: { getUser: async (id) => ({ id, organizationId: orgId, groups: [] }) },
        [at('auth/permissions')]: { hasPermission: async () => false, validateSharedGroupsForOrg: async (_o, ids) => ids },
        [at('auth/audience')]: {
            resolveAudienceContext: async (req) => ({ userId: req.session.user.id, orgIds: new Set([orgId]), userGroups: [] }),
            resolveUserGroups: async () => [],
        },
        [at('utils/perUserRateLimit')]: { perUserRateLimit: () => (req, res, next) => next() },
    });
}

module.exports = { installCrudRouteStubs };
