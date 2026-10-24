import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CanUseCard from './CanUseCard';
import ExamplesTab from './ExamplesTab';
import { skillsApi } from './skillsApi';
import { queryWrapper } from '../../../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

/**
 * Examples, and the grants a skill carries.
 *
 * The example picker is the one place in this section that reads a
 * CONVERSATION, so what is pinned here is the client half of that contract:
 * it never talks to the agents API (the owner check lives in ONE server
 * handler, routes/skills/examples.js), it reads the redacted preview before
 * anything is stored, and it says so on screen before the click.
 *
 * For "May use", the claim is that only an `agent_call` automation can be
 * offered — "may use" means "offered as a callable tool", and the runtime
 * dispatches nothing else.
 */

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
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

function ExamplesHarness({ initial = [], rules = [], readOnly = false, onExamples }) {
    const [examples, setExamples] = useState(initial);
    return (
        <ExamplesTab
            skillId="s1"
            examples={examples}
            rules={rules}
            readOnly={readOnly}
            onChange={(next) => { setExamples(next); onExamples?.(next); }}
        />
    );
}

function CanUseHarness({ initial = {}, automations = [], knowledgeBases = [], readOnly = false, onPatch }) {
    const [state, setState] = useState({
        enabledIntegrations: [], allowedAutomationIds: [], knowledgeBaseIds: [],
        dynamicActivation: false, ...initial,
    });
    return (
        <CanUseCard
            {...state}
            automations={automations}
            knowledgeBases={knowledgeBases}
            readOnly={readOnly}
            onChange={(next) => { setState(s => ({ ...s, ...next })); onPatch?.(next); }}
        />
    );
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    skillsApi.exampleConversations.mockResolvedValue({
        conversations: [{ id: 'c1', title: 'Quote 2026-0412', agentName: 'Quote assistant' }],
    });
    skillsApi.exampleMessages.mockResolvedValue({
        messages: [
            { index: 0, role: 'user', text: 'Why 1240?' },
            { index: 1, role: 'assistant', text: 'That line covers [person_1]’s work.' },
        ],
    });
    skillsApi.exampleFromMessage.mockResolvedValue({
        example: { id: 'e9', question: 'Why 1240?', good: 'That line covers [person_1]’s work.', sourceConversationId: 'c1' },
    });
});

