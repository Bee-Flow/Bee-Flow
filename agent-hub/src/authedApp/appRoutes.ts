import { matchPattern, matchRoute } from '../router/matchRoute';
// Route mapping + URL parsers for the authenticated app shell.
// Extracted verbatim from AuthedApp.jsx — pure constants and helpers only.

// ── Route mapping ──────────────────────────────────────────────
export const PAGE_ROUTES: Record<string, string> = {
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
    // Cowork — the front door for "just do this for me" prompt automation, and
    // the only place it lives: create, correct and run history in one master-
    // detail page. Studio → Automations keeps the flow builder for multi-step work.
    // Legacy /app/work and /app/studio/cowork/:id resolve here too (below).
    cowork: '/app/cowork',
    // Consumer directory of published App Studio apps. The run view for a
    // single app lives at /app/apps/:id (page key 'appRun', matched below).
    apps: '/app/apps',
    // Directory of every form published in the organisation. A form has no
    // detail page of its own — its public address IS the page — so rows here
    // open /f/<token> rather than a /app/forms/:id.
    forms: '/app/forms',
    // The member library keeps the normal sidebar and omits Studio management.
    documents: '/app/documents',
    reports: '/app/reports',
    // Kept for /app/meeting-notes backward-compat — the page now renders
    // inside Studio so /app/meeting-notes redirects to /app/studio/meeting-notes.
    meetingNotes: '/app/meeting-notes',
    templates: '/app/templates',
    // A notebook is a document type now: the library and every notebook live
    // in Studio → Documents, and /app/notebooks[/<id>] parses into it
    // (pageFromPath → studio, studioRoutes.parseStudioUrl → documents).
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
export const MOBILE_ALLOWED_PAGES = new Set(['agents', 'projects', 'settings', 'appRun', 'apps', 'forms', 'formView', 'cowork', 'approvals']);
export const isPageAllowedOnMobile = (page: string) => MOBILE_ALLOWED_PAGES.has(page);

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
export function isApprovalsPageArg(page: unknown): boolean {
    return APPROVALS_SLICE.test(String(page || ''));
}

/** '/app/studio/approvals[/<id>]' — the same slice as the browser spells it. */
export function isApprovalsStudioPath(pathname: unknown): boolean {
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
export function usesStudioRail(page: string, section: string | null = null): boolean {
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

// Inside one project (/app/projects/:id*) the workspace swaps its global
// sidebar for the project's own 240px rail
// (components/projects/workspace/ProjectRail.tsx), exactly as Studio does above.
// The page key is only ever the bare 'projects' for every /app/projects* URL;
// WHICH project (if any) is open lives in the project route, so the caller
// passes its id. The list (no id) and the create form ('new') keep the
// ordinary sidebar: there is no project to show.
export function usesProjectRail(page: string, projectId: unknown): boolean {
    return page === 'projects' && typeof projectId === 'string' && projectId !== '' && projectId !== 'new';
}

// Reduce a navigateToPage() argument (which may be a bare key, a 'studio/agents'
// path form, or an 'agentDesigner:<id>' form) to the canonical page key used by
// MOBILE_ALLOWED_PAGES. Mirrors the alias handling inside navigateToPage().
export function mobilePageKey(page: string | null | undefined): string {
    if (!page || page === '/' || page === 'home') return 'agents';
    // The approvals slice of Studio is phone-allowed (a bell notification
    // links straight to it); map it to its own key so the allow-list can
    // admit it without opening the rest of Studio.
    if (isApprovalsPageArg(page)) return 'approvals';
    const head = String(page).split(/[/:]/)[0];
    if (head === 'webpages' || head === 'meetingNotes' || head === 'meeting-notes') return 'studio';
    return head;
}

// ── The route table ─────────────────────────────────────────────
// One row per address shape, first match wins. A pattern is literal segments,
// `:name` for one segment (`:name?` when it may be absent) and a trailing `*`
// for whatever follows, including nothing. A trailing slash never matters.
//
// `access` says who the page lets in; the page itself refuses everyone else at
// the same address (the admin dashboard, organisation settings and the agent
// editor each render their own refusal). `redirect` is the address a cold load
// forwards to, with `replace`, so Back never returns to the forwarding one: the
// legacy pages that moved into Studio, the desktop client's hand-over addresses
// (desktop/src/main/deepLink.ts: /app/chat, /app/knowledge, /app/tasks) and
// /app/billing, whose target depends on the account (`billing` is resolved by
// navigateToPage).
type RouteAccess = 'member' | 'admin' | 'orgAdmin' | 'manageAgents';

export interface RouteDef {
    pattern: string;
    page: string;
    access?: RouteAccess;
    /** Address template (`:name` filled from the match) or the page name `billing`. */
    redirect?: string;
}

export const APP_ROUTES: readonly RouteDef[] = [
    { pattern: '/', page: 'agents' },
    { pattern: '/app', page: 'agents' },
    { pattern: '/app/admin/*', page: 'admin', access: 'admin' },
    { pattern: '/admin/*', page: 'admin', access: 'admin' },
    { pattern: '/app/org-settings/*', page: 'orgSettings', access: 'orgAdmin' },
    { pattern: '/org-settings/*', page: 'orgSettings', access: 'orgAdmin' },
    { pattern: '/app/settings/*', page: 'settings' },
    // The stable billing entry point: the pricing page and every upgrade link
    // can use it without knowing whether the visitor has a personal or an
    // organisation account. It resolves to the plan page of that account.
    { pattern: '/app/billing/*', page: 'billing', redirect: 'billing' },
    { pattern: '/app/agent-designer-advanced/:agentId?', page: 'agentDesignerAdvanced', access: 'manageAgents' },
    // Without an agent the editor is Studio's agents section; with one it is
    // that agent's editor at its own address.
    { pattern: '/app/agent-designer', page: 'agentDesigner', access: 'manageAgents', redirect: '/app/studio/agents' },
    { pattern: '/app/agent-designer/:agentId/*', page: 'agentDesigner', access: 'manageAgents' },
    { pattern: '/app/agent-wizard/*', page: 'agentWizard', access: 'manageAgents' },
    // Cowork's previous life as a Studio tab, matched before the Studio rule.
    { pattern: '/app/studio/cowork/:coworkId?', page: 'cowork' },
    // Studio's sections are not routes: /app/studio/<segment> is read by
    // components/admin/Studio/studioRoutes.ts from the Studio app registry.
    { pattern: '/app/studio/*', page: 'studio' },
    // The old standalone automations page, under its three names. Kept for
    // good: a link in someone's mailbox does not expire when we ship.
    { pattern: '/app/automations/*', page: 'studio' },
    { pattern: '/app/routines/*', page: 'studio' },
    { pattern: '/app/ai-tasks/*', page: 'studio' },
    { pattern: '/app/cowork/:coworkId?', page: 'cowork' },
    { pattern: '/app/work/:coworkId?', page: 'cowork' },
    { pattern: '/app/documents/*', page: 'documents' },
    // A notebook is a document type: the library and every notebook live in
    // Studio → Documents.
    { pattern: '/app/notebooks', page: 'notebooks', redirect: '/app/studio/documents' },
    { pattern: '/app/notebooks/:id/*', page: 'studio' },
    { pattern: '/app/projects/*', page: 'projects' },
    { pattern: '/app/webpages', page: 'webpages', redirect: '/app/studio/webpages' },
    { pattern: '/app/webpages/:id/*', page: 'studio' },
    // The directory of published apps, then the run view of one app. The run
    // view is the standalone end-user surface; the directory keeps the sidebar.
    { pattern: '/app/apps', page: 'apps' },
    { pattern: '/app/apps/:appId/*', page: 'appRun' },
    // Every published form, then one form rendered inside the workspace (the
    // same page answers anonymously at /f/:token).
    { pattern: '/app/forms', page: 'forms' },
    { pattern: '/app/forms/:token/*', page: 'formView' },
    { pattern: '/app/meeting-notes', page: 'meetingNotes', redirect: '/app/studio/meeting-notes' },
    { pattern: '/app/meeting-notes/*', page: 'studio' },
    { pattern: '/app/reports', page: 'reports' },
    { pattern: '/app/templates', page: 'templates' },
    // The desktop client's hand-over addresses.
    { pattern: '/app/knowledge', page: 'studio', redirect: '/app/studio/knowledge' },
    { pattern: '/app/knowledge/:id/*', page: 'studio', redirect: '/app/studio/knowledge/:id' },
    { pattern: '/app/chat', page: 'agents', redirect: '/app' },
    { pattern: '/app/chat/:id/*', page: 'agents', redirect: '/app/d/:id' },
    { pattern: '/app/tasks', page: 'cowork', redirect: '/app/cowork' },
    { pattern: '/app/tasks/:id/*', page: 'cowork', redirect: '/app/cowork/:id' },
    // Chat addresses: an agent (short id, optional conversation) or a direct
    // conversation, under /app and in their bare legacy form.
    { pattern: '/app/a/:agentId/:conversationId?', page: 'agents' },
    { pattern: '/app/agent/:agentId/:conversationId?', page: 'agents' },
    { pattern: '/app/d/:conversationId', page: 'agents' },
    { pattern: '/a/:agentId/:conversationId?', page: 'agents' },
    { pattern: '/agent/:agentId/:conversationId?', page: 'agents' },
    { pattern: '/d/:conversationId', page: 'agents' },
    // /login is the app home on purpose: login renders in place, and the
    // server keeps mailing this address with the query the boot code reads
    // (?verified=, ?signup=, ?reset=, ?error=; core/appPaths.legacyLoginPath).
    // Declared ahead of the legacy ?page= lookup, so /login?page=<key> opens
    // the home page rather than that key.
    { pattern: '/login/*', page: 'agents' },
    { pattern: '/app/*', page: 'agents' },
];

/** Where an address lands: the page, the named segments and the forward it asks for. */
export interface AppRoute {
    page: string;
    params: Record<string, string>;
    pathname: string;
    search: string;
    /** The address (or `billing`) a cold load replaces this one with; null when the page renders here. */
    redirect: string | null;
}

export { matchPattern };

function fillTemplate(template: string, params: Record<string, string>): string {
    return template.replace(/:([a-zA-Z]+)/g, (_, name: string) => params[name] ?? '');
}

/**
 * The app route of an address. An address no row fits is the home page,
 * unless its query carries the legacy `?page=<key>` of a canonical page.
 */
export function matchAppRoute(pathname: string, search = ''): AppRoute {
    const hit = matchRoute(APP_ROUTES, pathname);
    if (hit) {
        const { route, params } = hit;
        const redirect = route.redirect ? (route.redirect.startsWith('/') ? fillTemplate(route.redirect, params) : route.redirect) : null;
        return { page: route.page, params, pathname, search, redirect };
    }
    const legacyPage = new URLSearchParams(search).get('page');
    const page = legacyPage && PAGE_ROUTES[legacyPage] ? legacyPage : 'agents';
    return { page, params: {}, pathname, search, redirect: null };
}

/**
 * The page key of an address. The legacy `?page=` is read from the browser's
 * own query, and only for an address no row claims (this function also runs
 * under the native app's tests, where there is no window).
 */
export function pageFromPath(pathname: string): string {
    const hit = matchRoute(APP_ROUTES, pathname);
    if (hit) return hit.route.page;
    return matchAppRoute(pathname, typeof window === 'undefined' ? '' : window.location.search).page;
}

// The URL parsers the pages are opened with (admin and organisation segments,
// chat ids, cowork ids, the Nextcloud app-menu param) live in ./urlParsers.ts.
