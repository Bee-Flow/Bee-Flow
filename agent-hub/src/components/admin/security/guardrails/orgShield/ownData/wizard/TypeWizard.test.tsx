import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import { renderableTab } from '../testKit';
import { authFetch } from '../../../../../../../utils/helpers';

/**
 * The whole wizard, against a fake test-bench server: describe a fixed
 * format from real examples, let the assistant write sentences (it is shown
 * look-alikes, never the examples), mark by keyboard, test, correct a result,
 * tune and undo, choose where it applies, and add it to the list.
 */

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number, body: unknown) => ({ ok: false, status, json: async () => body }) as Response;

type Call = { path: string; body: Record<string, unknown> };
let calls: Call[] = [];
let assistReply: () => Response;

const ASSIST = {
    outbound: { name: 'Customer numbers', description: 'Our customer numbers. They always have the same format.', lookalikes: ['KL-83920', 'KL-10473'] },
    suggestedMethod: 'pattern',
    sentences: [
        { id: 'a1', text: 'Invoice KL-12345 was paid', gold: [{ start: 8, end: 16 }] },
        { id: 'a2', text: 'Please check KL-54321 today', gold: [{ start: 13, end: 21 }] },
        { id: 'a3', text: 'KL-12345 and KL-54321 are open', gold: [{ start: 0, end: 8 }, { start: 13, end: 21 }] },
        { id: 'a4', text: 'Customer KL-54321 called', gold: [{ start: 9, end: 17 }] },
        { id: 'a5', text: 'Close KL-12345 now', gold: [{ start: 6, end: 14 }] },
    ],
    nearMisses: [{ id: 'n1', text: 'Call KL-00000 if lost', gold: [] }],
    candidates: { patterns: [{ source: 'KL-\\d{4,5}', describe: 'KL- and 4 or 5 digits' }], aiLabels: [] },
    dropped: { sentences: 0, patterns: 0, labels: 0 },
};

/** The fake /test: runs the draft's own pattern, like the real Node matcher. */
function runTest(body: Record<string, unknown>) {
    const type = body.type as { pattern: { source: string } };
    const re = new RegExp(type.pattern.source, 'gi');
    const sentences = body.sentences as { id: string; text: string }[];
    return {
        results: sentences.map(s => ({
            id: s.id,
            marks: [...s.text.matchAll(re)].map(m => ({ start: m.index!, end: m.index! + m[0].length, kind: 'found' })),
        })),
        summary: { found: 0, total: 0, falseAlarms: 0, sentences: sentences.length },
        engine: 'local',
    };
}

beforeEach(() => {
    calls = [];
    assistReply = () => ok(ASSIST);
    vi.mocked(authFetch).mockImplementation(async (url: string, opts?: RequestInit) => {
        const path = url.split('/custom-data/')[1] || url;
        const body = opts?.body ? JSON.parse(String(opts.body)) : {};
        calls.push({ path, body });
        if (path === 'assist/preview') {
            return ok({ outbound: { ...ASSIST.outbound, name: body.type.name }, keepFixedProposal: ['KL-'] });
        }
        if (path === 'assist') return assistReply();
        if (path === 'test') return ok(runTest(body));
        if (path === 'tune') {
            return ok({
                best: {
                    config: { pattern: { source: '\\bKL-\\d{4,5}\\b', caseSensitive: false } },
                    summary: { found: 8, total: 8, falseAlarms: 0, sentences: 7 },
                    describe: { patternWords: 'KL- followed by 4 or 5 digits' },
                },
                before: { summary: { found: 7, total: 8, falseAlarms: 0, sentences: 7 } },
                improved: true,
                tried: 3,
            });
        }
        return ok({});
    });
});

const last = (path: string) => [...calls].reverse().find(c => c.path === path)!;

/** A sentence's text is split into runs by its marks, so match the paragraph as a whole. */
const sentenceText = (text: string) => (_: string, el: Element | null) => el?.tagName === 'P' && el.textContent === text;
const sentenceRow = (text: string) => screen.getByText(sentenceText(text)).closest('li') as HTMLElement;