describe('examples', () => {
    it('adds an empty example with an id of its own', () => {
        const onExamples = vi.fn();
        render(<ExamplesHarness onExamples={onExamples} />);
        fireEvent.click(screen.getByTestId('skill-example-add'));
        const [next] = onExamples.mock.calls.at(-1);
        expect(next).toHaveLength(1);
        expect(next[0].id).toMatch(/^ex_/);
    });

    it('asks for the bad half only once the good half exists', () => {
        render(<ExamplesHarness initial={[{ id: 'e1', question: 'q', good: 'g', rationale: '', bad: '', violatedRuleId: '' }]} />);
        expect(screen.getByTestId('skill-example-add-bad')).toBeTruthy();
        expect(screen.queryByTestId('skill-example-violates')).toBeNull();
    });

    /**
     * Opening the half used to autosave `bad: ' '`. The server keeps `bad`
     * only when it is non-blank, so that space never survived — the half
     * looked stored and came back closed, and an autosave had fired for
     * nothing. Opening a field is not an edit.
     */
    it('opens the bad half without writing anything', () => {
        const onExamples = vi.fn();
        render(<ExamplesHarness
            initial={[{ id: 'e1', question: 'q', good: 'g', rationale: '', bad: '', violatedRuleId: '' }]}
            onExamples={onExamples}
        />);
        fireEvent.click(screen.getByTestId('skill-example-add-bad'));
        expect(onExamples).not.toHaveBeenCalled();
        expect(screen.getByTestId('skill-example-violates')).toBeTruthy();
        // …and typing into it IS an edit, which does get stored.
        fireEvent.change(screen.getByLabelText('Not like this'), { target: { value: 'Sure, 40% off.' } });
        expect(onExamples.mock.calls.at(-1)[0][0].bad).toBe('Sure, 40% off.');
    });

    it('offers the skill\'s own rules as the rule a bad answer breaks', () => {
        render(<ExamplesHarness
            initial={[{ id: 'e1', question: 'q', good: 'g', bad: 'nope', violatedRuleId: '' }]}
            rules={[{ id: 'r1', text: 'Never promise a discount.' }]}
        />);
        const select = screen.getByTestId('skill-example-violates');
        expect(within(select).getByRole('option', { name: 'Never promise a discount.' })).toBeTruthy();
    });

    /**
     * Rules can be deleted while an example still names one. A <select> with
     * no option for its own value shows the FIRST option instead, so the card
     * used to read "No specific rule" over a `violatedRuleId` that was still
     * there and still being saved. The screen has to say what the data says.
     */
    it('names a deleted rule instead of quietly reading as “no rule”', () => {
        const onExamples = vi.fn();
        render(<ExamplesHarness
            initial={[{ id: 'e1', question: 'q', good: 'g', bad: 'nope', violatedRuleId: 'rule_deleted' }]}
            rules={[{ id: 'r1', text: 'Never promise a discount.' }]}
            onExamples={onExamples}
        />);
        const select = screen.getByTestId('skill-example-violates');
        expect(select.value).toBe('rule_deleted');
        expect(within(select).getByRole('option', { name: /was removed/ })).toBeTruthy();
        // …and it is a dead end nobody is stuck in: picking a live rule replaces it.
        fireEvent.change(select, { target: { value: 'r1' } });
        expect(onExamples.mock.calls.at(-1)[0][0].violatedRuleId).toBe('r1');
    });

    /**
     * PROVENANCE, and nothing more. This rule hung only on the EXISTENCE of
     * `sourceConversationId`, and that field is client input: PUT /api/skills/:id
     * takes `examplesV2` straight from the body and scans nothing. A hand-typed
     * example with an arbitrary id thus carried the sentence “personal data removed”
     * without any guard ever being involved — precisely the promise the chooser
     * withdraws himself as soon as the check did not run. And “one of YOUR
     * conversations” stood there for EVERY reader of a shared skill; that phrase
     * survives the click and is read by colleagues.
     */
    it('says where an example came from — and promises nothing about a check it cannot see', () => {
        render(<ExamplesHarness initial={[{ id: 'e1', question: 'q', good: 'g', sourceConversationId: 'c1' }]} />);
        const note = screen.getByTestId('skill-example-source');
        expect(note.textContent).toBe('Taken from a conversation');
        expect(note.textContent).not.toMatch(/personal data/i);
        expect(note.textContent).not.toMatch(/your conversations/i);
        expect(screen.queryByRole('link')).toBeNull();
    });

    it('gives a read-only viewer no way to add or take one from a chat', () => {
        render(<ExamplesHarness initial={[{ id: 'e1', question: 'q', good: 'g' }]} readOnly />);
        expect(screen.queryByTestId('skill-example-add')).toBeNull();
        expect(screen.queryByTestId('skill-example-from-chat')).toBeNull();
    });
});

