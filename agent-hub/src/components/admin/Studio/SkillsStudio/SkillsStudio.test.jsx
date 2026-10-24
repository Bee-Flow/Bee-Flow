import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SkillsStudio from './index';
import { skillsApi } from './skillsApi';
import { queryWrapper } from '../../../../test/queryWrapper';
import { authFetch } from '../../../../utils/helpers';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

/**
 * Studio → Skills: the list, the landing table and the detail's tabs.
 *
 * This section had NO tests at all before the redesign, so the ones here are
 * chosen for the claims a user would be misled by:
 *   - the list's second line must not say "not linked yet" from a summary
 *     that has not answered;
 *   - the landing with nothing selected is the "All skills" table, not an
 *     invitation to create a sixth skill;
 *   - "Used by" is the last tab and its count comes from the usage endpoint;
 *   - a skill the server marks not-editable renders read-only, and no
 *     autosave is fired for it;
 *   - a usage read that FAILED says nothing about who uses the skill: not a
 *     count on the tab, not "no agent uses this yet" in the rail, and above
 *     all not "nothing depends on this" in the delete dialog.
 */

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url) => {
        const u = String(url);
        const body = u.includes('/auth/groups') ? [{ id: 'g1', name: 'Sales' }]
            : u.includes('/api/automation') ? { automations: [{ id: 'a1', title: 'Look up quote status', triggerType: 'agent_call' }] }
                : u.includes('/api/kb') ? [{ id: 'k1', name: 'Quote terms' }]
                    : u.includes('/api/datatables') ? { datatables: [{ id: 't1', name: 'Pricelist' }] }
                        : u.includes('/usage') ? { usage: USAGE }
                            : u.includes('/test-runs') ? { runs: [] }
                                : {};
        return { ok: true, status: 200, json: async () => body };
    }),
}));

// The AI-step editor drags the whole builder settings chain (tool picker,
// accordions, its own fetches) into a unit test. Only its output-field rows
// are used here, so it is stubbed down to the contract this card relies on.
vi.mock('../../../automation/Builder/flow/settings/aiStepEditors', () => ({
    StructuredOutputFields: ({ fields, onChange }) => (
        <button type="button" data-testid="stub-output-rows" onClick={() => onChange([...fields, { key: 'total', type: 'number' }])}>
            add output field ({fields.length})
        </button>
    ),
}));

vi.mock('./skillsApi', () => {
    const api = {
        list: vi.fn(), usageSummary: vi.fn(), get: vi.fn(), create: vi.fn(),
        update: vi.fn(), remove: vi.fn(), improve: vi.fn(), draft: vi.fn(),
        exampleConversations: vi.fn(), exampleMessages: vi.fn(), exampleFromMessage: vi.fn(),
        // S3. A method missing from this hand-written list is `undefined` at
        // the call site, which is a TypeError in a component the suite would
        // otherwise render green — so it is kept in step with skillsApi.js.
        test: vi.fn(), testAgents: vi.fn(async () => ({ agents: [] })), testRuns: vi.fn(async () => ({ runs: [] })),
    };
    return { skillsApi: api, default: api };
});

const USAGE = [
    { kind: 'agent', id: 'ag1', title: 'Quote assistant', role: 'chat', ownerId: null },
    { kind: 'automation', id: 'au1', title: 'Send quote', role: 'ai_step', siteLabel: 'step 3', ownerId: null },
];

const FULL = {
    id: 's1',
    name: 'Explain a quote to a customer',
    description: 'Explains a quote line by line.',
    instructions: 'When someone asks what something means.',
    canEdit: true,
    isShared: true,
    sharedGroups: [],
    dynamicActivation: false,
    enabledIntegrations: [],
    knowledgeBaseIds: [],
    allowedAutomationIds: [],
    outputSchema: null,
    steps: [
        { id: 'st1', text: 'Fetch the quote.', refs: [{ kind: 'automation', id: 'a1' }] },
        { id: 'st2', text: 'Walk through every line.', refs: [] },
    ],
    rulesV2: [
        { id: 'r1', polarity: 'never', text: 'Never mention internal discount codes.' },
        { id: 'r2', polarity: 'must', text: 'Answer in the language of the question.' },
    ],
    examplesV2: [{ id: 'e1', question: 'Why 1240?', good: 'Because…', rationale: 'splits the line' }],
    lastTest: { status: 'warning', adviceCount: 1, ranAt: '2026-09-03T10:00:00.000Z' },
};

