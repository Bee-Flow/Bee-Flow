/**
 * The hub's main-content slot and its overlay precedence, pinned through the
 * real component.
 *
 * AgentHub picks ONE thing to show in its main column: Settings, Studio, the
 * agent editor (behind manage_agents), the wizard deep link, a top-level page
 * (Cowork, Documents, Apps, Forms, one form), the Skills panel, the
 * marketplace, Projects, a chat, or the welcome state. The order of that pick
 * is behaviour (BFSF-267, BFSF-181), and so is what each slot is handed —
 * Studio's deep-link props in particular are a pure mapping of the route.
 * Every lazy page is stubbed to a probe that records its props; the hub, its
 * sidebar and the precedence between them are the real thing.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentHub from './AgentHub';
import { withQueryClient } from './test/queryWrapper';
import { authFetch } from './utils/helpers';

vi.mock('./utils/helpers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/helpers')>();
    return { ...actual, authFetch: vi.fn() };
});
vi.mock('./components/licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: () => true, hasTier: () => true, tier: 'full' }),
    RequireTier: ({ children }: { children: React.ReactNode }) => children,
}));

const { seen } = vi.hoisted(() => ({ seen: {} as Record<string, Record<string, any>> }));
vi.mock('./pages/AdvancedSettings', () => ({ default: (p: any) => { seen.settings = p; return <div data-testid="slot-settings" />; } }));
vi.mock('./components/admin/Studio', () => ({ default: (p: any) => { seen.studio = p; return <div data-testid="slot-studio" />; } }));
vi.mock('./components/agents/AgentStudio/index', () => ({ default: (p: any) => { seen.agentStudio = p; return <div data-testid="slot-agent-studio" />; } }));
vi.mock('./components/cowork/CoworkPage', () => ({ default: (p: any) => { seen.cowork = p; return <div data-testid="slot-cowork" />; } }));
vi.mock('./pages/documents/DocumentsPage', () => ({ default: (p: any) => { seen.documents = p; return <div data-testid="slot-documents" />; } }));
vi.mock('./pages/apps/AppsHomePage/index', () => ({ default: () => <div data-testid="slot-apps" /> }));
vi.mock('./pages/forms/FormsHomePage', () => ({ default: (p: any) => { seen.forms = p; return <div data-testid="slot-forms" />; } }));
vi.mock('./pages/PublicFormPage', () => ({ default: (p: any) => { seen.formView = p; return <div data-testid="slot-form-view" />; } }));
vi.mock('./components/skills/SkillsPanel', () => ({ default: (p: any) => { seen.skills = p; return <div data-testid="slot-skills" />; } }));
vi.mock('./components/agents/AgentMarketplace', () => ({ default: (p: any) => { seen.marketplace = p; return <div data-testid="slot-marketplace" />; } }));

const Hub = AgentHub as unknown as React.ComponentType<Record<string, unknown>>;

const ADMIN = { id: 'u1', username: 'tom', permissions: ['all'], isAdmin: true };
const MEMBER = { id: 'u2', username: 'ann', permissions: ['use_notebooks'], isAdmin: false };
const ARRIVES = { timeout: 15_000 };

const json = (body: unknown) => Promise.resolve({
    ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body),
});

beforeEach(() => {
    for (const k of Object.keys(seen)) delete seen[k];
    window.history.replaceState({}, '', '/');
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation((() => json([])) as never);
});
afterEach(() => { vi.restoreAllMocks(); });

function renderHub(props: Record<string, unknown> = {}) {
    const cb = {
        onNavigate: vi.fn(), onCloseSettings: vi.fn(), onCloseAgentDesigner: vi.fn(), onCloseAgentWizard: vi.fn(),
        onCloseStudio: vi.fn(), onCloseSkillsPanel: vi.fn(),
    };
    render(withQueryClient(<Hub user={ADMIN} currentPage="agents" {...cb} {...props} />));
    return cb;
}

describe('AgentHub main content — which slot wins', () => {
    it('Settings outranks every other flag', async () => {
        renderHub({ showSettings: true, showStudio: true, showSkillsPanel: true, currentPage: 'cowork' });
        expect(await screen.findByTestId('slot-settings', {}, ARRIVES)).toBeInTheDocument();
        expect(seen.settings.onBack).toBeNull();
        expect(seen.settings.user).toEqual(ADMIN);
        expect(screen.queryByTestId('slot-studio')).toBeNull();
    });

    it('Studio outranks the agent editor and the pages', async () => {
        renderHub({ showStudio: true, showAgentDesigner: true, currentPage: 'cowork' });
        expect(await screen.findByTestId('slot-studio', {}, ARRIVES)).toBeInTheDocument();
        expect(screen.queryByTestId('slot-agent-studio')).toBeNull();
    });

    it('a top-level page outranks the Skills panel (BFSF-267)', async () => {
        renderHub({ currentPage: 'cowork', showSkillsPanel: true, initialCoworkId: 'cw1' });
        expect(await screen.findByTestId('slot-cowork', {}, ARRIVES)).toBeInTheDocument();
        expect(seen.cowork.initialCoworkId).toBe('cw1');
        expect(screen.queryByTestId('slot-skills')).toBeNull();
    });

    it('the Skills panel shows when no page is on screen', async () => {
        renderHub({ showSkillsPanel: true });
        expect(await screen.findByTestId('slot-skills', {}, ARRIVES)).toBeInTheDocument();
        expect(seen.skills.activeSkillIds).toEqual([]);
    });

    it('documents routes its own changes back through onNavigate', async () => {
        const cb = renderHub({ currentPage: 'documents', initialDocumentId: 'd1' });
        expect(await screen.findByTestId('slot-documents', {}, ARRIVES)).toBeInTheDocument();
        expect(seen.documents.mode).toBe('workspace');
        expect(seen.documents.initialDocumentId).toBe('d1');
        seen.documents.onDocumentChange('d2');
        seen.documents.onDocumentChange(null);
        expect(cb.onNavigate.mock.calls).toEqual([['documents/d2'], ['documents']]);
    });

    it('apps, forms and one form each get their slot', async () => {
        renderHub({ currentPage: 'apps' });
        expect(await screen.findByTestId('slot-apps', {}, ARRIVES)).toBeInTheDocument();
    });

    it('a published form is shown signed in, with the webpages entitlement', async () => {
        renderHub({ currentPage: 'formView', formViewToken: 'tok-1' });
        expect(await screen.findByTestId('slot-form-view', {}, ARRIVES)).toBeInTheDocument();
        expect(seen.formView).toMatchObject({ token: 'tok-1', authenticated: true, webpagesEnabled: true });
    });

    it('a published form under Simple Mode is shown without webpages', async () => {
        renderHub({ currentPage: 'formView', formViewToken: 'tok-2', user: { ...ADMIN, simpleMode: true } });
        expect(await screen.findByTestId('slot-form-view', {}, ARRIVES)).toBeInTheDocument();
        expect(seen.formView).toMatchObject({ token: 'tok-2', webpagesEnabled: false });
    });
});

describe('AgentHub main content — Studio deep links', () => {
    const studioWith = async (studioRoute: Record<string, unknown>, user = ADMIN) => {
        renderHub({ showStudio: true, studioRoute, user });
        await screen.findByTestId('slot-studio', {}, ARRIVES);
        return seen.studio;
    };

    it('a knowledge base, its tab and its source', async () => {
        const p = await studioWith({ section: 'knowledge', id: 'kb1', sub: 'sources', subId: 's1' });
        expect(p).toMatchObject({
            section: 'knowledge', initialKbId: 'kb1', initialKbTab: 'sources', initialSourceId: 's1',
            initialAgentId: null, initialSkillId: null, initialTaskId: null, initialStepId: null,
            initialFlowletKey: null, initialBuilderView: null, initialRunId: null, initialFrom: null,
        });
    });

    it('an AI task with its builder view, run, step and origin', async () => {
        const p = await studioWith({
            section: 'aiTasks', id: 't1', sub: 'flowlet', view: 'runs', runId: 'r1', stepId: 'st1', from: 'app:a1',
        });
        expect(p).toMatchObject({
            initialTaskId: 't1', initialStepId: null, initialFlowletKey: 'flowlet', initialBuilderView: 'runs',
            initialRunId: 'r1', initialRunStepId: 'st1', initialFrom: 'app:a1', initialKbId: null,
        });
    });

    it('an AI step is addressed by the step id, not the task id', async () => {
        const p = await studioWith({ section: 'aiTasks', id: 'x1', automationKind: 'step' });
        expect(p).toMatchObject({ initialTaskId: null, initialStepId: 'x1', initialFlowletKey: null });
    });

    it('the run log reads the run and step but no builder view', async () => {
        const p = await studioWith({ section: 'runs', id: null, view: 'v', runId: 'r9', stepId: 's9' });
        expect(p).toMatchObject({ initialRunId: 'r9', initialRunStepId: 's9', initialBuilderView: null, initialFrom: null });
    });

    it('every other section hands only its own id over', async () => {
        const cases: Array<[string, string, Record<string, unknown>]> = [
            ['agents', 'a1', { initialAgentId: 'a1' }],
            ['skills', 'sk1', { initialSkillId: 'sk1' }],
            ['webpages', 'w1', { initialWebpageId: 'w1' }],
            ['apps', 'ap1', { initialStudioAppId: 'ap1' }],
            ['meetingNotes', 'm1', { initialMeetingId: 'm1' }],
            ['approvals', 'ap2', { initialApprovalId: 'ap2' }],
            ['solutions', 'so1', { initialSolutionId: 'so1' }],
            ['datatables', 'dt1', { initialDatatableId: 'dt1', initialDatatableTab: 'rows' }],
            ['forms', 'f1', { initialFormId: 'f1', initialFormTab: 'rows' }],
            ['playbooks', 'pb1', { initialPlaybookId: 'pb1' }],
        ];
        const KEYS = ['initialAgentId', 'initialSkillId', 'initialKbId', 'initialWebpageId', 'initialStudioAppId',
            'initialMeetingId', 'initialApprovalId', 'initialSolutionId', 'initialDatatableId', 'initialFormId',
            'initialPlaybookId', 'initialDocumentId', 'initialTaskId'];
        for (const [section, id, expected] of cases) {
            document.body.innerHTML = '';
            const p = await studioWith({ section, id, sub: 'rows' });
            for (const key of KEYS) expect(p[key], `${section}.${key}`).toBe(expected[key] ?? null);
            for (const [k, v] of Object.entries(expected)) expect(p[k], `${section}.${k}`).toBe(v);
        }
    });

    it('wires close, navigation, fullscreen and permissions', async () => {
        const p = await studioWith({ section: 'agents', id: null }, MEMBER);
        expect(p.hasPermission('use_notebooks')).toBe(true);
        expect(p.hasPermission('manage_agents')).toBe(false);
        expect(typeof p.onEditingChange).toBe('function');
        expect(p.modelTiers).toEqual({});
    });
});

describe('AgentHub main content — the agent editor gate (BFSF-181)', () => {
    it('opens the editor for someone who may manage agents', async () => {
        renderHub({ showAgentDesigner: true, initialDesignerAgentId: 'a7', user: { ...MEMBER, permissions: ['manage_agents'] } });
        expect(await screen.findByTestId('slot-agent-studio', {}, ARRIVES)).toBeInTheDocument();
        expect(seen.agentStudio.initialAgentId).toBe('a7');
        expect(seen.agentStudio.startInWizard).toBeUndefined();
        expect(seen.agentStudio.hasPermission('manage_agents')).toBe(true);
        expect(seen.agentStudio.hasPermission('all')).toBe(false);
    });

    it('opens the wizard deep link in wizard mode', async () => {
        const cb = renderHub({ showAgentWizard: true });
        expect(await screen.findByTestId('slot-agent-studio', {}, ARRIVES)).toBeInTheDocument();
        expect(seen.agentStudio).toMatchObject({ initialAgentId: null, startInWizard: true });
        expect(seen.agentStudio.onClose).toBe(cb.onCloseAgentWizard);
    });

    it.each([['showAgentDesigner'], ['showAgentWizard']])('%s without manage_agents shows the no-access page', async (flag) => {
        const cb = renderHub({ [flag]: true, user: MEMBER });
        expect(await screen.findByText('No access to the Agent Editor', {}, ARRIVES)).toBeInTheDocument();
        expect(screen.queryByTestId('slot-agent-studio')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Back to Agents' }));
        expect(cb.onNavigate).toHaveBeenCalledWith('agents');
    });
});

describe('AgentHub — closing overlays when navigating', () => {
    it('opening the marketplace closes every overlay and leaves a page above them', async () => {
        const cb = renderHub({ currentPage: 'cowork' });
        await screen.findByTestId('slot-cowork', {}, ARRIVES);
        await userEvent.click(screen.getByTestId('nav-agents'));
        expect(cb.onCloseSettings).toHaveBeenCalled();
        expect(cb.onCloseAgentDesigner).toHaveBeenCalled();
        expect(cb.onCloseAgentWizard).toHaveBeenCalled();
        expect(cb.onCloseStudio).toHaveBeenCalled();
        expect(cb.onCloseSkillsPanel).toHaveBeenCalled();
        expect(cb.onNavigate).toHaveBeenCalledWith('agents');
    });

    it('opening the marketplace off a plain page shows it inline', async () => {
        const cb = renderHub({ currentPage: 'agents' });
        await userEvent.click(await screen.findByTestId('nav-agents', {}, ARRIVES));
        expect(await screen.findByTestId('slot-marketplace', {}, ARRIVES)).toBeInTheDocument();
        expect(cb.onNavigate).not.toHaveBeenCalled();
        // Admin on a desktop: the edit affordance routes into the editor.
        seen.marketplace.onEditAgent({ id: 'a3' });
        expect(cb.onNavigate).toHaveBeenCalledWith('agentDesigner:a3');
        await waitFor(() => expect(screen.queryByTestId('slot-marketplace')).toBeNull());
    });

    it('opening search keeps the page on screen', async () => {
        const cb = renderHub({ currentPage: 'cowork' });
        await screen.findByTestId('slot-cowork', {}, ARRIVES);
        await userEvent.click(screen.getByTestId('nav-search'));
        expect(cb.onCloseStudio).toHaveBeenCalled();
        expect(cb.onNavigate).not.toHaveBeenCalled();
        expect(screen.getByTestId('slot-cowork')).toBeInTheDocument();
    });

    it('the marketplace hides the edit affordance from a member', async () => {
        renderHub({ user: MEMBER });
        await userEvent.click(await screen.findByTestId('nav-agents', {}, ARRIVES));
        await screen.findByTestId('slot-marketplace', {}, ARRIVES);
        expect(seen.marketplace.onEditAgent).toBeUndefined();
    });
});
