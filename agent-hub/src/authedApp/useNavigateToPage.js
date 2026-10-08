import { mayNavigate } from '../utils/unsavedNavigation';
import { useCallback } from 'react';
import {
    PAGE_ROUTES,
    isPageAllowedOnMobile,
    mobilePageKey,
    parseAdminPath,
    parseOrgSettingsPath,
    documentRoutePath,
} from './appRoutes';
import { isProjectsPage, projectRouteFromPage } from './projectNavigation';
import { parseStudioQuery, sectionFromRaw, segmentForSection } from '../components/admin/Studio/studioRoutes';
import { projectRoutePath } from '../utils/projectRoutes';

// The app-shell `navigateToPage` callback, extracted verbatim from AuthedApp's
// <App/>. Must be called from the exact same hook position as the original
// useCallback — it contains exactly one hook. All state setters (stable) plus
// `isMobileRef` and `user` are threaded in; like the original, the callback is
// created once ([] deps) and closes over the first render's values.
export function useNavigateToPage({
    isMobileRef,
    user,
    setCurrentPage,
    setAdminPath,
    setOrgSettingsPath,
    setInitialCoworkId,
    setInitialDocumentId = () => {},
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
    // Optional so a host without the projects pages can still use the hook.
    setShowProjects = () => {},
    setInitialProjectRoute = () => {},
}) {
    const navigateToPage = useCallback((page, { replace = false } = {}) => {
        if (!mayNavigate()) return;
        // Mobile access control: on phones, any destination that isn't chat or
        // user-settings bounces to the app home. Belt-and-suspenders with
        // MobileRouteGuard (which catches deep-links/refresh + resize). Close
        // every overlay so a panel that was already open doesn't linger.
        if (isMobileRef.current && !isPageAllowedOnMobile(mobilePageKey(page))) {
            setShowStudio(false);
            setShowSettings(false);
            setShowAgentDesigner(false);
            setShowAgentWizard(false);
            setShowSkillsPanel(false);
            setShowProjects(false);
            setShowProfileMenu(false);
            setCurrentPage('agents');
            if (window.location.pathname !== '/app') {
                window.history.pushState({ page: 'agents' }, '', '/app');
            }
            return;
        }
        // Projects — 'projects' (the list), 'projects/new' (the create form)
        // and 'projects/<id>[/<tab>[/<sub>]]' (one workspace, down to one item
        // in it). AgentHub renders the page off `showProjects` and the route.
        if (isProjectsPage(page)) {
            const route = projectRouteFromPage(page);
            setInitialProjectRoute(route);
            setShowProjects(true);
            setShowStudio(false);
            setShowSettings(false);
            setShowAgentDesigner(false);
            setShowAgentWizard(false);
            setShowSkillsPanel(false);
            setShowProfileMenu(false);
            setCurrentPage('projects');
            const path = projectRoutePath(route.projectId, route.tab, route.sub);
            if (window.location.pathname !== path) {
                const state = { page: 'projects', projectId: route.projectId };
                if (replace) window.history.replaceState(state, '', path);
                else window.history.pushState(state, '', path);
            }
            return;
        }
        // Every other destination leaves the projects pages. Without this a
        // link out of a workspace (a notebook, a Studio item) left the flag
        // standing, and closing that page dropped the person back into the
        // project they had already left.
        setShowProjects(false);
        // Root / home → redirect to /app
        if (page === '/' || page === 'home') {
            setCurrentPage('agents');
            window.history.pushState({}, '', '/app');
            return;
        }
        // Legacy Agent Designer (advanced form) — guardrails, embed, bubble widget, sharing
        if (page === 'agentDesignerAdvanced' || page.startsWith('agentDesignerAdvanced:')) {
            const agentId = page.includes(':') ? page.split(':')[1] : null;
            setInitialDesignerAgentId(agentId);
            const path = agentId ? `/app/agent-designer-advanced/${agentId}` : '/app/agent-designer-advanced';
            if (window.location.pathname !== path) {
                window.history.pushState({ page: 'agentDesignerAdvanced' }, '', path);
            }
            setCurrentPage('agentDesignerAdvanced');
            return;
        }
        // Unified Studio — Agents / Skills / Automations / Knowledge Bases under one shell.
        // Accepts: 'studio', 'studio/agents', 'studio/skills', 'studio/automations', 'studio/knowledge',
        // and 'studio/<section>/<id>' for deep links. 'studio/ai-tasks' kept as legacy alias.
        if (page === 'studio' || page.startsWith('studio/') || page.startsWith('studio:')) {
            // Split off the query FIRST — ?view/run/step is builder state and
            // must not be chopped up by the path split below.
            const qIndex = page.indexOf('?');
            const pagePath = qIndex >= 0 ? page.slice(0, qIndex) : page;
            const search = qIndex >= 0 ? page.slice(qIndex) : '';
            // Normalise: 'studio:agents:<id>' or 'studio/agents/<id>'.
            const raw = pagePath.replace(/^studio[/:]?/, '');
            const parts = raw.split(/[/:]/).filter(Boolean);
            const sectionRaw = parts[0] || 'agents';
            let id = parts[1] || null;
            // Third segment — currently only Automations uses it, to address a
            // flowlet (layer) inside an automation: studio/automations/<id>/<flowlet>.
            let sub = parts[2] || null;
            // Reserved automations "steps" segment — same rule as parseStudioUrl.
            // In-app navigation used to drop it, so a Reusable-Step deep link
            // mis-resolved to an automation named "steps".
            let automationKind = null;
            if ((sectionRaw === 'automations' || sectionRaw === 'routines' || sectionRaw === 'ai-tasks') && id === 'steps') {
                automationKind = 'step';
                id = parts[2] || null;
                sub = parts[3] || null;
            }
            const section = sectionFromRaw(sectionRaw);
            const pathSegment = segmentForSection(section);
            const stepsSeg = automationKind === 'step' ? '/steps' : '';
            const basePath = id
                ? (sub ? `/app/studio/${pathSegment}${stepsSeg}/${id}/${sub}` : `/app/studio/${pathSegment}${stepsSeg}/${id}`)
                : `/app/studio/${pathSegment}`;
            const query = parseStudioQuery(search);
            setStudioRoute({ section, id, sub, automationKind, ...query });
            setShowStudio(true);
            setShowAgentDesigner(false);
            setShowAgentWizard(false);
            setShowSettings(false);
            setShowSkillsPanel(false);
            // Compare pathname + search — Editor→Runs inside one automation
            // changes only the query, and comparing the pathname alone meant
            // that transition never wrote the URL at all.
            if (window.location.pathname + window.location.search !== basePath + search) {
                // `beeflowRunOpen` lets the runs panel prefer history.back()
                // when closing a run IT pushed, so Back stays symmetric.
                const state = { page: 'studio', beeflowRunOpen: query.runId || null };
                if (replace) window.history.replaceState(state, '', basePath + search);
                else window.history.pushState(state, '', basePath + search);
            }
            setCurrentPage('studio');
            return;
        }
        // Agent Wizard — full-page guided creation flow
        if (page === 'agentWizard') {
            setShowAgentWizard(true);
            setShowAgentDesigner(false);
            setShowSettings(false);
            setShowSkillsPanel(false);
            setShowStudio(false);
            if (window.location.pathname !== '/app/agent-wizard') {
                window.history.pushState({ page: 'agentWizard' }, '', '/app/agent-wizard');
            }
            setCurrentPage('agentWizard');
            return;
        }
        // Agent Designer renders inline in conversation area
        if (page === 'agentDesigner' || page.startsWith('agentDesigner:')) {
            const agentId = page.includes(':') ? page.split(':')[1] : null;
            setInitialDesignerAgentId(agentId);
            setShowAgentDesigner(true);
            setShowSettings(false);
            setShowSkillsPanel(false);
            setShowStudio(false);
            // Push the URL so /app/agent-designer[/{id}] is bookmarkable.
            const path = agentId ? `/app/agent-designer/${agentId}` : '/app/agent-designer';
            if (window.location.pathname !== path) {
                window.history.pushState({ page: 'agentDesigner' }, '', path);
            }
            setCurrentPage('agentDesigner');
            return;
        }
        // The old standalone automations page key: Automations live in Studio.
        if (page === 'aiTasks' || page.startsWith('aiTasks:')) {
            const id = page.includes(':') ? page.split(':')[1] : null;
            navigateToPage(id ? `studio/automations/${id}` : 'studio/automations');
            return;
        }
        // /app/billing is a stable, account-type-agnostic entry point for the
        // billing surface — the address the pricing page and every in-app
        // upgrade CTA can link to without knowing whether the visitor ends up
        // with a personal or an organisation account. It resolves to the
        // matching settings tab, which is where the plan UI actually lives.
        if (page === 'billing') {
            const target = user?.isConsumerAccount
                ? 'settings/account/license'
                : 'settings/organisation/license';
            navigateToPage(target);
            return;
        }
        // Settings renders inline in conversation area
        if (page === 'settings' || page.startsWith('settings/')) {
            setShowSettings(true);
            setShowAgentDesigner(false);
            setShowSkillsPanel(false);
            setShowStudio(false);
            // Push the URL so the settings panel is bookmarkable / back-button aware.
            // Sub-path (e.g. 'settings/memory') is preserved as `/app/settings/memory`.
            const subPath = page === 'settings' ? '' : page.slice('settings'.length);
            const path = '/app/settings' + subPath;
            if (window.location.pathname !== path) {
                window.history.pushState({ page: 'settings' }, '', path);
            }
            setCurrentPage('settings');
            return;
        }
        // Skills panel renders inline in conversation area
        if (page === 'skills') {
            setShowSkillsPanel(true);
            setShowSettings(false);
            setShowAgentDesigner(false);
            setShowStudio(false);
            return;
        }
        // Support admin sub-paths like 'admin/ai-config' or 'admin/security/sso'
        if (page.startsWith('admin')) {
            const subPath = page === 'admin' ? '' : page.slice('admin'.length); // e.g. '/ai-config'
            const path = '/app/admin' + subPath;
            setCurrentPage('admin');
            setAdminPath(parseAdminPath(path));
            setShowProfileMenu(false);
            setShowStudio(false);
            // The Compliance Center hands over its header tab in the path
            // ('admin/compliance/frameworks?tab=calendar') and asks for
            // `replace` when it redirects a legacy link, so Back skips it.
            // A tab switch on the same page already rewrote the URL: no
            // second, identical history entry.
            if (replace) window.history.replaceState({ page: 'admin' }, '', path);
            else if (window.location.pathname + window.location.search !== path) window.history.pushState({ page: 'admin' }, '', path);
            return;
        }
        // Support org-settings sub-paths like 'org-settings/agents'
        if (page === 'orgSettings' || page.startsWith('org-settings')) {
            const subPage = page === 'orgSettings' ? 'org-settings' : page;
            const path = '/app/' + subPage;
            setCurrentPage('orgSettings');
            setOrgSettingsPath(parseOrgSettingsPath(path));
            setShowStudio(false);
            setShowProfileMenu(false);
            window.history.pushState({ page: 'orgSettings' }, '', path);
            return;
        }
        // The member library uses the normal workspace, without Studio panels.
        if (page === 'documents' || page.startsWith('documents/')) {
            const documentId = page.startsWith('documents/') ? page.slice('documents/'.length) : null;
            setInitialDocumentId(documentId);
            setCurrentPage('documents');
            setShowStudio(false);
            setShowSettings(false);
            setShowAgentDesigner(false);
            setShowAgentWizard(false);
            setShowSkillsPanel(false);
            setShowProfileMenu(false);
            const path = documentRoutePath(documentId);
            if (replace) window.history.replaceState({ page: 'documents' }, '', path);
            else if (window.location.pathname !== path) window.history.pushState({ page: 'documents' }, '', path);
            return;
        }
        // Notebooks — a notebook is a document type and lives in Studio →
        // Documents. 'notebooks' opens the library there; 'notebooks/:id' opens
        // that notebook (`studio/documents/notebook/<id>`).
        if (page === 'notebooks' || page.startsWith('notebooks/')) {
            const notebookId = page.startsWith('notebooks/') ? page.slice('notebooks/'.length) : null;
            navigateToPage(notebookId ? `studio/documents/notebook/${notebookId}` : 'studio/documents', { replace });
            return;
        }
        // Cowork — a top-level page with a selectable detail pane. Bare
        // 'cowork' → the list with the welcome pane; 'cowork/:id' deep-links a
        // single item, which is what selecting a row and what a run
        // notification's link both produce.
        if (page === 'cowork' || page.startsWith('cowork/')) {
            const coworkId = page.startsWith('cowork/') ? page.slice('cowork/'.length) : null;
            setInitialCoworkId(coworkId);
            setShowStudio(false);
            setShowSettings(false);
            setShowAgentDesigner(false);
            setShowSkillsPanel(false);
            setCurrentPage('cowork');
            setShowProfileMenu(false);
            const path = coworkId ? `/app/cowork/${coworkId}` : '/app/cowork';
            if (window.location.pathname !== path) {
                // Selecting a row is a filter, not a destination — replacing
                // keeps Back meaning "leave Cowork" rather than walking the
                // user through every item they clicked.
                const state = { page: 'cowork', coworkId };
                if (replace || coworkId) window.history.replaceState(state, '', path);
                else window.history.pushState(state, '', path);
            }
            return;
        }
        // Published-app run view — 'apps/<id>' opens /app/apps/<id> (page key
        // 'appRun'). Bare 'apps' (the directory) falls through to the generic
        // branch below like any other top-level page.
        // 'forms/<token>' opens one published form in the workspace.
        if (page.startsWith('forms/')) {
            const token = page.slice('forms/'.length);
            setFormViewToken(token);
            setShowStudio(false);
            setShowSettings(false);
            setShowAgentDesigner(false);
            setShowAgentWizard(false);
            setShowSkillsPanel(false);
            setShowProfileMenu(false);
            const path = `/app/forms/${token}`;
            if (window.location.pathname !== path) {
                window.history.pushState({ page: 'formView' }, '', path);
            }
            setCurrentPage('formView');
            return;
        }
        if (page.startsWith('apps/')) {
            const appId = page.slice('apps/'.length);
            setAppRunId(appId);
            setShowStudio(false);
            setShowSettings(false);
            setShowAgentDesigner(false);
            setShowAgentWizard(false);
            setShowSkillsPanel(false);
            setShowProfileMenu(false);
            const path = `/app/apps/${appId}`;
            if (window.location.pathname !== path) {
                window.history.pushState({ page: 'appRun' }, '', path);
            }
            setCurrentPage('appRun');
            return;
        }
        // Webpages — now lives inside Studio under /app/studio/webpages.
        // Legacy 'webpages' / 'webpages/<id>' navigations are rerouted so the
        // sidebar entry and any old deep links land in the unified shell.
        if (page === 'webpages' || page.startsWith('webpages/')) {
            const webpageId = page.startsWith('webpages/') ? page.slice('webpages/'.length) : null;
            setStudioRoute({ section: 'webpages', id: webpageId });
            setShowStudio(true);
            setShowSettings(false);
            setShowAgentDesigner(false);
            setShowSkillsPanel(false);
            const path = webpageId ? `/app/studio/webpages/${webpageId}` : '/app/studio/webpages';
            if (window.location.pathname !== path) {
                window.history.pushState({ page: 'studio' }, '', path);
            }
            setCurrentPage('studio');
            setShowProfileMenu(false);
            return;
        }
        setCurrentPage(page);
        setShowProfileMenu(false);
        // Landing on a top-level page (agents/home, admin, …) closes any open
        // overlay panel. Without this, an overlay flag initialised from a deep
        // link (e.g. showAgentDesigner from /app/agent-designer) would keep the
        // panel mounted after a redirect to /app — notably the MobileRouteGuard
        // bounce on phones.
        setShowStudio(false);
        setShowSettings(false);
        setShowAgentDesigner(false);
        setShowAgentWizard(false);
        setShowSkillsPanel(false);
        const path = PAGE_ROUTES[page] || '/';
        window.history.pushState({ page }, '', path);
    }, []);

    return navigateToPage;
}
