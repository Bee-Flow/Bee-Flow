import ProjectCaptureProvider from './components/projects/workspace/content/ProjectCaptureProvider';
import { whenMayNavigate } from './utils/unsavedNavigation';
import React, { Suspense, useState, useEffect, useRef, useEffectEvent } from 'react';
import { lazy } from './utils/lazyWithReload';
import { logger } from './utils/logger';

/**
 * The authenticated product, behind ONE lazy boundary.
 *
 * This file is the app half of the marketing/app split. App.jsx used to hold
 * both surfaces, and although the heavy feature trees were already lazy, the
 * router shell itself statically imported the licence/subscription contexts,
 * the Studio route table (which drags in the module-runtime registry), the
 * meeting/billing helpers and the whole 1,200-line <App/> — ~90 KB gz of
 * JavaScript a marketing visitor parsed to read a landing page it never runs.
 * App.jsx now imports this module via `lazy()`, so a marketing pageview
 * fetches none of it and a product pageview fetches all of it exactly once,
 * warmed up by a module-scope import() on /app paths so the boundary costs a
 * signed-in user no extra round trip in practice.
 *
 * Nothing in here may be imported by App.jsx or anything App.jsx reaches
 * statically — that would weld this chunk straight back into the entry.
 */
const AgentHub = lazy(() => import('./AgentHub'));
const MfaSetupGate = lazy(() => import('./pages/login/MfaSetupGate'));
const EncryptionSetup = lazy(() => import('./pages/EncryptionSetup'));
const DlpPreviewModal = lazy(() => import('./components/chat/DlpPreviewModal'));
const OnboardingTour = lazy(() => import('./components/onboarding/OnboardingTour'));
const LessonPlayerHost = lazy(() => import('./components/onboarding/LessonPlayerHost'));
import ErrorBoundary from './components/shell/ErrorBoundary';
import MaintenanceBanner from './components/shell/MaintenanceBanner';
import { LicenseProvider } from './components/licensing/LicenseContext';
import { SubscriptionProvider } from './components/licensing/SubscriptionContext';
import { EntitlementsProvider } from './components/licensing/EntitlementsContext';
const NcOnboardingWizard = lazy(() => import('./components/NcOnboardingWizard'));
const NcOnboardingPending = lazy(() => import('./components/integrations/nextcloud/NcOnboardingPending'));
const NcBindingApprovalModal = lazy(() => import('./components/integrations/nextcloud/NcBindingApprovalModal'));


// Heavy admin / studio routes are loaded on demand so the initial chat
// bundle stays lean. Each render site is wrapped in <Suspense> + a per-
// route <ErrorBoundary> so a load failure or runtime crash in one panel
// can't take down the rest of the app.
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const OrgSettings = lazy(() => import('./pages/OrgSettings'));
// The RecorderProvider/CaptureProvider remain mounted at the app root so
// capture state persists across page navigation even when the Studio tab
// isn't open. Lazy: they pull the whole meeting-notes capture subtree.
const RecorderProvider = lazy(() => import('./pages/meeting-notes/hooks/RecorderContext')
    .then(m => ({ default: m.RecorderProvider })));
const CaptureProvider = lazy(() => import('./pages/meeting-notes/capture/CaptureContext')
    .then(m => ({ default: m.CaptureProvider })));
const CaptureModal = lazy(() => import('./pages/meeting-notes/capture/CaptureModal'));
const MeetingCommandPalette = lazy(() => import('./components/global/MeetingCommandPalette'));
const TemplatesPage = lazy(() => import('./pages/TemplatesPage'));
const AppRunPage = lazy(() => import('./pages/apps/AppRunPage'));
const AgentDesigner = lazy(() => import('./components/agents/AgentDesigner/index'));