async function openNumbersStarter(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Customer or contract numbers' }));
    const add = screen.getByLabelText('Type a real example and press Enter');
    await user.type(add, 'KL-12345{Enter}');
    await user.type(add, 'KL-54321{Enter}');
}

type User = ReturnType<typeof userEvent.setup>;
type Form = ReturnType<typeof renderableTab>['form'];

const readout = () => screen.getByText(/^Finds \d+ of \d+$/).closest('[role="status"]') as HTMLElement;

/** Step 1: the browser check is advisory, but it is live. */
async function describeStep(user: User) {
    await user.click(screen.getByRole('button', { name: /Write the pattern yourself/ }));
    expect(screen.getByText(/From your examples we would use: \\bKL-\\d\{5\}\\b/)).toBeInTheDocument();
    expect(screen.getByText('Matches 2 of 2 examples')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Describe');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Test and tune');
}

/** Step 2a: the card shows exactly what the assistant would get, and never a real example. */
async function assistantStep(user: User) {
    const card = (await screen.findByText('KL-83920, KL-10473')).closest('div.rounded-xl') as HTMLElement;
    expect(card).toHaveTextContent('Customer numbers');
    expect(card.textContent).not.toContain('KL-12345');
    expect(card.textContent).not.toContain('KL-54321');
    expect(last('assist/preview').body).toEqual({
        type: expect.objectContaining({ name: 'Customer numbers', method: 'pattern' }),
        examples: ['KL-12345', 'KL-54321'],
    });
    // Keep the fixed prefix: only what the preview proposed is offered.
    await user.click(screen.getByRole('checkbox', { name: /Keep “KL-” as it is/ }));
    await waitFor(() => expect(last('assist/preview').body.keepFixed).toEqual(['KL-']));
    await user.click(await screen.findByRole('button', { name: 'Write test sentences' }));
    await screen.findByText(sentenceText('Invoice KL-12345 was paid'));
    expect(last('assist').body.expectLookalikes).toEqual(['KL-83920', 'KL-10473']);
}

/** Step 2b: a sentence of our own, marked with the keyboard path, then a test and a correction. */
async function markAndTestStep(user: User) {
    await user.type(screen.getByLabelText('Add a sentence'), 'Order KL-7777 is late{Enter}');
    const own = sentenceRow('Order KL-7777 is late');
    await user.click(within(own).getByRole('button', { name: 'More for this sentence' }));
    await user.click(within(own).getByRole('button', { name: 'Mark what should be hidden…' }));
    await user.type(within(own).getByLabelText('Type the exact text that should be hidden'), 'KL-7777{Enter}');

    // The near miss is a false alarm, the four-digit code a miss.
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Finds 6 of 7')).toBeInTheDocument();
    expect(readout()).toHaveTextContent('1 false alarm');
    expect(readout()).toHaveTextContent('It misses some. Press Tune, or add more examples.');
    expect(readout()).toHaveTextContent('Measured on your 7 test sentences.');
    const sent = last('test').body.sentences as { id: string; gold?: unknown }[];
    expect(sent.find(x => x.id === 'n1')?.gold).toEqual([]);

    // Right/wrong: that "false alarm" should in fact be hidden.
    await user.click(screen.getByRole('button', { name: 'False alarm: KL-00000' }));
    await user.click(screen.getByRole('button', { name: 'Right, hide this' }));
    expect(screen.getByText('Finds 7 of 8')).toBeInTheDocument();
    expect(readout()).toHaveTextContent('no false alarms');
}

/** Step 2c: Tune re-tests with what it kept; Undo puts the old settings and result back. */
async function tuneStep(user: User) {
    await user.click(screen.getByRole('button', { name: 'Tune automatically' }));
    expect(await screen.findByText('Tuned. Now finds 8 of 8 (was 7) with no false alarms (was 0).')).toBeInTheDocument();
    expect(screen.getByText('We now use: KL- followed by 4 or 5 digits.')).toBeInTheDocument();
    expect(last('tune').body.candidates).toEqual({ patterns: ['KL-\\d{4,5}'], aiLabels: [] });
    expect(await screen.findByText('Finds 8 of 8')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('Finds 7 of 8')).toBeInTheDocument();
    expect(screen.queryByText(/^Tuned\./)).toBeNull();
}

