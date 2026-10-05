import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { withQueryClient } from '../../../../../test/render';
import { authFetch } from '../../../../../utils/helpers';
import scopedStorage from '../../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';
import SettingsForm from '../SettingsForm';

vi.mock('../../../../../utils/helpers', async (orig) => ({
    ...(await orig()),
    API_BASE: '',
    authFetch: vi.fn(),
}));

/**
 * "Who does the thinking" in an AI step (handoff 5, round 3, artboard 3a).
 *
 * The layout is the design's; what these tests pin is the HONESTY of the
 * screen, carried over from R2:
 *   1. an agent that cannot be picked is still listed, with the reason;
 *   2. tools held back because they ask for confirmation are named, with the
 *      approval-step hint; a tool a switch removed is not;
 *   3. "could not read the list" is a different sentence from "there are none".
 * Plus the round 3 behaviour: the mode cards, the agent card, the skills list
 * (agent skills switched off per step, extra skills, the leading one), and the
 * fields the step continues as.
 */

const noIssues = { errors: [], warnings: [] };

const APPS = [{
    id: 'gmail', label: 'Gmail', available: true, actions: [
        { name: 'gmail_search', label: 'Search mail', sideEffect: false },
        { name: 'gmail_compose', label: 'Send email', sideEffect: true },
    ],
}];

const catalogWith = (over = {}) => ({ apps: APPS, agentsError: null, agents: [], ...over });

const AGENTS = [
    { id: 'agt_ok', name: 'Sales bot', description: 'Answers sales mail', scope: 'org', canUse: true, reason: null },
    { id: 'agt_two', name: 'Quote bot', description: null, scope: 'org', canUse: true, reason: null },
    { id: 'agt_draft', name: 'Draft bot', description: null, scope: 'personal', canUse: false, reason: 'not_published' },
];

const aiStep = (over = {}) => ({
    id: 's1', type: 'ai_step', label: 'AI', prompt: 'Do X', inputs: {}, outputFields: [], ...over,
});

/** GET /catalog/agent/:id as the server answers it. */
const preview = (over = {}) => ({
    id: 'agt_ok', canUse: true, name: 'Sales bot', runtimeSource: 'published', version: 8, scope: 'org',
    knowledgeBases: [{ id: 'kb1', name: 'Price list' }],
    skills: [{ id: 'sk_agent', name: 'Explain a quote', fromAgent: true }],
    permissions: { startAutomations: false, useKnowledge: false, useTools: true },
    allowed: ['gmail_search'], withheld: [], degraded: false, error: null, ...over,
});

const SKILLS = [
    { id: 'sk_photo', name: 'Judge a photo' },
    { id: 'sk_agent', name: 'Explain a quote' },
];

/** One mock for every read, routed by URL. A value may be an Error. */
function mockReads({ skills = SKILLS, agent = preview(), skill = null } = {}) {
    authFetch.mockImplementation(async (url) => {
        const u = String(url);
        const answer = (v) => {
            if (v instanceof Error) throw v;
            return { ok: true, status: 200, json: async () => v };
        };
        if (u.includes('/catalog/skill/')) {
            if (!skill) return { ok: false, status: 404, json: async () => ({}) };
            return answer(skill);
        }
        if (u.includes('/api/skills')) return answer(skills);
        if (u.includes('/catalog/agent/')) return answer(agent);
        return answer([]);
    });
}

// The agent preview claiming "No tools". The AI step's own tool picker (its
// Advanced settings, shown in the full view) has an empty hint of its own.
const agentSaysNoTools = () => screen.queryAllByText(/No tools/)
    .some(el => !/answers from its prompt only/.test(el.textContent || ''));

function renderForm(step, { onPatch = vi.fn(), catalog = catalogWith({ agents: AGENTS }) } = {}) {
    const utils = render(withQueryClient(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm
                step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null}
                onPatch={onPatch} catalog={catalog} groups={[]}
            />
        </VariablePickerProvider>,
    ));
    return { onPatch, ...utils };
}

const lastPatch = (onPatch) => onPatch.mock.calls.at(-1)?.[0];

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockReads();
    scopedStorage.setCurrentUser('agent-step-test-user');
    try { localStorage.clear(); } catch { /* ignore */ }
});

