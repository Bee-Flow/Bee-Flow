import { HOME, type Shows } from './navigationHarness';

/**
 * Every page or view agent-hub can show, the address that opens it and the
 * navigation call that reaches it: the contract a router has to keep.
 *
 * The address is the state: router/history.ts publishes every move (navigate()
 * and popstate), authedApp/useAppRoute.ts derives the page and its ids from
 * the address through the route table in authedApp/appRoutes.ts, and
 * authedApp/navigationTargets.ts turns the page names the 180 onNavigate call
 * sites speak into one address each. AgentHub picks its main-content slot from
 * the derived flags (AgentHub/HubMainContent.tsx); AppRoutes.tsx answers the
 * public paths (embed, demo, forms, public apps, DSR, the marketing gate)
 * before any of that.
 *
 * The onNavigate / navigateToPage call sites outside tests name these
 * families: studio 46, admin 20, agents 9, settings 3, notebooks 2, forms 2,
 * projects 1, org-settings 1, cowork 1, agentDesigner 1 (the rest build the
 * target at run time).
 *
 * `flags` names what useAppRoute derives for the row (the ids handed to the
 * page). A row with `fails` pins a bug: its test asserts what a person would
 * expect and runs as `it.fails`, so fixing the bug turns it red and the mark
 * has to go.
 */
export interface Row {
    /** The page key of the route (appRoutes.ts). */
    page: string;
    /** What the route derives for the page (ids and flags it is opened with). */
    flags?: string;
    /** The address a cold load starts at. */
    url: string;
    /** Where the address bar ends up when the app rewrites it on load; default `url`. */
    lands?: string;
    shows: Shows;
    /** The navigateToPage target (what an `onNavigate` call passes); none = only reachable by address. */
    nav?: string;
    /** The address that call writes; default `lands ?? url`. */
    navUrl?: string;
    /** One line each: why the expected behaviour fails today, for the cold load and for the navigation call. */
    fails?: { load?: string; nav?: string };
}

export const APP_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

