// Route mapping + URL parsers for the authenticated app shell.
// Extracted verbatim from AuthedApp.jsx — pure constants and helpers only.

// ── Route mapping ──────────────────────────────────────────────
export const PAGE_ROUTES = {
    // ── App routes (all under /app/) ──
    agents: '/app',
    admin: '/app/admin',
    orgSettings: '/app/org-settings',
    settings: '/app/settings',
    // Plans, invoices and checkout. Billing used to be buried in a Settings
    // sub-tab with no route of its own, so the pricing page's
    // /app/billing?plan=<id> links 404'd and the chosen plan was dropped.
    billing: '/app/billing',
    agentDesigner: '/app/agent-designer',
    agentDesignerAdvanced: '/app/agent-designer-advanced',
    agentWizard: '/app/agent-wizard',
    // Studio is one page with sections below it, and its sections are NOT page
    // routes: /app/studio/<segment> is derived from the Studio app registry
    // (components/admin/Studio/studioApps.jsx → studioRoutes.js), so a new
    // section — Runs & logboek at /app/studio/runs is the next one (B9) — is an
    // entry in that registry and needs nothing here. Adding a page key for one
    // would create a second URL surface for the same screen.
    studio: '/app/studio',
    // URL slug renamed from /app/ai-tasks → /app/routines (Aug 2026 rename).
    // Old paths still parse below — permanently, not "for one release": a link
    // in someone's mailbox does not expire when we ship.
    aiTasks: '/app/routines',
    // Cowork — the front door for "just do this for me" prompt automation, and
    // the only place it lives: create, correct and run history in one master-
    // detail page. /app/routines keeps the flow builder for multi-step work.
    // Legacy /app/work and /app/studio/cowork/:id resolve here too (below).
    cowork: '/app/cowork',
    // Consumer directory of published App Studio apps. The run view for a
    // single app lives at /app/apps/:id (page key 'appRun', matched below).
    apps: '/app/apps',
    // Directory of every form published in the organisation. A form has no
    // detail page of its own — its public address IS the page — so rows here
    // open /f/<token> rather than a /app/forms/:id.
    forms: '/app/forms',
    reports: '/app/reports',
    components: '/app/components',
    // Kept for /app/meeting-notes backward-compat — the page now renders
    // inside Studio so /app/meeting-notes redirects to /app/studio/meeting-notes.
    meetingNotes: '/app/meeting-notes',
    templates: '/app/templates',
    notebooks: '/app/notebooks',
    // Projects had NO route at all: the list and detail views were pure local
    // state in AgentHub, so they could not be linked, bookmarked, reached with
    // the back button, or survive a reload. For a feature whose entire point is
    // "send this to a colleague", that was the sharpest edge in it.
    projects: '/app/projects',
    webpages: '/app/webpages',
};

// ── Mobile access control ──────────────────────────────────────
// Phones (<768px) are a focused view/chat-only surface. Only these page keys
// are allowed; everything else (studio, admin, org settings, the agent
// editors/wizard, notebooks, etc.) redirects to /app. Deny-by-default
// so new desktop-only pages are blocked automatically. 'agents' already covers
// /app, /app/a/:id (agent chat) and /app/d/:id (direct chat).
// 'appRun' (published App Studio apps) is deliberately phone-friendly — the
// runtime stacks sections below 640px. 'apps' (the published-apps directory)
// stacks its tile grid to a single column, so it's phone-friendly too.
// 'cowork' is phone-friendly by design — delegating a task from your phone and
// reading the result later is the case Cowork exists for. The page collapses
// to the list, with a selected item taking the whole screen.
// 'approvals' is the /app/studio/approvals slice only (see mobilePageKey and
// MobileRouteGuard): deciding an approval from the phone the notification
// landed on is the point of assignable approvals.
//
// Adding a page here is not a nav decision, it is a promise that the screen
// works on a phone. Note the asymmetry with the native app while you are in
// here: Expo HAS /notebooks, /projects, /knowledge and /recordings screens, so
// a notification tapped on the phone opens them — while this list keeps the
// same pages off mobile WEB, where they would render a desktop layout. A new
// top-level sidebar row for one of them (Notebooks, Meetings) therefore needs
// either a phone-shaped page and an entry here, or the row hidden below 768px;
// without one of the two, tapping it bounces to /app via MobileRouteGuard.
export const MOBILE_ALLOWED_PAGES = new Set(['agents', 'settings', 'appRun', 'apps', 'forms', 'formView', 'cowork', 'approvals']);
export const isPageAllowedOnMobile = (page) => MOBILE_ALLOWED_PAGES.has(page);