describe('AI step — who does the thinking', () => {
    it('shows the two mode cards, with the loose instruction chosen for a plain step', () => {
        renderForm(aiStep());
        const group = screen.getByRole('radiogroup', { name: 'Who does the thinking' });
        expect(within(group).getByRole('radio', { name: /Loose instruction/ }).getAttribute('aria-checked')).toBe('true');
        expect(within(group).getByRole('radio', { name: /Use an agent/ }).getAttribute('aria-checked')).toBe('false');
        // No agent, no skill: the prompt keeps its old label.
        expect(screen.getByText('Prompt')).toBeTruthy();
    });

    it('"Use an agent" opens the list; an agent that cannot be picked is listed WITH the reason', async () => {
        const user = userEvent.setup();
        renderForm(aiStep());
        await user.click(screen.getByRole('radio', { name: /Use an agent/ }));
        const draft = screen.getByRole('radio', { name: 'Draft bot' });
        expect(draft.disabled).toBe(true);
        expect(screen.getByText(/Not published yet/)).toBeTruthy();
    });

    it('a failed read of the agent list is NOT "there are no agents"', async () => {
        const user = userEvent.setup();
        renderForm(aiStep(), { catalog: catalogWith({ agents: [], agentsError: 'boom' }) });
        await user.click(screen.getByRole('radio', { name: /Use an agent/ }));
        expect(screen.getByText(/could not be read/)).toBeTruthy();
        expect(screen.queryByText(/No agents yet/)).toBeNull();
    });

    it('picking an agent stores it with all three permissions OFF', async () => {
        const user = userEvent.setup();
        const { onPatch } = renderForm(aiStep());
        await user.click(screen.getByRole('radio', { name: /Use an agent/ }));
        await user.click(screen.getByRole('radio', { name: 'Sales bot' }));
        await waitFor(() => {
            const patch = lastPatch(onPatch);
            expect(patch?.agentId).toBe('agt_ok');
            expect(patch?.agentPermissions).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
        }, { timeout: 2000 });
    });

    it('going back to a loose instruction clears the agent', async () => {
        const user = userEvent.setup();
        const { onPatch } = renderForm(aiStep({ agentId: 'agt_ok', agentPermissions: { useTools: true } }));
        await user.click(screen.getByRole('radio', { name: /Loose instruction/ }));
        await waitFor(() => {
            const patch = lastPatch(onPatch);
            expect(patch?.agentId).toBeNull();
            expect(patch?.agentPermissions).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
            expect(patch?.disabledAgentSkillIds).toEqual([]);
        }, { timeout: 2000 });
    });

    it('keeps an agent the step names that the list no longer holds', async () => {
        const user = userEvent.setup();
        renderForm(aiStep({ agentId: 'agt_gone' }));
        await user.click(screen.getByRole('button', { name: 'Choose another' }));
        expect(screen.getByRole('radio', { name: 'Agent agt_gone' }).checked).toBe(true);
        expect(screen.getByText(/not in the list above/)).toBeTruthy();
    });
});