const EMPTY_SKILL = {
    id: 's2', name: 'Untitled skill', description: '', canEdit: true,
    steps: [], rulesV2: [], examplesV2: [], lastTest: null,
};

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    skillsApi.list.mockResolvedValue([FULL, EMPTY_SKILL]);
    skillsApi.usageSummary.mockResolvedValue({
        summary: { s1: { agents: 3, automations: 1, lastUsedAt: '2026-09-04T09:00:00.000Z' } },
    });
    skillsApi.update.mockResolvedValue({ success: true });
});

const renderStudio = (props = {}) => render(
    <SkillsStudio user={{ id: 'u1', orgRole: 'org_admin' }} onNavigate={() => {}} {...props} />,
);

describe('the list', () => {
    it('shows each skill with what actually uses it', async () => {
        renderStudio();
        const rows = await screen.findAllByTestId('skill-row');
        expect(within(rows[0]).getByText('Explain a quote to a customer')).toBeTruthy();
        expect(within(rows[0]).getByText('3 agents · 1 automation')).toBeTruthy();
    });

    it('says "draft · empty" for a skill nobody has written anything into', async () => {
        renderStudio();
        const rows = await screen.findAllByTestId('skill-row');
        expect(within(rows[1]).getByText('draft · empty')).toBeTruthy();
    });

    it('renders NO usage line at all while the summary has not answered', async () => {
        skillsApi.usageSummary.mockRejectedValue(new Error('slow'));
        renderStudio();
        const rows = await screen.findAllByTestId('skill-row');
        expect(within(rows[0]).queryByText(/not linked yet/)).toBeNull();
        expect(within(rows[0]).queryByText(/agents/)).toBeNull();
    });

    it('filters on what is typed', async () => {
        renderStudio();
        await screen.findAllByTestId('skill-row');
        fireEvent.change(screen.getByTestId('skills-filter'), { target: { value: 'untitled' } });
        expect(screen.getAllByTestId('skill-row')).toHaveLength(1);
    });

    it('hides the create button from someone who may not manage skills', async () => {
        renderStudio({ user: { id: 'u2' }, hasPermission: () => false });
        await screen.findAllByTestId('skill-row');
        expect(screen.queryByTestId('skills-list-new')).toBeNull();
    });
});

describe('the landing with nothing selected', () => {
    it('is the "All skills" table, with the meta line and the test verdict', async () => {
        renderStudio();
        await screen.findByTestId('skills-overview');
        const rows = await screen.findAllByTestId('skills-overview-row');
        expect(within(rows[0]).getByText('2 steps · 2 rules · 1 example')).toBeTruthy();
        expect(within(rows[0]).getByTestId('skills-overview-test').getAttribute('data-tone')).toBe('warning');
    });

    it('offers "Let AI fill it in" for an empty skill instead of a verdict it cannot give', async () => {
        renderStudio();
        const rows = await screen.findAllByTestId('skills-overview-row');
        const empty = rows.find(r => r.getAttribute('data-skill-id') === 's2');
        expect(within(empty).getByTestId('skills-overview-fill')).toBeTruthy();
        expect(within(empty).queryByTestId('skills-overview-test')).toBeNull();
    });

    it('shows an em dash, not a zero, for a skill the summary does not cover', async () => {
        renderStudio();
        const rows = await screen.findAllByTestId('skills-overview-row');
        const empty = rows.find(r => r.getAttribute('data-skill-id') === 's2');
        expect(within(empty).getAllByText('—').length).toBeGreaterThan(0);
    });

    it('can be re-sorted by name', async () => {
        const user = userEvent.setup();
        renderStudio();
        await screen.findByTestId('skills-overview');
        await user.click(screen.getByTestId('skills-sort'));
        await user.click(await screen.findByRole('menuitemradio', { name: /name/i }));
        const rows = screen.getAllByTestId('skills-overview-row');
        expect(rows[0].getAttribute('data-skill-id')).toBe('s1');
    });
});