import { queryClient } from './api/queryClient';
// The route table and URL parsers, the derived route, the full-screen gates
// and the two hook groups (auth bootstrap, navigateToPage) live in ./authedApp/*.
import { PAGE_ROUTES } from './authedApp/appRoutes';
import { parseAgentUrl, parseDirectChatUrl } from './authedApp/urlParsers';
import { MobileRouteGuard, SubscriptionGate } from './authedApp/guards';
import { projectHistoryMode } from './authedApp/projectNavigation';
import { AppBackdrop, LoadingScreen, NoOrganizationScreen, PendingApprovalScreen, RouteFallback, ServerUnavailableScreen, type BootstrapDiagnostics } from './authedApp/shellScreens';
import { SignedOutGate } from './authedApp/SignedOutGate';
import type { SignInRefusal } from './authedApp/signedOutScreen';
import { useAuthSession } from './authedApp/useAuthSession';
import { useNavigateToPage } from './authedApp/useNavigateToPage';
import { useAppRoute } from './authedApp/useAppRoute';
import { NavigationProvider } from './authedApp/NavigationContext';
import { SessionProvider } from './authedApp/SessionContext';
import { navigate } from './router/history';
import { capturePendingPlanFromUrl } from './components/billing/pendingPlan';
import { clearSessionCaches } from './hooks/sessionCaches';
import { useAppHeight } from './hooks/useAppHeight';
import { useTranslation } from './hooks/useTranslation';
import { useViewport } from './hooks/useViewport';
import { setSessionToken } from './utils/helpers';
import { fetchAuthUser, fetchMyPermissions, postLogout } from './api/queries/coreAuthSession';
import { identityKey, shouldResetCache } from './utils/identityCache';
import { projectRoutePath } from './utils/projectRoutes';
// Storage identity plumbing for the effect below: pin the scoped namespace to
// the signed-in user, then run the version-gated browser-state schema passes.
import scopedStorage from './utils/scopedStorage';
import { runStorageMigrations, runUserStorageMigrations } from './utils/storageMigrations';
import type { AuthedUser, HubUser, PendingNcBinding } from './AuthedApp.types';
import { RefusedError } from './api/mutate';
import { apiRequest } from '@/api/typedRequest';

// Kept exported from this module: the allow-list moved to ./authedApp/appRoutes
// with the rest of the route table, but AuthedApp.jsx is still its address.
export { MOBILE_ALLOWED_PAGES } from './authedApp/appRoutes';