describe('AI step — the agent card', () => {
    it('names the agent with its version, scope, knowledge and skills, and links to Studio', async () => {
        renderForm(aiStep({ agentId: 'agt_ok' }));
        const card = await screen.findByTestId('agent-card');
        expect(within(card).getByText('Sales bot')).toBeTruthy();
        await waitFor(() => expect(within(card).getByText('v8 · organisation · knows Price list · 1 skill')).toBeTruthy());
        expect(within(card).getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('/app/studio/agents/agt_ok');
    });

    it('"Choose another" switches agent and resets the permissions', async () => {
        const user = userEvent.setup();
        const { onPatch } = renderForm(aiStep({ agentId: 'agt_ok', agentPermissions: { useTools: true, useKnowledge: true } }));
        await user.click(screen.getByRole('button', { name: 'Choose another' }));
        await user.click(screen.getByRole('radio', { name: 'Quote bot' }));
        await waitFor(() => {
            const patch = lastPatch(onPatch);
            expect(patch?.agentId).toBe('agt_two');
            expect(patch?.agentPermissions).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
        }, { timeout: 2000 });
    });
});

describe('AI step — skills for this step', () => {
    it('lists the agent\'s skills with a switch; off writes disabledAgentSkillIds', async () => {
        const user = userEvent.setup();
        const { onPatch } = renderForm(aiStep({ agentId: 'agt_ok' }));
        const toggle = await screen.findByRole('switch', { name: 'Explain a quote' });
        expect(toggle.checked).toBe(true);
        expect(screen.getByText('leading')).toBeTruthy();
        await user.click(toggle);
        await waitFor(() => expect(lastPatch(onPatch)?.disabledAgentSkillIds).toEqual(['sk_agent']), { timeout: 2000 });
    });

    it('an extra skill for the step comes first and leads', async () => {
        renderForm(aiStep({ agentId: 'agt_ok', skillIds: ['sk_photo'] }));
        const rows = await screen.findAllByTestId('step-skill-row');
        await waitFor(() => expect(within(rows[0]).getByText('Judge a photo')).toBeTruthy());
        expect(within(rows[0]).getByText('extra for this step')).toBeTruthy();
        expect(within(rows[0]).getByText('leading')).toBeTruthy();
        await waitFor(() => expect(screen.getAllByTestId('step-skill-row')).toHaveLength(2));
    });

    it('"Add a skill for this step" appends, so the first pick keeps leading', async () => {
        const user = userEvent.setup();
        const { onPatch } = renderForm(aiStep({ skillIds: ['sk_agent'] }));
        await user.click(screen.getByRole('button', { name: /Add a skill for this step/ }));
        await user.click(await screen.findByRole('button', { name: 'Judge a photo' }));
        await waitFor(() => expect(lastPatch(onPatch)?.skillIds).toEqual(['sk_agent', 'sk_photo']), { timeout: 2000 });
    });

    it('a failed read of the skills is not an empty skill list', async () => {
        const user = userEvent.setup();
        mockReads({ skills: new Error('down') });
        renderForm(aiStep());
        await user.click(screen.getByRole('button', { name: /Add a skill for this step/ }));
        expect(await screen.findByText(/could not be read/)).toBeTruthy();
        expect(screen.queryByText(/No skills yet/)).toBeNull();
    });

    it('with a skill the prompt becomes the task for this step', () => {
        renderForm(aiStep({ skillIds: ['sk_photo'] }));
        expect(screen.getByText('Task for this step')).toBeTruthy();
    });
});

describe('AI step — continues as', () => {
    it('shows the leading skill\'s output fields and says where they come from', async () => {
        mockReads({
            skill: { id: 'sk_photo', name: 'Judge a photo', version: 4, outputFields: [{ key: 'hours', type: 'number', title: 'Estimated hours' }, { key: 'notes', type: 'array' }] },
        });
        renderForm(aiStep({ skillIds: ['sk_photo'] }));
        const fields = await screen.findAllByTestId('continues-field');
        expect(fields).toHaveLength(2);
        expect(within(fields[0]).getByText('Estimated hours')).toBeTruthy();
        expect(within(fields[0]).getByText('number')).toBeTruthy();
        expect(within(fields[1]).getByText('list')).toBeTruthy();
        expect(screen.getByText(/The fields come from the skill "Judge a photo"/)).toBeTruthy();
    });

    it('falls back to the step\'s own fields when the skill has none', async () => {
        renderForm(aiStep({ skillIds: ['sk_photo'], outputSchema: { type: 'object', properties: { summary: { type: 'string' } } } }));
        const fields = await screen.findAllByTestId('continues-field');
        expect(within(fields[0]).getByText('summary')).toBeTruthy();
        expect(screen.getByText(/this step's own fields/)).toBeTruthy();
    });

    it('shows the step\'s own fields over the skill\'s, as the run uses them', async () => {
        mockReads({
            skill: { id: 'sk_photo', name: 'Judge a photo', outputFields: [{ key: 'hours', type: 'number' }] },
        });
        renderForm(aiStep({ skillIds: ['sk_photo'], outputSchema: { type: 'object', properties: { summary: { type: 'string' } } } }));
        await screen.findByText(/They replace the fields of the skill "Judge a photo"/);
        const fields = screen.getAllByTestId('continues-field');
        expect(fields).toHaveLength(1);
        expect(within(fields[0]).getByText('summary')).toBeTruthy();
    });

    it('asks the agent preview with the step\'s skills and the switched-off agent skills', async () => {
        renderForm(aiStep({ agentId: 'agt_ok', skillIds: ['sk_photo'], disabledAgentSkillIds: ['sk_agent'] }));
        await waitFor(() => {
            const url = authFetch.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/catalog/agent/'));
            expect(url).toContain('skillIds=sk_photo');
            expect(url).toContain('disabledAgentSkillIds=sk_agent');
        });
    });
});

describe('AI step — what the agent may do here', () => {
    it('offers the three switches only with an agent', async () => {
        renderForm(aiStep());
        expect(screen.queryByRole('switch', { name: 'Start automations itself' })).toBeNull();
        cleanup();
        renderForm(aiStep({ agentId: 'agt_ok' }));
        expect(screen.getByRole('switch', { name: 'Start automations itself' }).checked).toBe(false);
        expect(screen.getByText('off · only answers')).toBeTruthy();
    });

    it('a switch writes ALL THREE keys', async () => {
        const user = userEvent.setup();
        const { onPatch } = renderForm(aiStep({ agentId: 'agt_ok' }));
        await user.click(screen.getByRole('switch', { name: 'Consult knowledge bases' }));
        await waitFor(() => expect(lastPatch(onPatch)?.agentPermissions).toEqual({ startAutomations: false, useKnowledge: true, useTools: false }), { timeout: 2000 });
    });

    it('draws the tools per integration and strikes through a withheld one', async () => {
        mockReads({
            agent: preview({
                tools: [
                    { integration: 'nextcloud', label: 'Nextcloud', tools: ['nc_read'], withheld: false, reason: null },
                    { integration: 'gmail', label: 'Gmail', tools: ['gmail_compose'], withheld: true, reason: 'confirm' },
                ],
            }),
        });
        renderForm(aiStep({ agentId: 'agt_ok', agentPermissions: { useTools: true } }));
        const gmail = await screen.findByText('Gmail');
        expect(gmail.closest('[data-withheld]')?.getAttribute('data-withheld')).toBe('true');
        expect(screen.getByText('Nextcloud').closest('[data-withheld]')).toBeNull();
    });

    it('names the tools held back for confirmation, with the approval hint', async () => {
        mockReads({ agent: preview({ withheld: [{ name: 'gmail_compose', reason: 'confirm' }] }) });
        renderForm(aiStep({ agentId: 'agt_ok', agentPermissions: { useTools: true } }));
        expect(await screen.findByText(/would have to approve/)).toBeTruthy();
        expect(screen.getByText(/Gmail: Send email/)).toBeTruthy();
    });

    it('a tool held back by a SWITCH is not advertised as needing an approval step', async () => {
        mockReads({ agent: preview({ allowed: [], withheld: [{ name: 'gmail_search', reason: 'permission' }] }) });
        renderForm(aiStep({ agentId: 'agt_ok' }));
        expect(await screen.findByText(/left out by the permissions above/)).toBeTruthy();
        expect(screen.queryByText(/would have to approve/)).toBeNull();
    });

    it('a preview that could not be fetched says so; it never draws "no tools"', async () => {
        mockReads({ agent: new Error('down') });
        renderForm(aiStep({ agentId: 'agt_ok' }));
        expect(await screen.findByText(/Could not check what this agent brings/)).toBeTruthy();
        expect(agentSaysNoTools()).toBe(false);
    });

    it('a tool list the server could not build is NOT "no tools"', async () => {
        mockReads({ agent: preview({ allowed: [], error: 'registry down' }) });
        renderForm(aiStep({ agentId: 'agt_ok' }));
        expect(await screen.findByText(/could not be listed just now/)).toBeTruthy();
        expect(agentSaysNoTools()).toBe(false);
    });

    it('always carries the note that the agent is a step, not a conversation partner', () => {
        renderForm(aiStep({ agentId: 'agt_ok' }));
        expect(screen.getByText(/the agent is a step, not a conversation partner/)).toBeTruthy();
    });

    it('asks the server with the switches and the allowlist as they stand', async () => {
        renderForm(aiStep({ agentId: 'agt_ok', agentPermissions: { useTools: true }, tools: ['gmail_search'] }));
        await waitFor(() => {
            const url = authFetch.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/catalog/agent/'));
            expect(url).toContain('useTools=1');
            expect(url).toContain('startAutomations=0');
            expect(url).toContain('tools=gmail_search');
        });
    });
});