describe('the detail', () => {
    const openFirst = async () => {
        renderStudio({ initialSkillId: 's1' });
        return screen.findByTestId('skill-detail');
    };

    it('opens on "Method" with the shared section header and four tabs, Used by last', async () => {
        await openFirst();
        const tabs = screen.getAllByRole('radio');
        expect(tabs.map(el => el.textContent.replace(/\d+$/, '').trim()))
            .toEqual(['Method', 'Examples', 'Test', 'Used by']);
        // Counts arrive with their own reads: examples from the row, "used by"
        // from the usage endpoint.
        expect(tabs[1].textContent).toContain('1');
        await waitFor(() => expect(screen.getAllByRole('radio')[3].textContent).toContain('2'));
    });

    it('renders the steps in order with their reference pills', async () => {
        await openFirst();
        const steps = screen.getAllByTestId('skill-step');
        expect(steps).toHaveLength(2);
        expect(within(steps[0]).getByTestId('skill-step-ref').getAttribute('data-ref-kind')).toBe('automation');
        await waitFor(() => expect(within(steps[0]).getByText('Look up quote status')).toBeTruthy());
    });

    it('adds a step and autosaves the STRUCTURE, never the old text columns', async () => {
        const user = userEvent.setup();
        await openFirst();
        await user.click(screen.getByTestId('skill-step-add'));
        expect(screen.getAllByTestId('skill-step')).toHaveLength(3);
        await waitFor(() => expect(skillsApi.update).toHaveBeenCalled());
        const [, payload] = skillsApi.update.mock.calls.at(-1);
        expect(payload.steps).toHaveLength(3);
        expect(payload).not.toHaveProperty('workflow');
        expect(payload).not.toHaveProperty('rules');
    });

    it('flips a rule between "always" and "never" from its own mark', async () => {
        const user = userEvent.setup();
        await openFirst();
        const rules = screen.getAllByTestId('skill-rule');
        expect(rules[0].getAttribute('data-polarity')).toBe('never');
        await user.click(within(rules[0]).getByTestId('skill-rule-polarity'));
        expect(screen.getAllByTestId('skill-rule')[0].getAttribute('data-polarity')).toBe('must');
        await waitFor(() => expect(skillsApi.update).toHaveBeenCalled());
        const [, payload] = skillsApi.update.mock.calls.at(-1);
        expect(payload.rulesV2[0].polarity).toBe('must');
    });

    it('turns the output rows into a JSON schema, and an empty list back into null', async () => {
        const user = userEvent.setup();
        await openFirst();
        await user.click(screen.getByTestId('stub-output-rows'));
        await waitFor(() => expect(skillsApi.update).toHaveBeenCalled());
        const [, payload] = skillsApi.update.mock.calls.at(-1);
        expect(payload.outputSchema).toEqual({ type: 'object', properties: { total: { type: 'number' } } });
    });

    it('lists what uses the skill on the last tab', async () => {
        const user = userEvent.setup();
        await openFirst();
        await user.click(screen.getByRole('radio', { name: /Used by/ }));
        expect(await screen.findByTestId('used-by')).toBeTruthy();
        expect(screen.getByText('Quote assistant')).toBeTruthy();
        expect(screen.getByText('Send quote')).toBeTruthy();
    });

    it('shows the examples with their rationale on the Examples tab', async () => {
        const user = userEvent.setup();
        await openFirst();
        await user.click(screen.getByRole('radio', { name: /Examples/ }));
        const cards = await screen.findAllByTestId('skill-example');
        expect(cards).toHaveLength(1);
        expect(within(cards[0]).getByDisplayValue('Why 1240?')).toBeTruthy();
    });
});