// The authenticated app, wrapped in its capability/licence providers.
// EntitlementsProvider wraps LicenseProvider so LicenseContext.hasFeature can
// delegate to the unified resolver snapshot (the same one the API's
// requireCapability enforces) — page-render and API-allow can no longer diverge.
//
// MUST be used everywhere <App/> is rendered. There are two entry paths:
//   • /app and other reserved paths → AppRoot renders this directly.
//   • "/" and single-segment paths → RootPathGate renders this on fall-through.
// SSO/OAuth lands on "/" (the origin), which RootPathGate rewrites to /app
// WITHOUT a reload, so AppRoot's branch never runs for that navigation. A bare
// <App/> there left useLicenseContext/useEntitlements on their defaults
// (deploymentMode='cloud', hasFeature => false), hiding self-hosted branding and
// every capability-gated sidebar item (Notebooks, etc.) until a manual refresh
// of /app re-entered the provider-wrapped branch.
function AuthedApp() {
    /* One boundary for the whole authenticated tree. `App` has a dozen early
       returns (login, MFA, encryption setup, Nextcloud onboarding, AgentHub),
       every one of which now resolves a lazy chunk — wrapping here covers all
       of them without a Suspense at each site. The fallback is the app's own
       backdrop rather than null, so the handoff from index.html reads as one
       continuous surface instead of a white flash. */
    return (
        <EntitlementsProvider>
            <LicenseProvider>
                <Suspense fallback={<AppBackdrop />}>
                    <App />
                </Suspense>
            </LicenseProvider>
        </EntitlementsProvider>
    );
}
function App() {
    const { t } = useTranslation();
    // Keep --app-height / --keyboard-inset live for the whole app (mounted before
    // any early return so the rules of hooks hold and the vars update on the
    // auth/splash screens too).
    useAppHeight();
    const { isMobile } = useViewport();
    // Where we are: the page and what it is opened with, all read off the
    // address (./authedApp/useAppRoute). Back/Forward and every navigateToPage
    // call publish a new location; nothing about the page is held in state.
    const {
        route, page, adminPath, orgSettingsPath, coworkId, documentId, designerAgentId, formViewToken, appRunId,
        studioRoute, projectRoute,
    } = useAppRoute();
    const [user, setUser] = useState<AuthedUser | null>(null);
    const [isAuthenticated, setIsAuthenticated] = useState(false);

    // Keep scopedStorage pinned to the current user. When user logs out the
    // scope clears — subsequent reads return null until the next login. On
    // login the one-time schema pass (utils/storageMigrations.js) moves any
    // pre-scoping bare keys into the user's scoped slots and prunes retired
    // ones — there is no lazy per-read migration anymore.
    const _prevIdentityRef = useRef<string>(null);
    // A `?plan=<id>` deep link from the pricing page has to be captured before
    // the sign-in redirect throws the query string away. Stored for the session
    // and consumed once the billing surface renders.
    useEffect(() => { capturePendingPlanFromUrl(); }, []);

    const runUserEffect = useEffectEvent(() => {
        // Device-level browser-state migrations first (dead keys, stale
        // build-stamped caches), then the per-user pass once whoami has
        // resolved. Both are idempotent, version-gated and never throw, so
        // re-running on every identity change is cheap.
        runStorageMigrations();
        scopedStorage.setCurrentUser(user?.id || null);
        if (user?.id) runUserStorageMigrations(user.id);
        // Reset all cached server data when the IDENTITY (user + active org)
        // changes from one signed-in identity to a DIFFERENT one — an account
        // switch or org switch that doesn't go through handleLogout. React Query
        // keys are not tenant-scoped, so stale lists from the previous identity
        // must not bleed through. Skip the initial null→X set and benign profile
        // patches (same identity). Logout (X→null) is handled in handleLogout.
        const identity = identityKey(user);
        if (shouldResetCache(_prevIdentityRef.current, identity)) queryClient.clear();
        _prevIdentityRef.current = identity;
    });
    useEffect(() => { return runUserEffect(); }, [user?.id, user?.organizationId, user?.orgId]);

    const [isLoading, setIsLoading] = useState(true);
    const [deploymentMode, setDeploymentMode] = useState('cloud');
    const [orgLogo, setOrgLogo] = useState<string | null>(null);
    const [serverAvailable, setServerAvailable] = useState<boolean | null>(null); // null=unknown, true=ok, false=down
    const [encryptionState, setEncryptionState] = useState<'setup' | 'pin' | { recoveryKey: string } | null>(null); // null | 'setup' | 'pin' | { recoveryKey: string }
    const [noOrganization, setNoOrganization] = useState(false);
    const [pendingApproval, setPendingApproval] = useState(false);
    // Forced TOTP enrollment for username/password accounts (admin-required).
    const [mfaSetupRequired, setMfaSetupRequired] = useState(false);
    // NC App Store onboarding gate: 'admin' renders the 4-step wizard,
    // 'pending' shows the "Setup in progress" screen, null lets the SPA
    // mount normally.
    const [ncOnboardingState, setNcOnboardingState] = useState<string | null>(null);
    const [ncOrgName, setNcOrgName] = useState<string | null>(null);
    // Pending NC connector binding awaiting org-admin confirmation. When
    // present (and user is org_admin), <NcBindingApprovalModal/> takes
    // precedence over the onboarding wizard.
    const [pendingNcBinding, setPendingNcBinding] = useState<PendingNcBinding | null>(null);
    // Connector-side bootstrap diagnostics, fetched from /setup/diagnostics
    // when the main SaaS calls fail. Surfaces categorised remediation
    // ("set BEEFLOW_NC_PUBLIC_URL", "SaaS unreachable", …) in the error
    // overlay so admins know what to fix instead of staring at a generic
    // retry button. Admin-only data — see info.xml route gating.
    const [bootstrapDiagnostics, setBootstrapDiagnostics] = useState<BootstrapDiagnostics | null>(null);
    // What a non-ok /auth/user answered at boot (the connector sign-in's reason).
    const [signInRefusal, setSignInRefusal] = useState<SignInRefusal | null>(null);

    // The agent / conversation the app was opened on, read once: a deep link
    // survives the sign-in (which lands on /app) and the forward of a desktop
    // hand-over address (/app/chat/<id> → /app/d/<id>) because the forward's
    // target is what is read.
    const initialChatRef = useRef((() => {
        const openedAt = route.redirect?.startsWith('/') ? route.redirect : route.pathname;
        return { ...parseAgentUrl(openedAt), directConvId: parseDirectChatUrl(openedAt) };
    })());

    // Boot the session: the shared /auth/user + /auth/my-permissions applier
    // (used by handleLogin too) plus the mount-time auth probe.
    const applyAuthSession = useAuthSession({
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
        setSignInRefusal,
        setServerAvailable,
        setIsLoading,
    });

    // On first load, send a legacy ?page= URL at the root to its clean path.
    useEffect(() => {
        const legacyPage = new URLSearchParams(window.location.search).get('page');
        if (legacyPage && PAGE_ROUTES[legacyPage] && window.location.pathname === '/') {
            navigate(PAGE_ROUTES[legacyPage], { replace: true, state: {} });
        }
    }, []);

    // Every in-app navigation (./authedApp/useNavigateToPage), created once.
    const navigateToPage = useNavigateToPage({ isMobile, isConsumerAccount: !!user?.isConsumerAccount });

    // An address that forwards (a page that moved into Studio, a desktop
    // hand-over address, /app/billing) is replaced by its target once signed
    // in; nothing renders at the forwarding address, so no page flashes.
    const pendingRedirect = isAuthenticated && !isLoading ? route.redirect : null;
    useEffect(() => {
        if (pendingRedirect) navigateToPage(pendingRedirect, { replace: true });
    }, [pendingRedirect, navigateToPage]);

    // Tell the (above-auth-boundary) EntitlementsProvider to re-resolve whenever
    // auth flips — login/logout/bootstrap all run through setIsAuthenticated, so
    // one effect keyed on it covers every transition. Without this the provider's
    // pre-login snapshot (401 → empty) persists and every capability-gated UI
    // (Studio Webpages tab, etc.) stays hidden after login.
    useEffect(() => {
        window.dispatchEvent(new Event('beeflow:auth-changed'));
    }, [isAuthenticated]);

    const handleLogin = async (userData: AuthedUser, recoveryKey?: string) => {
        // Hydrate from /auth/user + /auth/my-permissions exactly like a page
        // refresh (checkAuth) via the shared applier, so the sidebar, org
        // branding, feature flags and capability gates reflect the user's real
        // permissions immediately. The thin login response (`userData`) lacks
        // the freshly-computed featureFlags / org / capability data, which is
        // why login previously showed a stale subset until a manual refresh.
        try {
            const userRes = await fetchAuthUser();
            const data = userRes.ok ? await userRes.json() : null;
            if (data?.authenticated && data.user) {
                const permsRes = await fetchMyPermissions();
                const permsData = permsRes.ok ? await permsRes.json() : null;
                applyAuthSession(data, permsData);
            } else {
                // /auth/user unavailable right after login (rare — the session
                // is already established). Fall back to the thin login payload
                // so the user isn't blocked; a later refresh reconciles.
                setUser(userData);
                setIsAuthenticated(true);
            }
        } catch (err) {
            console.error('Failed to hydrate session after login:', err);
            setUser(userData);
            setIsAuthenticated(true);
        }
        // Back to the app home after login (the address may still be a homepage route).
        navigate('/app', { state: { page: 'agents' } });
        // Show recovery key if one was generated (new user or migration).
        // Set last so it takes precedence over any encryption-setup state the
        // applier may have derived from /auth/user.
        if (recoveryKey) {
            setEncryptionState({ recoveryKey });
        }
    };

    const handleLogout = async () => {
        const prevUserId = user?.id || null;
        try {
            await postLogout();
        } catch (err) {
            console.error('Logout error:', err);
        }
        // Drop every user-scoped preference so the next login on this browser
        // can't read the previous user's favourites / last-used agent / etc.
        // Device-level keys (theme, locale) are not touched.
        if (prevUserId) scopedStorage.clearUser(prevUserId);
        scopedStorage.setCurrentUser(null);
        // Drop ALL cached server data. React Query keys are not tenant-scoped
        // (e.g. ['agents','list']), so without this a second account logging in
        // on the same browser could read the previous user's cached lists for
        // up to gcTime (5min). clear() removes every query + mutation cache.
        queryClient.clear();
        // And the caches React Query never sees: the ones that live in MODULE
        // scope inside a hook file. Logout does not reload the page — the login
        // screen renders in the same JS context — so `useIntegrationStatus`,
        // `useSkills` and `useShieldStatus` handed their previous user's answer
        // straight to the next one. See hooks/sessionCaches.js.
        clearSessionCaches();
        // Drop the embedded-iframe pickup token so a logged-out iframe doesn't
        // keep replaying it on subsequent requests.
        setSessionToken(null);
        setUser(null);
        setIsAuthenticated(false);
        navigateToPage('agents');
    };

    // Show loading spinner while checking auth
    const useOrgBrand = deploymentMode === 'self-hosted' && !!orgLogo;
    if (isLoading) {
        return <LoadingScreen useOrgBrand={useOrgBrand} orgLogo={orgLogo} t={t} />;
    }

    // Server is unreachable — show a clear error instead of the product website
    if (serverAvailable === false) {
        return (
            <ServerUnavailableScreen
                useOrgBrand={useOrgBrand}
                orgLogo={orgLogo}
                bootstrapDiagnostics={bootstrapDiagnostics}
                t={t}
            />
        );
    }

    // Not authenticated → the login page, or inside Nextcloud what the
    // connector's sign-in answered (./authedApp/SignedOutGate).
    if (!isAuthenticated) {
        return <SignedOutGate ncOnboardingState={ncOnboardingState} ncOrgName={ncOrgName} bootstrapDiagnostics={bootstrapDiagnostics} signInRefusal={signInRefusal} onLogin={handleLogin} t={t} />;
    }

    // Show encryption setup/unlock gate for SSO users
    if (encryptionState === 'setup' || encryptionState === 'pin') {
        return (
            <EncryptionSetup
                mode={encryptionState === 'setup' ? 'setup' : 'unlock'}
                onComplete={() => setEncryptionState(null)}
            />
        );
    }

    // Show recovery key after login migration or signup
    if (encryptionState && encryptionState.recoveryKey) {
        return (
            <EncryptionSetup
                mode="recovery"
                recoveryKeyProp={encryptionState.recoveryKey}
                onComplete={() => setEncryptionState(null)}
            />
        );
    }

    // NC connector binding approval — gated before the onboarding wizard.
    // When the connector bootstrap is awaiting an authenticated approval
    // from this org's admin, show the modal first; the wizard takes over
    // afterwards via the next /auth/user refresh.
    if (pendingNcBinding && user && (user.orgRole === 'org_admin' || user.isAdmin)) {
        return (
            <NcBindingApprovalModal
                pending={pendingNcBinding}
                organizationName={ncOrgName}
                onResolved={async () => {
                    // Re-pull /auth/user so the next gate (wizard or app) renders.
                    try {
                        const res = await apiRequest('GET /auth/user', { init: { cache: 'no-store' } }).catch((err: unknown) => {
                            if (err instanceof RefusedError) return null;
                            throw err;
                        });
                        if (res) {
                            const data = await res.json();
                            setPendingNcBinding(data.pendingNcBinding || null);
                            if (data.ncOnboardingNeeded) setNcOnboardingState('admin');
                            else if (data.ncOnboardingPending) setNcOnboardingState('pending');
                            else setNcOnboardingState(null);
                            if (data.organizationName) setNcOrgName(data.organizationName);
                        } else {
                            setPendingNcBinding(null);
                        }
                    } catch (_) {
                        setPendingNcBinding(null);
                    }
                }}
            />
        );
    }

    // NC App Store onboarding wizard — admin sees this first time after install
    if (ncOnboardingState === 'admin' && user) {
        return <NcOnboardingWizard user={user} orgName={ncOrgName} deploymentMode={deploymentMode} onComplete={() => setNcOnboardingState(null)} />;
    }
    if (ncOnboardingState === 'pending') {
        return <NcOnboardingPending orgName={ncOrgName} onRefresh={() => window.location.reload()} />;
    }

    // Show no-organisation gate for SSO users without org membership
    // Consumer accounts (org-less by design) bypass this gate
    if (noOrganization && !user?.isConsumerAccount) {
        return <NoOrganizationScreen handleLogout={handleLogout} />;
    }

    // Show pending approval gate for SSO users awaiting admin approval
    if (pendingApproval) {
        return <PendingApprovalScreen user={user} handleLogout={handleLogout} />;
    }

    // Forced MFA enrollment gate — password (non-SSO) accounts must set up
    // two-factor auth before using the app when the admin requires it. The
    // server derives this live, so completing enrollment + re-fetch clears it.
    if (mfaSetupRequired) {
        return (
            <MfaSetupGate
                onLogout={handleLogout}
                onDone={async () => {
                    setMfaSetupRequired(false);
                    try {
                        const res = await apiRequest('GET /auth/user', { init: { cache: 'no-store' } }).catch((err: unknown) => {
                            if (err instanceof RefusedError) return null;
                            throw err;
                        });
                        if (res) {
                            const data = await res.json();
                            setMfaSetupRequired(!!data.mfaSetupRequired);
                        }
                    } catch (err) { logger.debug('leave cleared', err); }
                }}
            />
        );
    }

    // Per-route wrapper — a crash inside one panel surfaces only its own
    // boundary, leaving the rest of the app usable. Each lazy() chunk is
    // also wrapped so a network failure during code-split download falls
    // back to the same UI.
    const routed = (label: string, node: React.JSX.Element) => (
        <ErrorBoundary label={label}>
            <Suspense fallback={<RouteFallback />}>{node}</Suspense>
        </ErrorBoundary>
    );

    // Closing an inline panel returns the address to the app root, so Back
    // does not leave /app/settings (or the panel's address) in the bar.
    const closeTo = (prefix: string) => () => {
        if (window.location.pathname.startsWith(prefix)) navigate('/app', { state: { page: 'agents' } });
    };

    const renderContent = () => {
        // The forwarding address renders nothing; its target is on its way.
        if (route.redirect) return null;
        if (page === 'admin') {
            return routed('admin', <AdminDashboard user={user} onBack={() => navigateToPage('agents')} adminPath={adminPath} onNavigate={navigateToPage} />);
        }
        if (page === 'orgSettings') {
            return routed('orgSettings', <OrgSettings user={user} onBack={() => navigateToPage('agents')} orgSettingsPath={orgSettingsPath} onNavigate={navigateToPage} />);
        }
        // Apps and Forms (the published directories) render inside AgentHub's
        // inline slot like Cowork, so the sidebar stays. `appRun` is different
        // on purpose: opening one published app IS a standalone end-user surface.
        if (page === 'appRun') {
            // ?draft=1 lets the owner preview the working draft (the server
            // enforces owner-only on that flag).
            const isDraftPreview = new URLSearchParams(window.location.search).get('draft') === '1';
            return routed('appRun', <AppRunPage appId={appRunId} draft={isDraftPreview} />);
        }
        if (page === 'agentDesignerAdvanced') {
            return routed('agentDesignerAdvanced',
                <AgentDesigner
                    onBack={null}
                    initialAgentId={designerAgentId}
                    user={user}
                    onClose={() => navigateToPage(designerAgentId ? `agentDesigner:${designerAgentId}` : 'agentDesigner')}
                    hasPermission={(perm: string) => {
                        const perms = user?.permissions || [];
                        return perms.includes('all') || perms.includes(perm);
                    }}
                />
            );
        }
        if (page === 'templates') {
            if (user?.featureFlags?.templates === false) return navigateToPage('agents');
            return routed('templates', <TemplatesPage user={user} onBack={() => navigateToPage('agents')} />);
        }

        return <AgentHub onNavigate={navigateToPage} user={user} onUpdateUser={(patch: Partial<HubUser>) => setUser(prev => prev ? { ...prev, ...patch } : prev)} initialAgentId={initialChatRef.current.agentId} initialConversationId={initialChatRef.current.conversationId} initialDirectConvId={initialChatRef.current.directConvId} onLogout={handleLogout} currentPage={page}
            showSettings={page === 'settings'} onCloseSettings={closeTo('/app/settings')}
            showAgentDesigner={page === 'agentDesigner'} onCloseAgentDesigner={closeTo('/app/agent-designer')} initialDesignerAgentId={designerAgentId}
            showAgentWizard={page === 'agentWizard'} onCloseAgentWizard={closeTo('/app/agent-wizard')}
            showStudio={page === 'studio'} studioRoute={studioRoute} onCloseStudio={closeTo('/app/studio')}
            initialCoworkId={coworkId} initialDocumentId={documentId} formViewToken={formViewToken}
            showProjects={page === 'projects'} initialProjectRoute={projectRoute} onProjectRouteChange={(projectId: string | null, tab?: string | null, sub?: string | null) => whenMayNavigate(() => {
                // The workspace clears its dirty flag before its own confirmed moves,
                // so this guard refuses only moves started outside the workspace
                // (the rail, the switcher).
                // Drives the URL from the app, so a project view — down to one
                // team chat or document inside it — can be linked, bookmarked and
                // reached with the back button. `''` means "open the create form":
                // keep it distinct from the list (null), or the New Project button
                // navigates nowhere.
                const isCreate = projectId === '';
                const next = {
                    projectId: isCreate ? '' : (projectId || null),
                    tab: isCreate || !projectId ? null : (tab || null),
                    sub: isCreate || !projectId || !tab ? null : (sub || null),
                };
                const path = projectRoutePath(next.projectId, next.tab, next.sub);
                // Leaving the create form for the project it just created, or a
                // workspace normalising its own address, replaces rather than
                // pushes, so Back doesn't land on a page that sends you forward.
                const mode = projectHistoryMode(window.location.pathname, path);
                navigate(path, { replace: mode === 'replace', state: { page: 'projects', projectId: next.projectId } });
            })} onCloseProjects={closeTo('/app/projects')} />;
    };

    return (
        <SessionProvider user={user}>
        <NavigationProvider navigateToPage={navigateToPage} route={route}>
        <SubscriptionProvider user={user}>
        <AppRecorderProvider user={user} navigateToPage={navigateToPage} isAuthenticated={isAuthenticated} currentPage={page} deploymentMode={deploymentMode} isMobile={isMobile} renderContent={renderContent} />
        </SubscriptionProvider>
        </NavigationProvider>
        </SessionProvider>
    );
}

