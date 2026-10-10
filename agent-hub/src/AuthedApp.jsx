import ProjectCaptureProvider from './components/projects/workspace/content/ProjectCaptureProvider';
import { whenMayNavigate } from './utils/unsavedNavigation';
import React, { Suspense, useState, useEffect, useRef } from 'react';
import { lazy } from './utils/lazyWithReload';

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
const LoginPage = lazy(() => import('./pages/LoginPage'));
const MfaSetupGate = lazy(() => import('./pages/login/MfaSetupGate'));
const EncryptionSetup = lazy(() => import('./pages/EncryptionSetup'));
const DlpPreviewModal = lazy(() => import('./components/chat/DlpPreviewModal'));
const OnboardingTour = lazy(() => import('./components/onboarding/OnboardingTour'));
const LessonPlayerHost = lazy(() => import('./components/onboarding/LessonPlayerHost'));
import ErrorBoundary from './components/shell/ErrorBoundary';
import MaintenanceBanner from './components/shell/MaintenanceBanner';
import { LicenseProvider, RequireTier } from './components/licensing/LicenseContext';
import { SubscriptionProvider } from './components/licensing/SubscriptionContext';
import { EntitlementsProvider } from './components/licensing/EntitlementsContext';
const NcOnboardingWizard = lazy(() => import('./components/NcOnboardingWizard'));
const NcOnboardingPending = lazy(() => import('./components/integrations/nextcloud/NcOnboardingPending'));
const NcBindingApprovalModal = lazy(() => import('./components/integrations/nextcloud/NcBindingApprovalModal'));
const EmailVerificationScreen = lazy(() => import('./components/onboarding/EmailVerificationScreen'));


// Heavy admin / studio routes are loaded on demand so the initial chat
// bundle stays lean. Each render site is wrapped in <Suspense> + a per-
// route <ErrorBoundary> so a load failure or runtime crash in one panel
// can't take down the rest of the app.
const ComponentBuilder = lazy(() => import('./components/admin/component-studio/ComponentBuilder'));
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