/**
 * ── “What does this skill do” and “When to use it” ─────────────────────────
 * The two text cards at the top of Workflow had no test at all, while the
 * interesting half of “When to use it” is precisely what is NOT there.
 *
 * A counter that permanently reports “3,847 of the 4000” turns a field where you
 * write a few sentences into a form where you fill in a quota: it counts the whole
 * time without ever meaning anything. It is therefore gone, and returns only if it
 * does mean something — close to the limit, and then as room that is LEFT, not as
 * consumption.
 *
 * The 4000 limit itself belongs to the SERVER (routes/skills.js refuses more with a
 * 400). What is held here is the side the user notices.
 */
describe('the two text cards on "Method"', () => {
    const openWith = async (over = {}) => {
        skillsApi.list.mockResolvedValue([{ ...FULL, ...over }, EMPTY_SKILL]);
        renderStudio({ initialSkillId: 's1' });
        await screen.findByTestId('skill-detail');
    };

    it('carries what the skill says about itself, under the words a reader recognises', async () => {
        await openWith();
        expect(screen.getByLabelText('What this skill does')).toHaveValue('Explains a quote line by line.');
        expect(screen.getByLabelText('When to use it')).toHaveValue('When someone asks what something means.');
    });

    it('autosaves the description like every other edit on this tab', async () => {
        await openWith();
        fireEvent.change(screen.getByLabelText('What this skill does'), {
            target: { value: 'Explains a quote, line by line, in plain words.' },
        });
        await waitFor(() => expect(skillsApi.update).toHaveBeenCalled());
        expect(skillsApi.update.mock.calls.at(-1)[1].description)
            .toBe('Explains a quote, line by line, in plain words.');
    });

    it('shows no character count while there is room — the number is not the point', async () => {
        await openWith();
        expect(screen.queryByText(/characters left/)).toBeNull();
    });

    it('says quietly how much room is LEFT once the text nears the cap', async () => {
        await openWith({ instructions: 'x'.repeat(3800) });
        expect(screen.getByText('200 characters left')).toBeTruthy();
    });

    /**
     * The threshold sits at 90%, and STRICTLY above it: at exactly 3600 characters
     * nothing is wrong yet. Without this test, a `>=` or another threshold would look
     * identical in the two tests above.
     */
    it('draws that line at 90%: 3600 characters is still silent, 3601 is not', async () => {
        await openWith({ instructions: 'x'.repeat(3600) });
        expect(screen.queryByText(/characters left/)).toBeNull();
        cleanup();
        await openWith({ instructions: 'x'.repeat(3601) });
        expect(screen.getByText('399 characters left')).toBeTruthy();
    });

    /**
     * The cap is the server's; this test guards that the editor never SENDS over it.
     * If it does, the PUT answers 400 without `code`, and the autosave catch only
     * knows 403 and `invalid_structure` — the save light turns red and nobody hears
     * why, again every 350ms. Truncating on this side is therefore not a second rule
     * next to the server's, but the reason that rule cannot fail silently.
     *
     * `maxLength` on the textarea does NOT cover this: that only stops typing and
     * pasting in a real browser, and does nothing about a value that arrives
     * programmatically — precisely the route that “Let AI fill it in” takes.
     */
    it('never sends more than the server will take, so the cap cannot fail in silence', async () => {
        await openWith({ instructions: '' });
        fireEvent.change(screen.getByLabelText('When to use it'), { target: { value: 'y'.repeat(4200) } });
        await waitFor(() => expect(skillsApi.update).toHaveBeenCalled());
        expect(skillsApi.update.mock.calls.at(-1)[1].instructions).toHaveLength(4000);
    });
});

describe('a skill you may see but not change', () => {
    beforeEach(() => {
        skillsApi.list.mockResolvedValue([{ ...FULL, canEdit: false }]);
    });

    it('says so, and offers no editing controls', async () => {
        renderStudio({ initialSkillId: 's1' });
        expect(await screen.findByTestId('skill-readonly')).toBeTruthy();
        expect(screen.queryByTestId('skill-step-add')).toBeNull();
        expect(screen.queryByTestId('skill-rule-add')).toBeNull();
        expect(screen.queryByTestId('skill-improve')).toBeNull();
    });

    // The Test tab is an EDIT surface: a run spends two model calls and
    // writes a `skill_test_runs` row that the owner reads back as a verdict.
    // So the same answer that greys out the steps has to reach it.
    it('carries that answer into the Test tab, where no run is offered either', async () => {
        const user = userEvent.setup();
        renderStudio({ initialSkillId: 's1' });
        await screen.findByTestId('skill-readonly');
        await user.click(screen.getByRole('radio', { name: /Test/ }));
        expect(await screen.findByTestId('skill-test-readonly')).toBeTruthy();
        expect(screen.getByTestId('skill-test-run').disabled).toBe(true);
    });

    it('never fires an autosave for it', async () => {
        renderStudio({ initialSkillId: 's1' });
        await screen.findByTestId('skill-readonly');
        await new Promise(r => setTimeout(r, 400));
        expect(skillsApi.update).not.toHaveBeenCalled();
    });
});