export default AuthedApp;

function AppRecorderProvider({ user, navigateToPage, isAuthenticated, currentPage, deploymentMode, isMobile, renderContent }: { user: AuthedUser | null; navigateToPage: (page: string, { replace }?: { replace?: boolean; }) => void; isAuthenticated: boolean; currentPage: string; deploymentMode: string; isMobile: boolean; renderContent: () => void | React.JSX.Element | null; }) {
    return <RecorderProvider>
        <CaptureProvider>
            <ProjectCaptureProvider key={user?.id || 'anonymous'} onNavigate={navigateToPage}>
                <div className="flex flex-col h-[var(--app-height)]">

                    {/* Deployment warning. Above everything, in the layout flow rather
            than floating: a rollout severs open SSE streams, so an answer
            can stop mid-sentence, and that deserves more weight than a
            dismissible toast. Renders nothing when no window is open, and
            only polls for signed-in users. */}
                    {isAuthenticated && <MaintenanceBanner />}

                    {/* No-subscription gate: org users without an active plan can
            only reach the License & Usage page so they can subscribe. */}
                    {isAuthenticated && (
                        <SubscriptionGate
                            user={user}
                            currentPage={currentPage}
                            deploymentMode={deploymentMode}
                            navigateToPage={navigateToPage} />
                    )}

                    {/* Mobile access control: bounce disallowed pages to /app on phones.
            Catches hard deep-links/refresh and viewport resize/rotate (the
            cases navigateToPage's own gate can't see). */}
                    {isAuthenticated && (
                        <MobileRouteGuard
                            isMobile={isMobile}
                            currentPage={currentPage}
                            navigateToPage={navigateToPage} />
                    )}

                    {/* Content */}
                    <div className="flex-1 overflow-hidden">
                        {renderContent() as React.ReactNode}
                    </div>

                    {/* Pre-flight DLP preview modal — globally mounted, listens for
            `beeflow:dlp_preview` window events emitted by useChatEngine. */}
                    {isAuthenticated && <DlpPreviewModal />}


                    {/* Global Meeting Notes surfaces — mounted once, available from any page. */}
                    {isAuthenticated && <CaptureModal />}
                    {isAuthenticated && <MeetingCommandPalette user={user} onNavigate={navigateToPage} />}

                    {/* New-user product tour — auto-starts once per new user, replayable
            from Settings → Help & Support. Mounted here so it floats above
            the app shell and can drive navigation via navigateToPage. */}
                    {isAuthenticated && <OnboardingTour user={user} onNavigate={navigateToPage} currentPage={currentPage} />}

                    {/* Learning Center — focused player for rich (slide/quiz/exercise/
            sim/action) lessons. Pure-tour lessons are routed back to
            OnboardingTour; verified hands-on steps navigate via
            navigateToPage while the player collapses to a pill. */}
                    {isAuthenticated && <LessonPlayerHost user={user} onNavigate={navigateToPage} />}

                    {/* The floating customer-support drawer was retired — the user-side
            support inbox now lives at /app/settings → Help & Support. */}

                    {/* Dropdown animation keyframe */}
                    <style>{`
                @keyframes dropdownIn {
                    from { opacity: 0; transform: translateY(-4px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes overlayIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes overlayContentIn {
                    from { opacity: 0; transform: scale(0.97) translateY(8px); }
                    to { opacity: 1; transform: scale(1) translateY(0); }
                }
            `}</style>
                    <style>{`
                @keyframes bannerSlideIn {
                    from { transform: translateY(-100%); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
            `}</style>



                </div>
            </ProjectCaptureProvider>
        </CaptureProvider>
    </RecorderProvider>;
}