import { API_BASE, authFetch, setSessionToken } from './utils/helpers';
import { parseStudioUrl, parseStudioQuery } from './components/admin/Studio/studioRoutes';
import { parseProjectUrl, projectRoutePath } from './utils/projectRoutes';
import { queryClient } from './api/queryClient';
import { identityKey, shouldResetCache } from './utils/identityCache';
import { useTranslation } from './hooks/useTranslation';
import { useViewport } from './hooks/useViewport';
import { capturePendingPlanFromUrl } from './components/billing/pendingPlan';
import { useAppHeight } from './hooks/useAppHeight';
import { clearSessionCaches } from './hooks/sessionCaches';
// The route table, the URL parsers, the full-screen gates and the two big
// hook groups (auth bootstrap, navigateToPage) live in ./authedApp/*. They are
// verbatim extractions — this file keeps the same public surface.
import { PAGE_ROUTES, pageFromPath, parseAdminPath, parseAgentDesignerUrl, parseAgentUrl, parseCoworkUrl, parseDocumentUrl, parseDirectChatUrl, parseNcStudioAppParam, parseOrgSettingsPath } from './authedApp/appRoutes';
import { MobileRouteGuard, SubscriptionGate } from './authedApp/guards';
import { projectHistoryMode } from './authedApp/projectNavigation';
import { AppBackdrop, LoadingScreen, NoOrganizationScreen, PendingApprovalScreen, RouteFallback, ServerUnavailableScreen } from './authedApp/shellScreens';
import { useAuthSession } from './authedApp/useAuthSession';
import { useNavigateToPage } from './authedApp/useNavigateToPage';
// Storage identity plumbing for the effect below: pin the scoped namespace to
// the signed-in user, then run the version-gated browser-state schema passes.
import scopedStorage from './utils/scopedStorage';
import { runStorageMigrations, runUserStorageMigrations } from './utils/storageMigrations';

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
    // Drive mobile access control. navigateToPage is a useCallback([]) and can't
    // read this directly, so we mirror it into a ref kept current by an effect.
    const { isMobile } = useViewport();
    const isMobileRef = useRef(isMobile);
    useEffect(() => { isMobileRef.current = isMobile; }, [isMobile]);
    const [currentPage, setCurrentPage] = useState(() => (
        // Opened from a Nextcloud app-menu entry → boot straight into the
        // app's own run view (the proxy-root pathname can't express it).
        parseNcStudioAppParam() ? 'appRun' : pageFromPath(window.location.pathname)
    ));
    const [adminPath, setAdminPath] = useState(() => parseAdminPath(window.location.pathname));
    const [orgSettingsPath, setOrgSettingsPath] = useState(() => parseOrgSettingsPath(window.location.pathname));
    const [initialCoworkId, setInitialCoworkId] = useState(() => parseCoworkUrl(window.location.pathname));
    const [initialDocumentId, setInitialDocumentId] = useState(() => parseDocumentUrl(window.location.pathname));
    const [user, setUser] = useState(null);
    const [isAuthenticated, setIsAuthenticated] = useState(false);

    // Keep scopedStorage pinned to the current user. When user logs out the
    // scope clears — subsequent reads return null until the next login. On
    // login the one-time schema pass (utils/storageMigrations.js) moves any
    // pre-scoping bare keys into the user's scoped slots and prunes retired
    // ones — there is no lazy per-read migration anymore.
    const _prevIdentityRef = useRef(null);
    // A `?plan=<id>` deep link from the pricing page has to be captured before
    // the sign-in redirect throws the query string away. Stored for the session
    // and consumed once the billing surface renders.
    useEffect(() => { capturePendingPlanFromUrl(); }, []);

    useEffect(() => {
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
    }, [user?.id, user?.organizationId, user?.orgId]);

    const [isLoading, setIsLoading] = useState(true);
    const [deploymentMode, setDeploymentMode] = useState('cloud');
    const [orgLogo, setOrgLogo] = useState(null);
    const [serverAvailable, setServerAvailable] = useState(null); // null=unknown, true=ok, false=down
    const [showProfileMenu, setShowProfileMenu] = useState(false);
    const [showAgentDesigner, setShowAgentDesigner] = useState(() => pageFromPath(window.location.pathname) === 'agentDesigner');
    const [showAgentWizard, setShowAgentWizard] = useState(() => pageFromPath(window.location.pathname) === 'agentWizard');
    const [showStudio, setShowStudio] = useState(() => pageFromPath(window.location.pathname) === 'studio');
    // Path = which automation; query = what of it is open (?view/run/step), so a
    // run deep-link survives a cold load.
    const [studioRoute, setStudioRoute] = useState(() => ({
        ...parseStudioUrl(window.location.pathname),
        ...parseStudioQuery(window.location.search),
    }));
    const [initialDesignerAgentId, setInitialDesignerAgentId] = useState(() => parseAgentDesignerUrl(window.location.pathname));
    // Standalone published-app run view (/app/apps/:id). The id is re-derived
    // from the URL at render time; this state exists so an in-app 'apps/<id>'
    // navigation re-renders even when currentPage is already 'appRun' (the
    // sidebar lists published apps, so app→app switches are one click now).
    // Which published form /app/forms/:token is showing. Held in state (not
    // re-read at render) so a form→form click re-renders while currentPage is
    // already 'formView' — the sidebar lists forms, so that is one click.
    const [formViewToken, setFormViewToken] = useState(
        () => window.location.pathname.match(/^\/app\/forms\/([^/]+)/)?.[1] || null,
    );
    const [appRunId, setAppRunId] = useState(() => {
        const m = window.location.pathname.match(/^\/app\/apps\/([^/]+)/);
        // The Nextcloud app-menu embed carries the id in ?ncStudioApp instead
        // of the pathname (see parseNcStudioAppParam).
        return m ? m[1] : parseNcStudioAppParam();
    });
    // Settings panel is rendered inline inside AgentHub when showSettings is true.
    // Keep it in sync with the URL so /app/settings/* on hard-refresh opens the panel
    // and the browser's back/forward buttons toggle it.
    const [showSettings, setShowSettings] = useState(() => pageFromPath(window.location.pathname) === 'settings');
    const [showSkillsPanel, setShowSkillsPanel] = useState(false);
    // Projects route state. `showProjects` distinguishes "on a projects page"
    // from "not"; `initialProjectRoute.projectId` distinguishes the list from a
    // specific project, so /app/projects and /app/projects/:id are separate
    // destinations rather than one view that only appears after closing another.
    const [showProjects, setShowProjects] = useState(() => pageFromPath(window.location.pathname) === 'projects');
    const [initialProjectRoute, setInitialProjectRoute] = useState(() => parseProjectUrl(window.location.pathname));
    const [encryptionState, setEncryptionState] = useState(null); // null | 'setup' | 'pin' | { recoveryKey: string }
    const [noOrganization, setNoOrganization] = useState(false);
    const [pendingApproval, setPendingApproval] = useState(false);
    // Forced TOTP enrollment for username/password accounts (admin-required).
    const [mfaSetupRequired, setMfaSetupRequired] = useState(false);
    // NC App Store onboarding gate: 'admin' renders the 4-step wizard,
    // 'pending' shows the "Setup in progress" screen, null lets the SPA
    // mount normally.
    const [ncOnboardingState, setNcOnboardingState] = useState(null);
    const [ncOrgName, setNcOrgName] = useState(null);
    // Pending NC connector binding awaiting org-admin confirmation. When
    // present (and user is org_admin), <NcBindingApprovalModal/> takes
    // precedence over the onboarding wizard.
    const [pendingNcBinding, setPendingNcBinding] = useState(null);
    // Connector-side bootstrap diagnostics, fetched from /setup/diagnostics
    // when the main SaaS calls fail. Surfaces categorised remediation
    // ("set BEEFLOW_NC_PUBLIC_URL", "SaaS unreachable", …) in the error
    // overlay so admins know what to fix instead of staring at a generic
    // retry button. Admin-only data — see info.xml route gating.
    const [bootstrapDiagnostics, setBootstrapDiagnostics] = useState(null);
    const profileMenuRef = useRef(null);

    // Parse initial agent/conversation from URL
    const initialUrlRef = useRef(parseAgentUrl(window.location.pathname));
    const initialDirectConvRef = useRef(parseDirectChatUrl(window.location.pathname));

    // Boot the session: the shared /auth/user + /auth/my-permissions applier
    // (used by handleLogin too) plus the mount-time auth probe. Same two hooks
    // in the same order, called from the same position — they just live in
    // ./authedApp/useAuthSession now.
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
        setServerAvailable,
        setIsLoading,
    });

    // Handle browser back/forward
    useEffect(() => {
        const handlePopState = () => whenMayNavigate(() => {
            const page = pageFromPath(window.location.pathname);
            setCurrentPage(page);
            setAdminPath(parseAdminPath(window.location.pathname));
            setOrgSettingsPath(parseOrgSettingsPath(window.location.pathname));
            if (page === 'cowork') setInitialCoworkId(parseCoworkUrl(window.location.pathname));
            setInitialDocumentId(parseDocumentUrl(window.location.pathname));
            setFormViewToken(window.location.pathname.match(/^\/app\/forms\/([^/]+)/)?.[1] || null);
            // Sync inline-rendered panels with the URL so back/forward opens or closes them.
            setShowSettings(page === 'settings');
            const isDesigner = page === 'agentDesigner';
            setShowAgentDesigner(isDesigner);
            setShowAgentWizard(page === 'agentWizard');
            const isStudio = page === 'studio';
            setShowStudio(isStudio);
            if (isStudio) setStudioRoute({ ...parseStudioUrl(window.location.pathname), ...parseStudioQuery(window.location.search) });
            if (isDesigner) setInitialDesignerAgentId(parseAgentDesignerUrl(window.location.pathname));
            // Back/forward now moves between the project list and individual
            // projects, which it could not do while this was local state.
            const isProjects = page === 'projects';
            setShowProjects(isProjects);
            setInitialProjectRoute(isProjects ? parseProjectUrl(window.location.pathname) : null);
        });
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    // On first load, redirect legacy ?page= URLs to clean paths
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const legacyPage = params.get('page');
        if (legacyPage && PAGE_ROUTES[legacyPage] && window.location.pathname === '/') {
            window.history.replaceState({}, '', PAGE_ROUTES[legacyPage]);
        }
    }, []);

    // Every in-app navigation. One useCallback, unchanged and still created
    // once at this exact position — the body now lives in
    // ./authedApp/useNavigateToPage.
    const navigateToPage = useNavigateToPage({
        isMobileRef,
        user,
        setCurrentPage,
        setAdminPath,
        setOrgSettingsPath,
        setInitialCoworkId,
        setInitialDocumentId,
        setShowProfileMenu,
        setShowAgentDesigner,
        setShowAgentWizard,
        setShowStudio,
        setStudioRoute,
        setInitialDesignerAgentId,
        setFormViewToken,
        setAppRunId,
        setShowSettings,
        setShowSkillsPanel,
        setShowProjects,
        setInitialProjectRoute,
    });

    // Tell the (above-auth-boundary) EntitlementsProvider to re-resolve whenever
    // auth flips — login/logout/bootstrap all run through setIsAuthenticated, so
    // one effect keyed on it covers every transition. Without this the provider's
    // pre-login snapshot (401 → empty) persists and every capability-gated UI
    // (Studio Webpages tab, etc.) stays hidden after login.
    useEffect(() => {
        window.dispatchEvent(new Event('beeflow:auth-changed'));
    }, [isAuthenticated]);

    // Runtime (remotely-installed) modules add their own Studio sections. On a
    // cold load of a deep link into such a section (e.g. /app/studio/<module>),
    // the runtime map is empty at first parse so parseStudioUrl falls back to
    // 'agents'. Re-parse once the module descriptors arrive so the correct tab
    // renders without a manual refresh. Only touches state while on /app/studio.
    useEffect(() => {
        const onModulesChanged = () => {
            if (pageFromPath(window.location.pathname) === 'studio') {
                setStudioRoute({ ...parseStudioUrl(window.location.pathname), ...parseStudioQuery(window.location.search) });
            }
        };
        window.addEventListener('beeflow:modules-changed', onModulesChanged);
        return () => window.removeEventListener('beeflow:modules-changed', onModulesChanged);
    }, []);

    const handleLogin = async (userData, recoveryKey) => {
        // Hydrate from /auth/user + /auth/my-permissions exactly like a page
        // refresh (checkAuth) via the shared applier, so the sidebar, org
        // branding, feature flags and capability gates reflect the user's real
        // permissions immediately. The thin login response (`userData`) lacks
        // the freshly-computed featureFlags / org / capability data, which is
        // why login previously showed a stale subset until a manual refresh.
        try {
            const userRes = await authFetch(`${API_BASE}/auth/user`, { cache: 'no-store' });
            const data = userRes.ok ? await userRes.json() : null;
            if (data?.authenticated && data.user) {
                const permsRes = await authFetch(`${API_BASE}/auth/my-permissions`);
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
        // Reset to main app view after login (currentPage may still be a homepage route)
        setCurrentPage('agents');
        window.history.pushState({ page: 'agents' }, '', '/app');
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
            await authFetch(`${API_BASE}/auth/logout`, {
                method: 'POST',
            });
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

    // Embedded connector awaiting in-app email verification — show the code
    // screen instead of the login form. The connector has no tenant key yet, so
    // /auth/user reports unauthenticated; the connector's /setup/diagnostics
    // tells us a code was emailed to the org admin.
    if (!isAuthenticated && bootstrapDiagnostics?.state === 'awaiting_email_verification') {
        return <EmailVerificationScreen verification={bootstrapDiagnostics.verification} t={t} />;
    }

    // Not authenticated → show login page directly
    if (!isAuthenticated) {
        return <LoginPage onLogin={handleLogin} />;
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
                        const res = await authFetch(`${API_BASE}/auth/user`, { cache: 'no-store' });
                        if (res.ok) {
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
                        const res = await authFetch(`${API_BASE}/auth/user`, { cache: 'no-store' });
                        if (res.ok) {
                            const data = await res.json();
                            setMfaSetupRequired(!!data.mfaSetupRequired);
                        }
                    } catch (_) { /* leave cleared */ }
                }}
            />
        );
    }

    // Per-route wrapper — a crash inside one panel surfaces only its own
    // boundary, leaving the rest of the app usable. Each lazy() chunk is
    // also wrapped so a network failure during code-split download falls
    // back to the same UI.
    const routed = (label, node) => (
        <ErrorBoundary label={label}>
            <Suspense fallback={<RouteFallback />}>{node}</Suspense>
        </ErrorBoundary>
    );

    const renderContent = () => {
        if (currentPage === 'admin') {
            return routed('admin', <AdminDashboard user={user} onBack={() => navigateToPage('agents')} adminPath={adminPath} onNavigate={navigateToPage} />);
        }
        if (currentPage === 'orgSettings') {
            return routed('orgSettings', <OrgSettings user={user} onBack={() => navigateToPage('agents')} orgSettingsPath={orgSettingsPath} onNavigate={navigateToPage} />);
        }


        if (currentPage === 'components') {
            return routed('components',
                <RequireTier feature="component_designer" onNavigateToLicense={() => navigateToPage('settings')}>
                    <ComponentBuilder onBack={() => navigateToPage('agents')} />
                </RequireTier>
            );
        }

        // The two published-directory pages, Apps and Forms, used to return
        // here and take over the whole viewport — which meant arriving at
        // either one lost the app sidebar, and the only way back was the
        // browser's Back button. They now fall through to AgentHub and render
        // in its inline slot off `currentPage`, the same way Cowork does. (`appRun` below is different on purpose: opening one
        // published app IS a standalone end-user surface.)

        if (currentPage === 'appRun') {
            // Standalone run view for a published App Studio app. The id comes
            // from the URL (/app/apps/:id); ?draft=1 lets the owner preview the
            // working draft (the server enforces owner-only on that flag).
            const appMatch = window.location.pathname.match(/^\/app\/apps\/([^/]+)/);
            const isDraftPreview = new URLSearchParams(window.location.search).get('draft') === '1';
            return routed('appRun', <AppRunPage appId={appMatch?.[1] || appRunId || null} draft={isDraftPreview} />);
        }

        if (currentPage === 'agentDesignerAdvanced') {
            return routed('agentDesignerAdvanced',
                <AgentDesigner
                    onBack={null}
                    initialAgentId={initialDesignerAgentId}
                    user={user}
                    onClose={() => navigateToPage(initialDesignerAgentId ? `agentDesigner:${initialDesignerAgentId}` : 'agentDesigner')}
                    hasPermission={(perm) => {
                        const perms = user?.permissions || [];
                        return perms.includes('all') || perms.includes(perm);
                    }}
                />
            );
        }



        // Meeting Notes now renders inside Studio (see studio handler above).
        // The legacy `/app/meeting-notes` URL is normalised to the Studio
        // route by pageFromPath() / parseStudioUrl().
        if (currentPage === 'meetingNotes') {
            navigateToPage('studio/meeting-notes');
            return null;
        }
        if (currentPage === 'templates') {
            if (user?.featureFlags?.templates === false) return navigateToPage('agents');
            return routed('templates', <TemplatesPage user={user} onBack={() => navigateToPage('agents')} />);
        }
        // Notebooks have no page of their own any more: a notebook is a document
        // type and opens in Studio → Documents. /app/notebooks/<id> already
        // parses into it (pageFromPath, parseStudioUrl); the bare /app/notebooks
        // keeps its frozen page key and is normalised here, like Meeting Notes.
        if (currentPage === 'notebooks') {
            navigateToPage('notebooks', { replace: true });
            return null;
        }

        return <AgentHub onNavigate={navigateToPage} user={user} onUpdateUser={(patch) => setUser(prev => prev ? { ...prev, ...patch } : prev)} initialAgentId={initialUrlRef.current.agentId} initialConversationId={initialUrlRef.current.conversationId} initialDirectConvId={initialDirectConvRef.current} onLogout={handleLogout} currentPage={currentPage} showSettings={showSettings} onCloseSettings={() => {
            setShowSettings(false);
            // Return the URL to the app root when the settings panel closes, so
            // the back button doesn't leave /app/settings stuck in the address bar.
            if (window.location.pathname.startsWith('/app/settings')) {
                setCurrentPage('agents');
                window.history.pushState({ page: 'agents' }, '', '/app');
            }
        }} showAgentDesigner={showAgentDesigner} onCloseAgentDesigner={() => {
            setShowAgentDesigner(false);
            // Return the URL to the app root when the designer closes so /app/agent-designer
            // doesn't stay in the address bar.
            if (window.location.pathname.startsWith('/app/agent-designer')) {
                setCurrentPage('agents');
                window.history.pushState({ page: 'agents' }, '', '/app');
            }
        }} initialDesignerAgentId={initialDesignerAgentId} showAgentWizard={showAgentWizard} onCloseAgentWizard={() => {
            setShowAgentWizard(false);
            if (window.location.pathname.startsWith('/app/agent-wizard')) {
                setCurrentPage('agents');
                window.history.pushState({ page: 'agents' }, '', '/app');
            }
        }} showStudio={showStudio} studioRoute={studioRoute} onCloseStudio={() => {
            setShowStudio(false);
            if (window.location.pathname.startsWith('/app/studio')) {
                setCurrentPage('agents');
                window.history.pushState({ page: 'agents' }, '', '/app');
            }
        }} initialCoworkId={initialCoworkId} initialDocumentId={initialDocumentId} formViewToken={formViewToken} showProjects={showProjects} initialProjectRoute={initialProjectRoute} onProjectRouteChange={(projectId, tab, sub) => whenMayNavigate(() => {
            // The workspace clears its dirty flag before its own confirmed moves,
            // so this guard refuses only moves started outside the workspace
            // (the rail, the switcher).
            // Drives the URL from the app, so a project view — down to one
            // team chat or document inside it — can be linked, bookmarked and
            // reached with the back button. `''` means "open the create form":
            // keep it distinct from the list (null), or the New Project button
            // navigates nowhere.
            const isCreate = projectId === '';
            const route = {
                projectId: isCreate ? '' : (projectId || null),
                tab: isCreate || !projectId ? null : (tab || null),
                sub: isCreate || !projectId || !tab ? null : (sub || null),
            };
            const path = projectRoutePath(route.projectId, route.tab, route.sub);
            setInitialProjectRoute(route);
            setShowProjects(true);
            setCurrentPage('projects');
            // Leaving the create form for the project it just created, or a
            // workspace normalising its own address, replaces rather than
            // pushes, so Back doesn't land on a page that sends you forward.
            const mode = projectHistoryMode(window.location.pathname, path);
            const state = { page: 'projects', projectId: route.projectId };
            if (mode === 'replace') window.history.replaceState(state, '', path);
            else if (mode === 'push') window.history.pushState(state, '', path);
        })} onCloseProjects={() => {
            setShowProjects(false);
            setInitialProjectRoute(null);
            if (window.location.pathname.startsWith('/app/projects')) {
                setCurrentPage('agents');
                window.history.pushState({ page: 'agents' }, '', '/app');
            }
        }} showSkillsPanel={showSkillsPanel} onCloseSkillsPanel={() => setShowSkillsPanel(false)} />;
    };

    return (
        <SubscriptionProvider user={user}>
        <RecorderProvider>
        <CaptureProvider>
        <ProjectCaptureProvider key={user?.id || 'anonymous'} onNavigate={navigateToPage}>
        <div className="flex flex-col" style={{ height: 'var(--app-height)' }}>

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
                    navigateToPage={navigateToPage}
                />
            )}

            {/* Mobile access control: bounce disallowed pages to /app on phones.
                Catches hard deep-links/refresh and viewport resize/rotate (the
                cases navigateToPage's own gate can't see). */}
            {isAuthenticated && (
                <MobileRouteGuard
                    isMobile={isMobile}
                    currentPage={currentPage}
                    navigateToPage={navigateToPage}
                />
            )}

            {/* Content */}
            <div className="flex-1 overflow-hidden">
                {renderContent()}
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
        </RecorderProvider>
        </SubscriptionProvider>
    );
}

export default AuthedApp;