export const INVENTORY: Row[] = [
    // ── Home and chat (AgentHub writes /app/a/… and /app/d/… itself) ───────
    { page: 'agents', url: '/app', shows: HOME, nav: 'home' },
    { page: 'agents', flags: 'initialAgentId', url: '/app/a/ag1', shows: HOME },
    { page: 'agents', flags: 'initialAgentId, initialConversationId', url: '/app/a/ag1/c1', shows: HOME },
    { page: 'agents', flags: 'initialAgentId', url: '/app/agent/ag1', shows: HOME },
    { page: 'agents', flags: 'initialDirectConvId', url: '/app/d/c1', shows: { testId: 'chat-input-form' } },
    { page: 'agents', flags: 'initialAgentId (legacy bare path)', url: '/a/ag1', shows: HOME },
    { page: 'agents', flags: 'initialDirectConvId (legacy bare path)', url: '/d/c1', shows: { testId: 'chat-input-form' } },
    // ── Settings, the admin dashboard, organisation settings ──────────────
    { page: 'settings', flags: 'showSettings', url: '/app/settings', shows: { current: 'settings-nav-preferences' }, nav: 'settings' },
    { page: 'settings', flags: 'showSettings', url: '/app/settings/memory', shows: { current: 'settings-nav-memory' }, nav: 'settings/memory' },
    { page: 'admin', flags: 'adminPath', url: '/app/admin', shows: { nav: 'Admin Dashboard' }, nav: 'admin' },
    { page: 'admin', flags: 'adminPath', url: '/app/admin/ai-config', shows: { nav: 'AI Configuration' }, nav: 'admin/ai-config' },
    { page: 'admin', flags: 'adminPath (legacy bare path)', url: '/admin', shows: { nav: 'Admin Dashboard' } },
    { page: 'orgSettings', flags: 'orgSettingsPath', url: '/app/org-settings', shows: { heading: 'Organisation Settings' }, nav: 'orgSettings' },
    { page: 'orgSettings', flags: 'orgSettingsPath', url: '/app/org-settings/agents', shows: { heading: 'Organisation Settings' }, nav: 'org-settings/agents' },
    { page: 'orgSettings', flags: 'orgSettingsPath (legacy bare path)', url: '/org-settings', shows: { heading: 'Organisation Settings' } },
    { page: 'billing', flags: '→ the organisation licence page (replace)', url: '/app/billing', lands: '/app/admin/organisation/license', shows: { nav: 'Admin Dashboard' }, nav: 'billing' },
    // ── Agent editors ─────────────────────────────────────────────────────
    // Without an agent the editor is Studio's agents section (replace, so Back skips it).
    { page: 'agentDesigner', flags: '→ studio/agents (replace)', url: '/app/agent-designer', lands: '/app/studio/agents', shows: { current: 'rail-agents' }, nav: 'agentDesigner' },
    { page: 'agentDesigner', flags: 'showAgentDesigner, designerAgentId', url: '/app/agent-designer/ag1', shows: { heading: 'Agents' }, nav: 'agentDesigner:ag1' },
    // The wizard has its own address and keeps it (AgentStudio only moves to Studio inside Studio).
    { page: 'agentWizard', flags: 'showAgentWizard', url: '/app/agent-wizard', shows: { text: 'Create empty agent' }, nav: 'agentWizard' },
    { page: 'agentDesignerAdvanced', flags: 'designerAgentId', url: '/app/agent-designer-advanced', shows: { text: 'Agent Designer' }, nav: 'agentDesignerAdvanced' },
    { page: 'agentDesignerAdvanced', flags: 'designerAgentId', url: '/app/agent-designer-advanced/ag1', shows: { text: 'Agent Designer' }, nav: 'agentDesignerAdvanced:ag1' },
    // ── Studio ────────────────────────────────────────────────────────────
    { page: 'studio', flags: 'showStudio, studioRoute', url: '/app/studio', shows: { testId: 'studio-start' } },
    // 'studio' alone opens the agents section, not the Start page /app/studio shows.
    { page: 'studio', flags: 'showStudio, studioRoute', url: '/app/studio/agents', shows: { current: 'rail-agents' }, nav: 'studio' },
    { page: 'studio', flags: 'showStudio, studioRoute', url: '/app/studio/automations', shows: { current: 'rail-aiTasks' }, nav: 'studio/automations' },
    { page: 'studio', flags: 'showStudio, studioRoute (id, view)', url: '/app/studio/automations/t1?view=runs', shows: { current: 'rail-aiTasks' }, nav: 'studio/automations/t1?view=runs' },
    { page: 'studio', flags: 'showStudio, studioRoute (id)', url: '/app/studio/knowledge/kb1', shows: { testId: 'kb-detail-page' }, nav: 'studio/knowledge/kb1' },
    { page: 'studio', flags: 'showStudio, studioRoute', url: '/app/studio/meeting-notes', shows: { current: 'rail-meetingNotes' }, nav: 'studio/meeting-notes' },
    { page: 'studio', flags: 'showStudio, studioRoute', url: '/app/studio/webpages', shows: { current: 'rail-webpages' }, nav: 'webpages' },
    { page: 'studio', flags: 'showStudio, studioRoute (id)', url: '/app/studio/webpages/w1', shows: { current: 'rail-webpages' }, nav: 'webpages/w1' },
    { page: 'studio', flags: 'showStudio, studioRoute (approval)', url: '/app/studio/approvals/apr1', shows: { text: 'All approvals' }, nav: 'studio/approvals/apr1' },
    { page: 'studio', flags: 'legacy automations page', url: '/app/automations/t1', shows: { current: 'rail-aiTasks' }, nav: 'aiTasks:t1', navUrl: '/app/studio/automations/t1' },
    { page: 'studio', flags: 'legacy automations page', url: '/app/routines', shows: { current: 'rail-aiTasks' } },
    { page: 'studio', flags: 'legacy automations page', url: '/app/ai-tasks', shows: { current: 'rail-aiTasks' } },
    { page: 'notebooks', flags: '→ studio/documents (replace)', url: '/app/notebooks', lands: '/app/studio/documents', shows: { current: 'rail-documents' }, nav: 'notebooks' },
    { page: 'studio', flags: 'showStudio, studioRoute (notebook)', url: '/app/notebooks/n1', shows: { testId: 'notebook-load-error' }, nav: 'notebooks/n1', navUrl: '/app/studio/documents/notebook/n1' },
    { page: 'meetingNotes', flags: '→ studio/meeting-notes', url: '/app/meeting-notes', lands: '/app/studio/meeting-notes', shows: { current: 'rail-meetingNotes' } },
    { page: 'webpages', flags: '→ studio/webpages (replace)', url: '/app/webpages', lands: '/app/studio/webpages', shows: { current: 'rail-webpages' } },
    // ── Cowork ────────────────────────────────────────────────────────────
    { page: 'cowork', flags: 'initialCoworkId', url: '/app/cowork', shows: { testId: 'cowork-welcome' }, nav: 'cowork' },
    // From another page an item pushes (Back returns there); inside Cowork a row replaces (Back leaves Cowork).
    { page: 'cowork', flags: 'initialCoworkId', url: '/app/cowork/cw1', shows: { testId: 'cowork-welcome' }, nav: 'cowork/cw1' },
    { page: 'cowork', flags: 'initialCoworkId (legacy)', url: '/app/work', shows: { testId: 'cowork-welcome' } },
    { page: 'cowork', flags: 'initialCoworkId (legacy Studio tab)', url: '/app/studio/cowork/cw1', shows: { testId: 'cowork-welcome' } },
    // ── Documents, projects, published apps and forms ─────────────────────
    { page: 'documents', flags: 'initialDocumentId', url: '/app/documents', shows: { testId: 'documents-library' }, nav: 'documents' },
    { page: 'documents', flags: 'initialDocumentId', url: '/app/documents/d1', shows: { text: 'Document not found.' }, nav: 'documents/d1' },
    { page: 'projects', flags: 'showProjects, initialProjectRoute', url: '/app/projects', shows: { testId: 'projects-home' }, nav: 'projects' },
    { page: 'projects', flags: 'showProjects, initialProjectRoute (create)', url: '/app/projects/new', shows: { testId: 'project-create' }, nav: 'projects/new' },
    { page: 'projects', flags: 'showProjects, initialProjectRoute (id)', url: '/app/projects/p1', shows: { current: 'project-rail-overview' }, nav: 'projects/p1' },
    { page: 'projects', flags: 'showProjects, initialProjectRoute (id, tab)', url: '/app/projects/p1/chats', shows: { current: 'project-rail-chats' }, nav: 'projects/p1/chats' },
    { page: 'apps', url: '/app/apps', shows: { heading: 'Apps' }, nav: 'apps' },
    { page: 'appRun', flags: 'appRunId', url: `/app/apps/${APP_ID}`, shows: { text: 'This app is not available to you' }, nav: `apps/${APP_ID}` },
    { page: 'forms', url: '/app/forms', shows: { heading: 'Forms' }, nav: 'forms' },
    { page: 'formView', flags: 'formViewToken', url: '/app/forms/tok1', shows: { heading: 'This form is not available' }, nav: 'forms/tok1' },
    { page: 'templates', url: '/app/templates', shows: { heading: 'Word Templates' }, nav: 'templates' },
    { page: 'reports', flags: 'a PAGE_ROUTES key no page renders', url: '/app/reports', shows: HOME, nav: 'reports' },
];

export const landing = (row: Row) => row.lands ?? row.url;