// ── The approvals slice of Studio (B2) ─────────────────────────────────
// Goedkeuringen keeps its address. /app/studio/approvals[/<id>] is minted by
// approvalNotify/approvalHooks/approvalLifecycle, carried by the Nextcloud Talk
// cards and translated by the Expo app, so the redesign moved the CHROME (a
// top-level sidebar row instead of a Studio tab) and left the URL alone.
//
// The slice is spoken in two shapes — a navigateToPage argument
// ('studio/approvals/apr_1') and a real pathname ('/app/studio/approvals/apr_1')
// — and each used to carry its own regex, in two files. One source now:
// mobilePageKey and MobileRouteGuard cannot drift into disagreeing about which
// slice of Studio a phone may open, which is the only thing standing between an
// approval push and a bounce to /app (pageFromPath answers 'studio' here, never
// 'approvals').
const APPROVALS_SLICE = /^studio\/approvals(\/|$)/;

/** 'studio/approvals[/<id>]' — the slice as navigateToPage spells it. */
export function isApprovalsPageArg(page) {
    return APPROVALS_SLICE.test(String(page || ''));
}

/** '/app/studio/approvals[/<id>]' — the same slice as the browser spells it. */
export function isApprovalsStudioPath(pathname) {
    return isApprovalsPageArg(String(pathname || '').replace(/^\/app\//, ''));
}

// ── The Studio rail (H1) ───────────────────────────────────────────────
// On /app/studio* the workspace swaps its global sidebar for Studio's own
// 240px rail (components/admin/Studio/StudioRail.jsx).
//
// A FLAG, not a route. PAGE_ROUTES stays byte-identical: Studio already has
// an address, and a second page key for the same screen is a second URL
// surface that then drifts (see "keeps Studio sections OUT of the page
// table" in appRoutes.test.js). The flag lives here rather than in the
// sidebar because "which page is this" is this file's question — but the
// SWAP happens in Sidebar.jsx, which is the only component that also knows
// whether it is rendering below the mobile breakpoint, where the rail is not
// offered at all and the ordinary sidebar + Studio flyout stays.
export function usesStudioRail(page, section = null) {
    if (page !== 'studio') return false;
    // ONE Studio address does NOT get the rail: Approvals. It is a Studio URL
    // with a non-Studio audience — deciding is a member act, not a builder
    // one, which is why the section is `hiddenFromNav` and has its own
    // top-level sidebar row instead. An approval bell is the usual way in, so
    // swapping a decider's sidebar for a builder's rail that does not even
    // list the screen they are standing on would strand them one tap from
    // everything they came for.
    if (section === 'approvals') return false;
    return true;
}

// Reduce a navigateToPage() argument (which may be a bare key, a 'studio/agents'
// path form, or an 'agentDesigner:<id>' form) to the canonical page key used by
// MOBILE_ALLOWED_PAGES. Mirrors the alias handling inside navigateToPage().
export function mobilePageKey(page) {
    if (!page || page === '/' || page === 'home') return 'agents';
    // The approvals slice of Studio is phone-allowed (a bell notification
    // links straight to it); map it to its own key so the allow-list can
    // admit it without opening the rest of Studio.
    if (isApprovalsPageArg(page)) return 'approvals';
    const head = String(page).split(/[/:]/)[0];
    if (head === 'webpages' || head === 'meetingNotes' || head === 'meeting-notes') return 'studio';
    return head;
}

// Reverse lookup: path → page key
const PATH_TO_PAGE = Object.fromEntries(
    Object.entries(PAGE_ROUTES).map(([page, path]) => [path, page])
);

export function pageFromPath(pathname) {
    // Root → agents (redirect to /app)
    if (pathname === '/') return 'agents';
    // Exact match for app routes
    if (PATH_TO_PAGE[pathname]) return PATH_TO_PAGE[pathname];
    // /app/admin or /app/admin/* → admin page
    if (pathname === '/app/admin' || pathname.startsWith('/app/admin/')) return 'admin';
    // Legacy bare /admin → redirect to /app/admin (handled below)
    if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
    // /app/org-settings or /app/org-settings/* → orgSettings
    if (pathname === '/app/org-settings' || pathname.startsWith('/app/org-settings/')) return 'orgSettings';
    // Legacy bare /org-settings
    if (pathname === '/org-settings' || pathname.startsWith('/org-settings/')) return 'orgSettings';
    // /app/settings or /app/settings/* → settings
    if (pathname === '/app/settings' || pathname.startsWith('/app/settings/')) return 'settings';
    // /app/billing (+ /app/billing/* for future sub-tabs) → billing
    if (pathname === '/app/billing' || pathname.startsWith('/app/billing/')) return 'billing';
    // /app/agent-designer-advanced or /app/agent-designer-advanced/* → agentDesignerAdvanced (legacy form)
    if (pathname === '/app/agent-designer-advanced' || pathname.startsWith('/app/agent-designer-advanced/')) return 'agentDesignerAdvanced';
    // /app/agent-designer or /app/agent-designer/* → agentDesigner (unified studio)
    if (pathname === '/app/agent-designer' || pathname.startsWith('/app/agent-designer/')) return 'agentDesigner';
    // /app/agent-wizard → agentWizard
    if (pathname === '/app/agent-wizard' || pathname.startsWith('/app/agent-wizard/')) return 'agentWizard';
    // Cowork used to be a Studio tab. Its deep links keep working, but they
    // resolve to the standalone page now — matched BEFORE the generic Studio
    // rule below, which would otherwise swallow them.
    if (pathname === '/app/studio/cowork' || pathname.startsWith('/app/studio/cowork/')) return 'cowork';
    // /app/studio (and sub-sections) → unified Studio
    if (pathname === '/app/studio' || pathname.startsWith('/app/studio/')) return 'studio';
    // /app/routines or /app/routines/* → aiTasks (internal page key kept for stability)
    if (pathname === '/app/routines' || pathname.startsWith('/app/routines/')) return 'aiTasks';
    // Backward-compat: legacy /app/ai-tasks paths still resolve to the same page
    if (pathname === '/app/ai-tasks' || pathname.startsWith('/app/ai-tasks/')) return 'aiTasks';
    // /app/cowork (+ /app/cowork/:id for the detail pane) → Cowork.
    // /app/work is what this page was called before the rename; kept so
    // bookmarks and the old sidebar entry still land somewhere.
    if (pathname === '/app/cowork' || pathname.startsWith('/app/cowork/')) return 'cowork';
    if (pathname === '/app/work' || pathname.startsWith('/app/work/')) return 'cowork';
    // /app/notebooks/:id → notebooks page (must come before generic /app/*)
    if (pathname.startsWith('/app/notebooks')) return 'notebooks';
    // /app/projects, /app/projects/:id, /app/projects/:id/:tab
    if (pathname.startsWith('/app/projects')) return 'projects';
    // /app/webpages/:id → unified Studio (Webpages tab)
    if (pathname.startsWith('/app/webpages')) return 'studio';
    // /app/apps → the published-apps directory (consumer gallery). Must be
    // matched BEFORE the /app/apps/:id run view so the bare path resolves here.
    if (pathname === '/app/apps' || pathname === '/app/apps/') return 'apps';
    // /app/forms → every form published in the organisation. No /app/forms/:id
    // yet: a form's own page IS its public address, so a row opens /f/<token>.
    if (pathname === '/app/forms' || pathname === '/app/forms/') return 'forms';
    // /app/forms/:token → the form itself, rendered INSIDE the workspace so the
    // sidebar stays. The same page also answers anonymously at /f/:token; this
    // is the signed-in way in, and the address is shareable with a colleague.
    if (pathname.startsWith('/app/forms/')) return 'formView';
    // /app/apps/:id → standalone App Studio run view (end users open a
    // published app without the Studio shell). The editor lives at
    // /app/studio/apps.
    if (pathname.startsWith('/app/apps/')) return 'appRun';
    // /app/meeting-notes → unified Studio (Meeting Notes tab)
    if (pathname === '/app/meeting-notes' || pathname.startsWith('/app/meeting-notes/')) return 'studio';

    // /app/a/:shortId or /app/agent/:id → agents page
    if (pathname.startsWith('/app/a/') || pathname.startsWith('/app/agent/')) return 'agents';
    // /app/d/:convId → direct chat
    if (pathname.startsWith('/app/d/')) return 'agents';
    // Legacy bare paths (backward compat)
    if (pathname.startsWith('/a/') || pathname.startsWith('/agent/')) return 'agents';
    if (pathname.startsWith('/d/')) return 'agents';
    // /login → the app home, on purpose (B1). There is no /login ROUTE and
    // there will not be one: login renders in place, so a new top-level path
    // would buy nothing and cost nginx, the SPA fallback, the self-host compose
    // and e2e. But the server keeps sending people here, those links sit in
    // mailboxes, and the boot code reads their query string:
    //   auth/login/emailVerificationRoutes.js  ?verified=1, ?error=verify_*
    //   auth/login/inviteRoutes.js             ?signup=1,   ?error=invite_*
    //   auth/login/passwordResetRoutes.js      ?reset=<token>
    // all three via core/appPaths.legacyLoginPath, which appPaths.test.js
    // freezes. NOT auth/admin/invitationRoutes.js: the invite mail deliberately
    // carries /auth/redeem-invite/<token> instead, so the token never lands in
    // the URL bar, the Referer header or proxy logs — it arrives here as the
    // ?signup=1 redirect that endpoint fires.
    //
    // Registered as a declared alias rather than left to the fall-through
    // below: /login does not start with /app/, so it used to reach the legacy
    // ?page= branch and then the default return. One behaviour change came
    // with that — /login?page=<a PAGE_ROUTES key> used to open that page and
    // now always opens agents. Nothing mints that shape; the query params the
    // mails carry are the ones above. (/settings/billing, the Stripe portal's
    // fallback return, still rides the fall-through — see
    // legacyBillingSettingsPath.)
    if (pathname === '/login' || pathname.startsWith('/login/')) return 'agents';
    // /app/* catch-all → agents
    if (pathname.startsWith('/app/')) return 'agents';
    // Legacy ?page= param support (backward compat)
    const params = new URLSearchParams(window.location.search);
    const legacyPage = params.get('page');
    if (legacyPage && PAGE_ROUTES[legacyPage]) return legacyPage;
    // Default — redirect everything to app
    return 'agents';
}

// Parse /app/admin/{seg1}/{seg2}/{seg3} from the URL
export function parseAdminPath(pathname) {
    const match = pathname.match(/^\/(?:app\/)?admin(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?/);
    return {
        seg1: match?.[1] || '',
        seg2: match?.[2] || '',
        seg3: match?.[3] || '',
    };
}

// Parse /app/org-settings/{seg1}/{seg2} from the URL
export function parseOrgSettingsPath(pathname) {
    const match = pathname.match(/^\/(?:app\/)?org-settings(?:\/([^/]+))?(?:\/([^/]+))?/);
    return {
        seg1: match?.[1] || '',
        seg2: match?.[2] || '',
    };
}

// Parse the agent id out of /app/agent-designer/{agentId} (trailing segments ignored).
export function parseAgentDesignerUrl(pathname) {
    const match = pathname.match(/^\/app\/agent-designer(?:-advanced)?(?:\/([^/]+))?/);
    return match?.[1] || null;
}

// parseStudioUrl (parsing /app/studio/* + legacy /app/webpages, /app/meeting-notes)
// now lives in ../components/admin/Studio/studioRoutes.js, derived from the
// Studio app registry.

// Parse the task id out of /app/routines/{taskId} or legacy /app/ai-tasks/{taskId}.
// Trailing segments ignored.
export function parseAITasksUrl(pathname) {
    const match = pathname.match(/^\/app\/(?:routines|ai-tasks)(?:\/([^/]+))?/);
    return match?.[1] || null;
}

// Extract the cowork id from /app/cowork/:id, plus the two legacy shapes it
// used to live at: /app/work/:id and the Studio tab /app/studio/cowork/:id.
export function parseCoworkUrl(pathname) {
    const match = pathname.match(/^\/app\/(?:studio\/cowork|cowork|work)(?:\/([^/]+))?/);
    return match?.[1] || null;
}

// Extract agent ID prefix and conversation ID prefix from URL
// Supports: /app/a/:shortId, /app/a/:shortId/:shortConvId, /app/agent/:fullId, and legacy bare forms
export function parseAgentUrl(pathname) {
    const match = pathname.match(/^\/(?:app\/)?(?:a|agent)\/([a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9_-]+))?/);
    if (match) {
        return { agentId: match[1], conversationId: match[2] || null };
    }
    return { agentId: null, conversationId: null };
}

// Extract direct chat conversation ID from URL: /app/d/:shortConvId (legacy: /d/:shortConvId)
export function parseDirectChatUrl(pathname) {
    const match = pathname.match(/^\/(?:app\/)?d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

// Extract notebook ID from URL: /app/notebooks/:id
export function parseNotebookUrl(pathname) {
    const match = pathname.match(/^\/app\/notebooks\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

// A Studio app opened from its own Nextcloud app-menu entry. The connector's
// per-entry page script (nextcloud-connector/src/studioAppMenus.js) mounts the
// SPA iframe at the signed-proxy ROOT with `?ncStudioApp=<appId>` — inside
// Nextcloud the pathname is the proxy path and never matches /app/apps/:id,
// so the boot route comes from this query param instead.
export function parseNcStudioAppParam() {
    try {
        const id = new URLSearchParams(window.location.search).get('ncStudioApp');
        // App ids are UUIDs; refuse anything else so a mangled param falls
        // back to the normal home screen instead of a broken run view.
        return (id && /^[0-9a-f-]{36}$/i.test(id)) ? id : null;
    } catch (_) {
        return null;
    }
}

// Reserved top-level paths + CMS slug routing rules live in
// utils/cmsPublicRouting.js (shared with the CMS editor's slug warnings).