describe('taking an example from a conversation', () => {
    const openPicker = async () => {
        render(<ExamplesHarness />);
        fireEvent.click(screen.getByTestId('skill-example-from-chat'));
        return screen.findByTestId('skill-example-conversation');
    };

    it('lists only the caller\'s own conversations, through the skills API', async () => {
        await openPicker();
        expect(skillsApi.exampleConversations).toHaveBeenCalled();
        expect(screen.getByText('Quote 2026-0412')).toBeTruthy();
        expect(screen.getByText(/Only your own conversations are listed/)).toBeTruthy();
    });

    it('promises the redaction BEFORE the click, not after', async () => {
        await openPicker();
        expect(screen.getByText(/Personal data is removed before the example is stored/)).toBeTruthy();
    });

    /**
     * The server answers `piiChecked` per read because `detectPii` fails open
     * in two shapes — no guard, and a guard that could not scan — and both
     * come back looking like "nothing found". While it is false the write
     * refuses (503 `pii_unchecked`), so the sentence has to come down with it:
     * a promise left standing over text nothing looked at is the one thing
     * this screen must never do.
     */
    it('withdraws the promise when the checker did not run', async () => {
        skillsApi.exampleMessages.mockResolvedValue({
            messages: [{ index: 1, role: 'assistant', text: 'Tell Jan Bakker it is fine.' }],
            piiChecked: false,
        });
        fireEvent.click(await openPicker());
        await screen.findByTestId('skill-example-message');
        expect(screen.queryByText(/Personal data is removed before the example is stored/)).toBeNull();
        expect(screen.getByText(/personal-data check is unavailable/)).toBeTruthy();
    });

    it('keeps the promise standing when the checker did run', async () => {
        fireEvent.click(await openPicker());
        await screen.findByTestId('skill-example-message');
        expect(screen.getByText(/Personal data is removed before the example is stored/)).toBeTruthy();
    });

    it('shows the redacted preview and offers only the answers', async () => {
        fireEvent.click(await openPicker());
        await waitFor(() => expect(skillsApi.exampleMessages).toHaveBeenCalledWith('c1'));
        const options = await screen.findAllByTestId('skill-example-message');
        expect(options).toHaveLength(1);
        expect(options[0].textContent).toContain('[person_1]');
    });

    it('stores the chosen message by its index and adds what the server hands back', async () => {
        const onExamples = vi.fn();
        render(<ExamplesHarness onExamples={onExamples} />);
        fireEvent.click(screen.getByTestId('skill-example-from-chat'));
        fireEvent.click(await screen.findByTestId('skill-example-conversation'));
        fireEvent.click(await screen.findByTestId('skill-example-message'));
        await waitFor(() => expect(skillsApi.exampleFromMessage).toHaveBeenCalledWith('s1', {
            conversationId: 'c1', messageIndex: 1,
        }));
        await waitFor(() => expect(onExamples).toHaveBeenCalled());
        expect(onExamples.mock.calls.at(-1)[0][0].id).toBe('e9');
    });

    /**
     * A failed read is not an empty list. “No conversations of your own
     * yet.” is a statement about the ACCOUNT, and it stood there after a 500 —
     * next to the error line, so the screen made two contradictory claims at once.
     */
    it('does not report a failed conversation read as an empty account', async () => {
        skillsApi.exampleConversations.mockRejectedValue(new Error('boom'));
        render(<ExamplesHarness />);
        fireEvent.click(screen.getByTestId('skill-example-from-chat'));
        expect(await screen.findByText(/could not be read just now/)).toBeTruthy();
        expect(screen.queryByText(/No conversations of your own yet/)).toBeNull();
    });

    it('does not report a failed message read as an empty conversation, and drops the promise with it', async () => {
        skillsApi.exampleMessages.mockRejectedValue(new Error('boom'));
        render(<ExamplesHarness />);
        fireEvent.click(screen.getByTestId('skill-example-from-chat'));
        fireEvent.click(await screen.findByTestId('skill-example-conversation'));
        expect(await screen.findByText(/could not be read just now/)).toBeTruthy();
        expect(screen.queryByText(/Nothing in this conversation to use/)).toBeNull();
        // The promise of the PREVIOUS conversation must not remain standing over a
        // read that never produced anything.
        expect(screen.queryByText(/Personal data is removed before the example is stored/)).toBeNull();
    });

    /**
     * The 503 mints `code: 'pii_unchecked'`, and the client used it nowhere:
     * `setError(e.message)` put the raw English server sentence on a Dutch-language
     * screen. And the messages stayed clickable while the warning above said that
     * nothing could be copied.
     */
    it('translates the server CODE, not its English sentence, and stops offering the click', async () => {
        const refusal = Object.assign(new Error('The personal-data check is unavailable, so this answer cannot be copied into an example right now.'), {
            status: 503, code: 'pii_unchecked',
        });
        skillsApi.exampleFromMessage.mockRejectedValue(refusal);
        render(<ExamplesHarness />);
        fireEvent.click(screen.getByTestId('skill-example-from-chat'));
        fireEvent.click(await screen.findByTestId('skill-example-conversation'));
        const row = await screen.findByTestId('skill-example-message');
        expect(row.disabled).toBe(false);
        fireEvent.click(row);

        // De zin komt nu uit t() (sleutel + fallback), niet uit e.message.
        // Twee treffers: de foutregel én de ingetrokken belofte erboven.
        expect((await screen.findAllByText(/personal-data check is unavailable/)).length).toBeGreaterThan(0);
        // …en de kiezer weet het nu vóór de volgende klik.
        await waitFor(() => expect(screen.getByTestId('skill-example-message').disabled).toBe(true));
        expect(screen.getByTestId('skill-example-pii-note').getAttribute('role')).toBe('status');
    });

    it('surfaces a refusal instead of pretending the example was added', async () => {
        skillsApi.exampleFromMessage.mockRejectedValue(new Error('Conversation not found'));
        const onExamples = vi.fn();
        render(<ExamplesHarness onExamples={onExamples} />);
        fireEvent.click(screen.getByTestId('skill-example-from-chat'));
        fireEvent.click(await screen.findByTestId('skill-example-conversation'));
        fireEvent.click(await screen.findByTestId('skill-example-message'));
        expect(await screen.findByText('Conversation not found')).toBeTruthy();
        expect(onExamples).not.toHaveBeenCalled();
    });
});

