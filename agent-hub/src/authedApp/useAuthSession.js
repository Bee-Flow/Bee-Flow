import { useCallback, useEffect } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';
import { logger } from '../utils/logger';

// The boot-time auth pair from AuthedApp's <App/>, moved verbatim: the shared
// `applyAuthSession` applier and the mount effect that probes /auth/setup-status,
// /auth/user and /auth/my-permissions. Both hooks are called in the same order
// and from the same position as before (useCallback, then useEffect); every
// state setter is threaded in, and the returned applier is what `handleLogin`
// still calls.
export function useAuthSession({
    setDeploymentMode,
    setOrgLogo,
    setEncryptionState,
    setNoOrganization,
    setPendingApproval,
    setMfaSetupRequired,
    setNcOnboardingState,
    setNcOrgName,
    setPendingNcBinding,
    setUser,
    setIsAuthenticated,
    setBootstrapDiagnostics,
    setServerAvailable,
    setIsLoading,
}) {
    // Apply the authenticated session from the authoritative /auth/user +
    // /auth/my-permissions responses. Shared by checkAuth (page refresh) and
    // handleLogin (in-app login) so BOTH paths populate identical state —
    // featureFlags, org branding, capability gates, encryption/MFA/NC
    // gates. Previously handleLogin built a thin `user` from the login response
    // (no featureFlags, no fresh org) and skipped these gates, so the sidebar
    // and branding showed a stale subset until the next full page refresh.
    const applyAuthSession = useCallback((data, permsData) => {
        // Deployment mode (drives self-hosted white-label branding)
        if (data.featureFlags?.deploymentMode) {
            setDeploymentMode(data.featureFlags.deploymentMode);
        }
        // Post-auth org branding overrides the pre-auth guess
        if (data.organization?.logo) {
            setOrgLogo(`${API_BASE}${data.organization.logo}`);
        }
        // SSO encryption setup needs (only if encryption is enabled)
        if (data.encryptionEnabled !== false) {
            if (data.needsEncryptionSetup) setEncryptionState('setup');
            else if (data.needsEncryptionPin) setEncryptionState('pin');
        }
        if (data.noOrganization) setNoOrganization(true);
        if (data.pendingApproval) setPendingApproval(true);
        // Forced MFA enrollment (live from server; self-clears on enrol)
        setMfaSetupRequired(!!data.mfaSetupRequired);
        // NC App Store onboarding wizard gate
        if (data.ncOnboardingNeeded) setNcOnboardingState('admin');
        else if (data.ncOnboardingPending) setNcOnboardingState('pending');
        else setNcOnboardingState(null);
        if (data.organizationName) setNcOrgName(data.organizationName);
        setPendingNcBinding(data.pendingNcBinding || null);

        const permissions = permsData?.permissions || [];
        const userGroups = permsData?.groups || [];
        const userOrgs = permsData?.organizations || [];
        const allowedAgentTypes = permsData?.allowedAgentTypes || [];
        const betaFeatures = permsData?.betaFeatures || [];
        const canUseFeature = permsData?.canUseFeature || {};
        const canManageUsers = permissions.includes('all') || permissions.includes('manage_users');
        setUser({ ...data.user, permissions, groups: userGroups, organizations: userOrgs, allowedAgentTypes, betaFeatures, canUseFeature, featureFlags: data.featureFlags || {}, enabledIntegrations: data.enabledIntegrations || null, canManageUsers: canManageUsers || data.user.isAdmin, encryptionEnabled: data.encryptionEnabled !== false, isConsumerAccount: !!data.isConsumerAccount, ncOrg: data.ncOrg || null, organization: data.organization || null });
        setIsAuthenticated(true);
    }, []);

    // Check auth status on mount
    useEffect(() => {
        const checkAuth = async () => {
            // Ask the connector why we have no session. Drives the in-app
            // email-verification screen; connector-owned route, so it 404s
            // harmlessly in standalone (non-embedded) mode. Admin-only — non-
            // admins get 401/403 and fall back to the bare login form, which
            // is fine (they couldn't complete the pairing anyway).
            const probeBootstrapDiagnostics = async () => {
                try {
                    const diagRes = await authFetch(`${API_BASE}/setup/diagnostics`, { cache: 'no-store' });
                    if (diagRes.ok) setBootstrapDiagnostics(await diagRes.json());
                } catch (_) { /* not embedded / connector unreachable */ }
            };
            try {
                // The three boot calls used to run serially; in embedded mode
                // each one costs four network hops (browser → NC PHP proxy →
                // connector → SaaS), so the serial chain dominated
                // time-to-interactive inside Nextcloud. Fire them together and
                // apply the results in the original order — the decision logic
                // below is unchanged. /auth/my-permissions is speculative:
                // when the session turns out to be unauthenticated its 401 is
                // simply discarded (one wasted request on the anonymous login
                // page, two round-trip chains saved on every authed load).
                //
                // cache: 'no-store' on /auth/user avoids stale auth state
                // after the NC onboarding wizard flips ncOnboardingNeeded
                // server-side — browsers may otherwise serve a cached
                // "needed=true" response on subsequent refreshes.
                const [setupSettled, userSettled, permsSettled] = await Promise.allSettled([
                    authFetch(`${API_BASE}/auth/setup-status`),
                    authFetch(`${API_BASE}/auth/user`, { cache: 'no-store' }),
                    authFetch(`${API_BASE}/auth/my-permissions`),
                ]);

                // Deployment mode from setup-status (available without auth).
                if (setupSettled.status === 'rejected') {
                    // Network error — the SaaS-backed setup-status call
                    // failed. The connector itself may still be reachable;
                    // ask it for categorised bootstrap diagnostics so the
                    // overlay can show actionable remediation instead of
                    // a generic retry button. Admin-only endpoint — non-
                    // admins get a 401/403 and fall back to the bare
                    // overlay, which is fine (they couldn't fix it anyway).
                    setServerAvailable(false);
                    await probeBootstrapDiagnostics();
                    setIsLoading(false);
                    return;
                }
                const setupRes = setupSettled.value;
                if (setupRes.ok) {
                    const setupData = await setupRes.json();
                    if (setupData.deploymentMode) {
                        setDeploymentMode(setupData.deploymentMode);
                    }
                    if (setupData.branding?.logo) {
                        setOrgLogo(`${API_BASE}${setupData.branding.logo}`);
                    }
                    setServerAvailable(true);
                } else {
                    setServerAvailable(true); // server responded, even if not OK
                }

                if (userSettled.status === 'rejected') throw userSettled.reason;
                const res = userSettled.value;
                if (res.ok) {
                    const data = await res.json();
                    if (data.authenticated && data.user) {
                        logger.debug('[NcOnboarding] /auth/user flags:', {
                            needed: data.ncOnboardingNeeded,
                            pending: data.ncOnboardingPending,
                            isOrgAdmin: data.isOrgAdmin,
                            orgName: data.organizationName,
                        });
                        // Apply the full session through the shared applier so
                        // refresh and login populate identical state; the
                        // permissions fetch already ran alongside.
                        const permsRes = permsSettled.status === 'fulfilled' ? permsSettled.value : null;
                        const permsData = permsRes && permsRes.ok ? await permsRes.json() : null;
                        applyAuthSession(data, permsData);
                    } else {
                        // Not authenticated. In the embedded connector this can
                        // mean bootstrap hasn't finished (no tenant key yet) —
                        // ask the connector for diagnostics so we can show the
                        // in-app email-verification screen instead of a dead
                        // login form.
                        await probeBootstrapDiagnostics();
                    }
                } else {
                    // Non-OK, non-throwing: until bootstrap completes, the
                    // embedded connector answers every SaaS-bound call with
                    // 502 "Tenant key not configured". fetch() doesn't throw on
                    // that, so the catch above never fired, and it isn't a 200
                    // either, so the branch above never ran — the pairing
                    // screen was unreachable and the admin got a dead login
                    // form on the one screen that could have fixed it.
                    await probeBootstrapDiagnostics();
                }
            } catch (err) {
                console.error('Auth check failed:', err);
            } finally {
                setIsLoading(false);
            }
        };
        checkAuth();
    }, [applyAuthSession]);

    return applyAuthSession;
}