/**
 * The Used-by read can fail — a 500, a network drop, an endpoint an install
 * does not have. `useUsage` reports that as an EMPTY LIST plus an `error`,
 * precisely so nobody mistakes it for "nothing uses this". Everything that
 * reads the list has to honour the second half of that contract.
 */
describe('a usage read that failed', () => {
    let original;
    beforeEach(() => {
        original = authFetch.getMockImplementation();
        authFetch.mockImplementation(async (url) => {
            if (String(url).includes('/usage')) {
                return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
            }
            return original(url);
        });
    });
    afterEach(() => { authFetch.mockImplementation(original); });

    const open = async () => {
        renderStudio({ initialSkillId: 's1' });
        return screen.findByTestId('skill-detail');
    };

    it('puts no count on the "Used by" tab', async () => {
        await open();
        // Let the failing read settle: the wrong answer here would be a
        // count that appears a tick later, not one that was never there.
        await new Promise(r => setTimeout(r, 0));
        const usedBy = screen.getAllByRole('radio')[3];
        expect(usedBy.textContent).toContain('Used by');
        expect(usedBy.textContent).not.toMatch(/\d/);
    });

    it('leaves the standing note off the rail rather than saying "no agent uses this yet"', async () => {
        await open();
        await new Promise(r => setTimeout(r, 0));
        expect(screen.queryByTestId('skill-usedby-note')).toBeNull();
        expect(screen.queryByText(/No agent or automation uses this skill yet/)).toBeNull();
    });

    it('says the list is incomplete on the Used-by tab', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(screen.getByRole('radio', { name: /Used by/ }));
        expect(await screen.findByText(/Could not load who uses this/)).toBeTruthy();
    });

    it('never tells the delete dialog that nothing depends on this skill', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(screen.getByRole('radio', { name: /Used by/ }));
        await user.click(await screen.findByRole('button', { name: 'Delete skill' }));
        // The claim that must never appear.
        expect(screen.queryByTestId('danger-unused')).toBeNull();
        // And it is replaced by the NARROW sentence, not by a spinner that
        // never stops: the read has already failed, so "Checking who uses
        // this…" would be a promise of an answer that is not coming — and this
        // stage removed the refetch from the detail, so there was no way out of
        // it but closing the skill.
        expect(screen.queryByTestId('danger-checking')).toBeNull();
        expect(screen.getByTestId('danger-unchecked')).toBeTruthy();
        expect(screen.getByTestId('danger-unchecked').textContent)
            .toMatch(/not everything could be checked/i);
    });

    it('still shows the count when the read SUCCEEDS — the guard is on the error, not on the tab', async () => {
        authFetch.mockImplementation(original);
        await open();
        await waitFor(() => expect(screen.getAllByRole('radio')[3].textContent).toContain('2'));
        expect(screen.getByTestId('skill-usedby-note').textContent).toContain('2');
    });
});