describe('"may use"', () => {
    it('offers an automation to link and records it as an allowed automation', () => {
        const onPatch = vi.fn();
        render(<CanUseHarness
            automations={[{ id: 'a1', title: 'Look up quote status' }]}
            onPatch={onPatch}
        />);
        fireEvent.click(screen.getByTestId('skill-grant-add'));
        fireEvent.click(screen.getByRole('menuitem', { name: /Look up quote status/ }));
        expect(onPatch).toHaveBeenCalledWith({ allowedAutomationIds: ['a1'] });
    });

    it('says why the automation list is empty instead of showing nothing', () => {
        render(<CanUseHarness automations={[]} knowledgeBases={[]} />);
        fireEvent.click(screen.getByTestId('skill-grant-add'));
        expect(screen.getByText(/an agent calls it/)).toBeTruthy();
    });

    it('names a linked knowledge base, and unlinks it again', () => {
        const onPatch = vi.fn();
        render(<CanUseHarness
            initial={{ knowledgeBaseIds: ['k1'] }}
            knowledgeBases={[{ id: 'k1', name: 'Quote terms' }]}
            onPatch={onPatch}
        />);
        const pill = screen.getByTestId('skill-grant');
        expect(within(pill).getByText('Quote terms')).toBeTruthy();
        fireEvent.click(within(pill).getByRole('button', { name: /Unlink Quote terms/ }));
        expect(onPatch).toHaveBeenCalledWith({ knowledgeBaseIds: [] });
    });

    it('keeps dynamic activation, with its sentence, under "All options"', () => {
        const onPatch = vi.fn();
        render(<CanUseHarness onPatch={onPatch} />);
        fireEvent.click(screen.getByText('All options'));
        expect(screen.getByText(/the agent decides at runtime/)).toBeTruthy();
        fireEvent.click(screen.getByTestId('skill-dynamic'));
        expect(onPatch).toHaveBeenCalledWith({ dynamicActivation: true });
    });

    it('explains a legacy automation_id instead of hiding a field that overrides the body', () => {
        render(<CanUseCard
            enabledIntegrations={[]}
            allowedAutomationIds={[]}
            knowledgeBaseIds={[]}
            dynamicActivation={false}
            legacyAutomationId="aut_legacy"
            onChange={() => {}}
        />);
        fireEvent.click(screen.getByText('All options'));
        expect(screen.getByTestId('skill-legacy-automation').textContent).toContain('aut_legacy');
    });
});