/** Step 3, then "Add to the list": only now does the form change. */
async function applyStep(user: User, form: Form) {
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('checkbox', { name: 'Hide from AI' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Outside tools' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Own server' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Own server' }));
    expect(screen.getByText(/In short: The AI sees \[customer_number_1\] instead\./)).toBeInTheDocument();
    expect(form.current?.customDataTypes).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Add to the list' }));
    expect(screen.getByRole('status')).toHaveTextContent('Added. Press Save to switch it on.');
    expect(screen.getByRole('rowheader', { name: /Customer numbers/ })).toBeInTheDocument();
}

function expectCommitted(form: Form) {
    const [type] = form.current!.customDataTypes;
    expect(type).toMatchObject({
        name: 'Customer numbers', method: 'pattern', tokenKey: 'customer_number', origin: 'created',
        pattern: { source: '\\bKL-\\d{5}\\b', caseSensitive: false },
        quality: { found: 7, total: 8, falseAlarms: 0, sentences: 7 },
    });
    expect(type.words).toBeUndefined();
    expect(form.current!.customDataTests?.[type.id]).toMatchObject({ examples: ['KL-12345', 'KL-54321'], keepFixed: ['KL-'] });
    expect(form.current!.customDataTests?.[type.id].sentences).toHaveLength(7);
    expect(form.current!.piiCategories).toContain(type.id);
    expect(form.current!.toolPiiPolicy.external.blockCategories).toContain(type.id);
    expect(form.current!.toolPiiPolicy.internal.blockCategories).toContain(type.id);
}

describe('TypeWizard', () => {
    it('builds, tests, tunes and adds a fixed-format type', async () => {
        const user = userEvent.setup();
        const { ui, form } = renderableTab();
        render(ui);
        await openNumbersStarter(user);
        await describeStep(user);
        await assistantStep(user);
        await markAndTestStep(user);
        await tuneStep(user);
        await applyStep(user, form);
        expectCommitted(form);
    });

    it('discards the draft on Cancel, after asking', async () => {
        const user = userEvent.setup();
        const { ui, form } = renderableTab();
        render(ui);
        await openNumbersStarter(user);
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Stop without saving this type?');
        await user.click(within(dialog).getByRole('button', { name: 'Stop' }));
        expect(screen.getByRole('group', { name: 'Start from an example' })).toBeInTheDocument();
        expect(form.current?.customDataTypes).toEqual([]);
        expect(form.current?.customDataTests).toEqual({});
    });

    it('refuses to send a description that seems to hold a name, and quotes it', async () => {
        assistReply = () => fail(422, {
            error: 'x', code: 'assist_personal_data', correlationId: 'c',
            // Offsets point into the PREVIEW text, not the raw input.
            details: { findings: [{ field: 'description', start: 4, end: 10, category: 'Person' }] },
        });
        const user = userEvent.setup();
        const { ui } = renderableTab();
        render(ui);
        await openNumbersStarter(user);
        await user.click(screen.getByRole('button', { name: 'Next' }));
        await user.click(await screen.findByRole('button', { name: 'Write test sentences' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Your description seems to contain a name: “custom”. Remove it, then try again.');
    });

    it('offers own sentences when the assistant is not available', async () => {
        assistReply = () => fail(503, { error: 'x', code: 'no_assist_model' });
        const user = userEvent.setup();
        const { ui } = renderableTab();
        render(ui);
        await openNumbersStarter(user);
        await user.click(screen.getByRole('button', { name: 'Next' }));
        await user.click(await screen.findByRole('button', { name: 'Write test sentences' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('The assistant is not available right now. You can still write your own test sentences.');
    });

    it('does not offer AI recognition while the detection service is down', async () => {
        const user = userEvent.setup();
        const { ui } = renderableTab({ guard: { configured: true, reachable: false } });
        render(ui);
        await user.click(screen.getByRole('button', { name: 'Project code names' }));
        expect(screen.getByRole('radio', { name: /Recognised by AI/ })).toBeDisabled();
        expect(screen.getAllByText('Needs the detection service, which is not running.').length).toBeGreaterThan(0);
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    });
});