describe('"Improve with AI"', () => {
    // Until S3 this button was disabled with "arrives with the next release"
    // on it, and a test pinned exactly that. The route exists now, so what is
    // pinned is the behaviour instead: it CALLS, and it adopts the row the
    // server stored — the handler queues no save of its own, so a suggestion
    // that was not persisted server-side would be lost on the next
    // navigation.
    it('calls the route and adopts the STORED skill', async () => {
        const user = userEvent.setup();
        skillsApi.improve.mockResolvedValue({
            skill: {
                ...FULL,
                name: 'Explain a quote, clearly',
                steps: [{ id: 'st1', text: 'Fetch the quote.', refs: [] }],
            },
        });
        renderStudio({ initialSkillId: 's1' });
        const button = await screen.findByTestId('skill-improve');
        expect(button.disabled).toBe(false);
        await user.click(button);
        await waitFor(() => expect(skillsApi.improve).toHaveBeenCalledWith('s1'));
        await waitFor(() => expect(screen.getByDisplayValue('Fetch the quote.')).toBeTruthy());
        expect(screen.getByTestId('skill-detail').textContent).toContain('Explain a quote, clearly');
    });

    it('a refusal is shown and the skill is left alone', async () => {
        const user = userEvent.setup();
        const err = new Error('You cannot edit this skill');
        err.status = 403;
        err.code = 'not_editable';
        skillsApi.improve.mockRejectedValue(err);
        renderStudio({ initialSkillId: 's1' });
        await user.click(await screen.findByTestId('skill-improve'));
        await waitFor(() => expect(screen.getByTestId('skill-readonly')).toBeTruthy());
    });

    it('is not offered at all on a skill this account may not edit', async () => {
        skillsApi.list.mockResolvedValue([{ ...FULL, canEdit: false }]);
        renderStudio({ initialSkillId: 's1' });
        await screen.findByTestId('skill-detail');
        expect(screen.queryByTestId('skill-improve')).toBeNull();
    });
});

describe('"Let AI fill it in", on a skill that is still empty', () => {
    it('is offered only while there is no method yet', async () => {
        renderStudio({ initialSkillId: 's2' });
        expect(await screen.findByTestId('skill-fill-in')).toBeTruthy();
        cleanup();
        renderStudio({ initialSkillId: 's1' });
        await screen.findByTestId('skill-detail');
        expect(screen.queryByTestId('skill-fill-in')).toBeNull();
    });

    it('turns one sentence into a draft the editor saves like any other edit', async () => {
        const user = userEvent.setup();
        skillsApi.draft.mockResolvedValue({
            draft: {
                name: 'Explain a quote',
                description: 'Walks a customer through a quote.',
                instructions: 'When a line is unclear.',
                steps: [{ id: 'n1', text: 'Read the quote', refs: [] }],
                rulesV2: [],
            },
        });
        renderStudio({ initialSkillId: 's2' });
        const card = await screen.findByTestId('skill-fill-in');
        fireEvent.change(within(card).getByRole('textbox'), {
            target: { value: 'help customers understand their quote' },
        });
        await user.click(screen.getByTestId('skill-fill-in-run'));
        await waitFor(() => expect(skillsApi.draft).toHaveBeenCalledWith('help customers understand their quote'));
        // It is a DRAFT: the same autosave that carries a keystroke carries it.
        await waitFor(() => expect(skillsApi.update).toHaveBeenCalled());
        expect(await screen.findByDisplayValue('Read the quote')).toBeTruthy();
    });

    it('a model that could not draft anything leaves the skill alone', async () => {
        const user = userEvent.setup();
        skillsApi.draft.mockRejectedValue(Object.assign(new Error('nope'), { status: 502, code: 'ai_unusable' }));
        renderStudio({ initialSkillId: 's2' });
        const card = await screen.findByTestId('skill-fill-in');
        fireEvent.change(within(card).getByRole('textbox'), { target: { value: 'something' } });
        await user.click(screen.getByTestId('skill-fill-in-run'));
        await waitFor(() => expect(skillsApi.draft).toHaveBeenCalled());
        expect(skillsApi.update).not.toHaveBeenCalled();
    });
});

describe('a reference pill in a step', () => {
    it('opens the automation it points at, through the same deep link the usage table uses', async () => {
        const user = userEvent.setup();
        const onNavigate = vi.fn();
        render(<SkillsStudio user={{ id: 'u1', orgRole: 'org_admin' }} initialSkillId="s1" onNavigate={onNavigate} />);
        await screen.findByTestId('skill-detail');
        const pill = await screen.findByRole('button', { name: 'Look up quote status' });
        await user.click(pill);
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/a1');
    });
});
