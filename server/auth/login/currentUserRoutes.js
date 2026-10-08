// @typecheck
/**
 * Login Routes — what the signed-in session reports about itself: the /user
 * payload (identity, encryption state, MFA enrolment, NC onboarding, feature
 * flags, org branding) and the consent centre. Split out of
 * auth/loginRoutes.js.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { loadConfig } = require('../permissions');
const consentGuards = require('../consentGuards');
const { isEncryptionEnabledForUser, isSsoPinRequiredForUser } = require('../../stores/encryptionAvailability');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const ID_TEXT = 'Name the consent you want to change.';
const GRANTED_TEXT = 'Say whether the consent is given or withdrawn.';
// `granted` is REQUIRED and must be a real boolean. It used to be read as
// `granted === true`, so "true", 1 and a body that forgot the field altogether
// all meant WITHDRAW — and this writes a consent ledger row, which is the
// record of what the person decided. A withdrawal filed as if they had asked
// for it is the one outcome this route must never produce by accident.
const OptionalConsentBody = z.object({
    id: worded(ID_TEXT).trim().min(1, ID_TEXT).max(200, ID_TEXT),
    granted: z.boolean({ required_error: GRANTED_TEXT, invalid_type_error: GRANTED_TEXT }),
}).strict();

// Get current user info
router.get('/user', async (req, res) => {
    if (req.session.isAuthenticated && req.session.user) {
        const config = await loadConfig();
        // Fetch fresh avatar data from store
        const freshUser = await userStore.getUser(req.session.user.id);

        // If user no longer exists in DB, invalidate session
        if (!freshUser) {
            req.session.destroy((err) => {
                if (err) log.error('Session destroy error:', err);
            });
            const config = await loadConfig();
            return res.json({
                authenticated: false,
                isOAuthConfigured: !!(config.oauth.clientId && config.oauth.clientSecret),
                oauthProviders: config.oauth.providers || [],
            });
        }

        res.json({
            authenticated: true,
            user: {
                id: req.session.user.id,
                displayName: freshUser?.displayName || req.session.user.displayName || req.session.user['display-name'] || req.session.user.displayname || req.session.user.id,
                firstName: freshUser?.firstName || req.session.user.firstName || '',
                lastName: freshUser?.lastName || req.session.user.lastName || '',
                email: freshUser?.email || req.session.user.email,
                isAdmin: req.session.isAdmin || freshUser?.role === 'admin' || false,
                role: freshUser?.role || req.session.user.role || 'user',
                avatar: freshUser?.avatar || req.session.user.avatar || req.session.user.picture || null,
                avatarType: freshUser?.avatarType || req.session.user.avatarType || (req.session.user.picture ? 'url' : null),
                // A connector-hydrated session must keep reporting the LOGIN
                // provider (frontend branches on this, e.g. SSO-only UI) —
                // oauthProvider only counts when it came from an SSO login.
                provider: req.session.user.provider
                    || (req.session.oauthTokenSource !== 'connector' ? req.session.oauthProvider : null)
                    || 'local',
                organizationId: freshUser?.organizationId || '',
                orgRole: freshUser?.orgRole || '',
                // Personal UI preference — strips the sidebar/settings down to
                // chat + agents. Read here so the SPA has the flag on first
                // paint and doesn't flash the full UI before /api/ai/user-settings resolves.
                simpleMode: await (async () => {
                    try {
                        const configStore = require('../../stores/configStore');
                        return !!(await configStore.getConfig(`simple_mode_user_${req.session.user.id}`));
                    } catch (_) { return false; }
                })(),
                // Memory master switch (Settings → Memory). The client treats
                // absent as ON, so this only has to be right for someone who
                // turned it off — and must not flash their switch back on
                // after a reload. Fail open like the policy itself does.
                memoryEnabled: await (async () => {
                    try {
                        const { isMemoryEnabledForUser } = require('../../core/memory/memoryPolicy');
                        return await isMemoryEnabledForUser(req.session.user.id);
                    } catch (_) { return true; }
                })()
            },
            isOAuthConfigured: !!(config.oauth.clientId && config.oauth.clientSecret),
            // Encryption status for SSO users. Suppress the setup/pin prompts
            // when encryption is disabled for this user — a stale session flag
            // from before the feature was gated off would otherwise still pop
            // the PIN-setup screen.
            ...(await (async () => {
                const enabled = await isEncryptionEnabledForUser(req.session.user.id);
                // Managed tier: the org escrow holds the key, so no PIN prompt.
                const pinRequired = enabled && await isSsoPinRequiredForUser(req.session.user.id);
                return {
                    encryptionEnabled: enabled,
                    needsEncryptionSetup: pinRequired && !!req.session.needsEncryptionSetup,
                    needsEncryptionPin: pinRequired && !!req.session.needsEncryptionPin,
                };
            })()),
            // Organisation membership for SSO users
            noOrganization: req.session.noOrganization || false,
            isConsumerAccount: !freshUser?.organizationId && !req.session.noOrganization && (process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud',
            pendingApproval: req.session.pendingApproval || false,
            // Forced MFA enrollment for username/password accounts. Derived LIVE
            // from the fresh DB row (not a sticky session flag — that's the bug
            // class we just fixed for pendingApproval), so it self-clears the
            // moment the user enrols. SSO accounts are exempt (their IdP owns
            // MFA). The built-in admin is included even before it has a users
            // row. Gated by an admin toggle, default ON, OR'd with the per-org
            // duty (A3, `org_mfa_required_<orgId>` — default OFF, read side only
            // this release).
            mfaSetupRequired: await (async () => {
                try {
                    const configStore = require('../../stores/configStore');
                    const { resolveOrgMfaRequired } = require('../../core/entitlements/orgMfaRequired');
                    const platformRequired = (await configStore.getConfig('require_mfa_for_password_accounts')) ?? true;
                    // The org flag can only ADD the duty — it never switches the
                    // platform flag off, and a missing org row reads as false
                    // (deliberately NOT `?? true` like the platform flag).
                    const orgRequired = await resolveOrgMfaRequired(freshUser?.organizationId || null);
                    if (!platformRequired && !orgRequired) return false;
                    if (freshUser?.mfa_enabled) return false;            // already enrolled
                    // BFSF-255: a connector-hydrated session (password account
                    // that connected Google via Settings → Connections) is NOT
                    // an SSO login — connecting Google must never silently
                    // exempt a password account from forced MFA enrollment.
                    const isSso = (!!req.session.oauthProvider && req.session.oauthTokenSource !== 'connector') ||
                                  (freshUser?.provider && freshUser.provider !== 'local');
                    if (isSso) return false;                             // Google/Microsoft own MFA
                    if (req.session.isAdmin || freshUser?.role === 'admin') return true; // admin included (row may not exist yet)
                    return !!freshUser?.passwordHash;                    // local password account
                } catch (_) { return false; }
            })(),
            // NC App Store onboarding wizard gate. When the connector has
            // bootstrapped a fresh org but the admin hasn't completed the
            // 4-step setup wizard yet, we surface that to the SPA so it
            // renders <NcOnboardingWizard/> for the admin and a "Setup in
            // progress" screen for everyone else in that org.
            ...(await (async () => {
                if (!freshUser?.organizationId) return {};
                const isOrgAdmin = (freshUser?.orgRole === 'org_admin') || (freshUser?.role === 'admin') || !!req.session.isAdmin;
                // Pending NC binding — shown to org-admins so they can
                // approve a connector that's waiting to bind to this org.
                // Surfaced even when nc_instance_id is null because that's
                // exactly the state where adoption is pending.
                let pendingNcBinding = null;
                if (isOrgAdmin) {
                    try {
                        const row = await userStore.getPendingNcBindingForOrg(freshUser.organizationId);
                        if (row) {
                            pendingNcBinding = {
                                id: row.id,
                                ncBaseUrl: row.ncBaseUrl,
                                ncInstanceId: row.ncInstanceId,
                                ncAdminUid: row.ncAdminUid,
                                ncAdminEmail: row.ncAdminEmail,
                                themingName: row.themingName,
                                ncVersion: row.ncVersion,
                                expiresAt: row.expiresAt,
                            };
                        }
                    } catch (e) { log.warn('[auth/user] pendingNcBinding lookup failed:', e.message); }
                }
                const org = await userStore.getOrganization(freshUser.organizationId);
                if (!org?.nc_instance_id) {
                    return pendingNcBinding ? { pendingNcBinding } : {};
                }
                const onboardingDone = !!org.nc_onboarding_completed_at;
                // ncOrg is the org-level binding info — present iff the org
                // was provisioned through Nextcloud. SPA uses this to gate
                // settings sections that don't apply when identity is
                // delegated to NC (sign-in method, allowed domains, etc.).
                return {
                    ncOnboardingNeeded: !onboardingDone && isOrgAdmin,
                    ncOnboardingPending: !onboardingDone && !isOrgAdmin,
                    isOrgAdmin,
                    organizationName: org.name || null,
                    pendingNcBinding,
                    ncOrg: {
                        instanceId: org.nc_instance_id,
                        baseUrl: org.nc_base_url || null,
                        adminUid: org.nc_admin_uid || null,
                        syncMode: org.nc_sync_mode || 'mirror_all',
                        lastSyncAt: org.nc_last_sync_at || null,
                        provisionedAt: org.nc_provisioned_at || null,
                        onboardingCompletedAt: org.nc_onboarding_completed_at || null,
                    },
                };
            })()),
            // Feature flags from env + configStore
            featureFlags: await (async () => {
                const configStore = require('../../stores/configStore');
                const notebooksEnabled = await configStore.getConfig('feature_notebooks_enabled');
                const projectsEnabled = await configStore.getConfig('feature_projects_enabled');
                const askAiEnabled = await configStore.getConfig('feature_ask_ai_enabled');
                const exportEnabled = await configStore.getConfig('feature_export_enabled');
                const openInNotebookEnabled = await configStore.getConfig('feature_open_in_notebook_enabled');
                const notebooksMenuEnabled = await configStore.getConfig('feature_notebooks_menu_enabled');
                return {
                    tasks: process.env.ENABLE_TASKS !== 'false',
                    monitoring: process.env.ENABLE_MONITORING !== 'false',
                    meeting_notes: process.env.ENABLE_MEETING_NOTES !== 'false',
                    templates: process.env.ENABLE_TEMPLATES !== 'false',
                    notebooks: notebooksEnabled !== false && notebooksEnabled !== 'false',
                    projects: projectsEnabled !== false && projectsEnabled !== 'false',
                    askAi: askAiEnabled !== false && askAiEnabled !== 'false',
                    export: exportEnabled !== false && exportEnabled !== 'false',
                    openInNotebook: openInNotebookEnabled !== false && openInNotebookEnabled !== 'false',
                    notebooksMenu: notebooksMenuEnabled !== false && notebooksMenuEnabled !== 'false',
                    deploymentMode: process.env.DEPLOYMENT_MODE || 'cloud',
                };
            })(),
            // Org branding (logo + name) for self-hosted white-label rendering
            // in the sidebar / loading screens. Cloud users see the same data
            // but the frontend only swaps the logo when deploymentMode is
            // 'self-hosted', so leaving it populated everywhere is harmless.
            organization: await (async () => {
                try {
                    const orgId = freshUser?.organizationId;
                    if (!orgId) return null;
                    const org = await userStore.getOrganization(orgId);
                    if (!org) return null;
                    return { id: org.id, name: org.name || null, logo: org.logo || null };
                } catch (e) { return null; }
            })(),
            // Org-level enabled integrations
            enabledIntegrations: await (async () => {
                try {
                    const orgId = freshUser?.organizationId;
                    if (!orgId) return null;
                    const org = await userStore.getOrganization(orgId);
                    if (org?.enabledIntegrations) {
                        return typeof org.enabledIntegrations === 'string' ? JSON.parse(org.enabledIntegrations) : org.enabledIntegrations;
                    }
                    // Org uses defaults — load global default integrations
                    const configStore = require('../../stores/configStore');
                    const globalDefaults = await configStore.getConfig('default_org_integrations');
                    if (globalDefaults) {
                        return typeof globalDefaults === 'string' ? JSON.parse(globalDefaults) : globalDefaults;
                    }
                    return null; // no defaults configured = all enabled
                } catch (e) { return null; }
            })(),
        });
    } else {
        const config = await loadConfig();
        res.json({
            authenticated: false,
            user: null,
            isOAuthConfigured: !!(config.oauth.clientId && config.oauth.clientSecret)
        });
    }
});

// GET /auth/consents — consent status for the settings consent center.
// Returns the optional (marketing / biometric) consents with current state.
router.get('/consents', async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    try {
        const documentRegistry = require('../../legal/documentRegistry');
        const freshUser = await userStore.getUser(req.session.user.id);
        if (!freshUser) return res.status(401).json({ error: 'Not authenticated' });

        const optState = await userStore.getOptionalConsents(freshUser.id);
        const optional = documentRegistry.optionalConsents()
            .filter(c => c.enabled !== false)
            .map(c => ({
                id: c.id,
                category: c.category,
                version: c.version,
                labelKey: c.labelKey || null,
                granted: !!(optState[c.id] && optState[c.id].granted),
                updatedAt: (optState[c.id] && optState[c.id].updatedAt) || null,
            }));

        res.json({ optional });
    } catch (e) {
        log.error('[consents] error:', e.message);
        res.status(500).json({ error: 'Failed to load consents' });
    }
});

// POST /auth/consents/optional — grant/withdraw an optional (marketing) consent.
// body: { id, granted }. Records a grant/withdraw ledger row and updates state.
router.post('/consents/optional', validate({ body: OptionalConsentBody }), async (req, res) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    try {
        const documentRegistry = require('../../legal/documentRegistry');
        const { id, granted } = req.body;
        const consent = documentRegistry.getOptionalConsent(id);
        if (!consent || consent.enabled === false) {
            return res.status(400).json({ error: 'Unknown consent' });
        }
        const freshUser = await userStore.getUser(req.session.user.id);
        if (!freshUser) return res.status(401).json({ error: 'Not authenticated' });

        await userStore.recordConsentAcceptance({
            userId: freshUser.id,
            email: freshUser.email,
            accountType: freshUser.organizationId ? 'org' : 'consumer',
            docId: consent.id,
            docVersion: consent.version,
            docSha256: null,
            method: granted ? 'consent_grant' : 'consent_withdraw',
            route: req.originalUrl,
            ip: consentGuards.auditClientIp(req),
            userAgent: req.headers['user-agent'] || null,
            organizationId: freshUser.organizationId || null,
        });

        const state = await userStore.getOptionalConsents(freshUser.id);
        state[consent.id] = { granted, version: consent.version, updatedAt: new Date().toISOString() };
        await userStore.setOptionalConsents(freshUser.id, state);

        // Withdrawal must CASCADE for special-category data: keeping a
        // biometric voiceprint after its Art. 9(2)(a) consent is withdrawn has
        // no lawful basis, so the template goes at the same moment the flag
        // flips. Best-effort — the consent state is the record of intent and
        // must be persisted even if the delete hiccups.
        if (consent.id === documentRegistry.VOICEPRINT_CONSENT_ID && !granted) {
            try {
                const removed = await require('../../stores/voiceprintStore').deleteVoiceprintForUser(freshUser.id);
                if (removed) log.info(`[consents/optional] Voiceprint deleted for ${freshUser.id} on consent withdrawal`);
            } catch (e) {
                log.error('[consents/optional] voiceprint deletion on withdrawal failed:', e.message);
            }
        }

        res.json({ success: true, id: consent.id, granted });
    } catch (e) {
        log.error('[consents/optional] error:', e.message);
        res.status(500).json({ error: 'Failed to update consent' });
    }
});

module.exports = router;
