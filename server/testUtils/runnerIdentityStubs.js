// @typecheck
'use strict';

/**
 * The identity lookups an automation run makes before step 1, as stubs for the
 * runner tests that need a real executeAutomation with named people: the vault
 * session of a user, the enabled integrations, and the user's groups. Install
 * BEFORE the runner is required.
 *
 *   installRunnerIdentityStubs({ groups: { u1: ['g1'] }, session: (id) => ({ ... }) });
 *
 * `session(userId)` answers the vault entry (null = none); without it every
 * user has a token-less entry. `connected`, when given, limits the users that
 * have one.
 */

const path = require('path');
const { preloadStubs } = require('./stubRequire');

const SERVER = path.join(__dirname, '..');

function installRunnerIdentityStubs({ groups = {}, connected = null, session = null, providers = () => [] } = {}) {
    preloadStubs(require, {
        [path.join(SERVER, 'auth/automationAuth')]: {
            providersForIntegrations: providers,
            async buildUserAuth(userId) {
                if (session) return session(userId);
                if (connected && !connected.has(userId)) return null;
                return { userId, accessToken: null, refreshToken: null, oauthProvider: null, automationProviders: {} };
            },
        },
        [path.join(SERVER, 'core/integrations/enabledIntegrations')]: { resolveEnabledIntegrations: async () => [], mergeEnabled: (a) => a },
        [path.join(SERVER, 'auth/audience')]: { resolveUserGroups: async (id) => groups[id] || [] },
    });
}

module.exports = { installRunnerIdentityStubs };
