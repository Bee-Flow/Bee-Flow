/**
 * The semantic handoff, from the editor's side.
 *
 * Some questions an author asks a Condition simply cannot be a predicate: "is
 * this e-mail about a complaint?" has no field to compare, so the offline
 * catalogue says so and the model fallback says so. This box's answer to that
 * dead end is to make the field — one AI step in front of the node — and what
 * is pinned here is the four promises that offer makes, each of which is a
 * promise an author would act on:
 *
 *   1. IT ONLY APPEARS WHERE IT APPLIES. After the model has answered with a
 *      problem, which is the one state that means "no field here can answer
 *      this". Not for a catalogue problem ("dates have to be written in
 *      full"), where the fix is a better sentence and inserting a step would
 *      answer a question nobody asked.
 *   2. IT ONLY APPEARS WHERE IT CAN BE DONE. The insert rewrites the graph,
 *      so only the shell can perform it; with no callback handed down the
 *      offer is not on screen at all — the `onRenameField` rule, which shows
 *      a name read-only rather than offering an edit that cannot be saved.
 *   3. IT SAYS IT ADDS A STEP, BEFORE THE CLICK. Everything else in this box
 *      rewrites the outputs of the node already open; this one changes the
 *      shape of the automation, and an author who reads "use these 3 outputs"
 *      and gets a new node has been surprised by their own click.
 *   4. NOTHING CHANGES UNTIL ACCEPT, AND THEN IN THAT ORDER. The rules name
 *      the new step's id, so the step goes in first; a refused insert writes
 *      nothing at all rather than leaving the node pointing at a step that
 *      does not exist.
 *
 * Run: cd agent-hub && npx vitest run src/components/automation/Builder/flow/settings/RouteAssist.handoff.test.jsx
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = { suggestRouteRules: vi.fn() };
vi.mock('../../../../../hooks/useAutomationApi', () => ({ default: () => api }));

const { default: RouteAssist } = await import('./RouteAssist');

const FIELDS = [
    { path: 'item.subject', label: 'Subject', type: 'text', sample: 'Bestelling 4471' },
    { path: 'item.from', label: 'From', type: 'text', sample: 'jan@example.nl' },
];

/** What the model says when nothing it was given can answer the question. */
const NO_FIELD = { rules: [], problem: 'None of these fields says what the message is about.' };

const QUESTION = 'is this e-mail about a complaint';

function setup(props = {}) {
    const onApply = vi.fn();
    const onApplyHandoff = vi.fn();
    const onInsertUpstreamStep = vi.fn(() => true);
    render(
        <RouteAssist
            fields={FIELDS}
            onApply={onApply}
            onApplyHandoff={onApplyHandoff}
            onInsertUpstreamStep={onInsertUpstreamStep}
            {...props}
        />,
    );
    return { onApply, onApplyHandoff, onInsertUpstreamStep };
}

function type(value) {
    fireEvent.change(screen.getByLabelText('Describe the outputs you want'), { target: { value } });
}

function answers(value) {
    fireEvent.change(screen.getByLabelText('Name the possible answers'), { target: { value } });
}

/** Get to the state the offer belongs in: the model asked, and it could not. */
async function askAndFail(answer = NO_FIELD) {
    api.suggestRouteRules.mockResolvedValue(answer);
    type(QUESTION);
    fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
    await waitFor(() => expect(api.suggestRouteRules).toHaveBeenCalled());
}

beforeEach(() => {
    api.suggestRouteRules.mockReset();
});

describe('when the offer appears', () => {
    it('only after the model has said no field can answer it', async () => {
        setup();
        type(QUESTION);
        // Before the ask there is a model to try first; offering to add a step
        // straight away would skip the cheaper answer.
        expect(screen.queryByLabelText('Name the possible answers')).toBeNull();
        await askAndFail();
        expect(await screen.findByLabelText('Name the possible answers')).toBeTruthy();
    });

    it('not for a problem the offline catalogue raised — that one has a better fix', () => {
        setup();
        // "Dates have to be written in full" is answered by rewriting the
        // sentence, not by adding a step to the automation.
        type('anything older than last week');
        expect(screen.getByText(/Dates have to be written in full/i)).toBeTruthy();
        expect(screen.queryByLabelText('Name the possible answers')).toBeNull();
    });

    it('not when the model DID answer — there is a field to compare after all', async () => {
        setup();
        await askAndFail({ rules: [{ name: 'vip', expr: 'item.from == "vip@example.nl"' }], problem: '' });
        await screen.findByText('vip');
        expect(screen.queryByLabelText('Name the possible answers')).toBeNull();
    });

    it('NOT AT ALL when the shell cannot insert a step', async () => {
        // The same rule as renaming a form question's binding: the panel shows
        // what it cannot change, it does not offer to change it.
        setup({ onInsertUpstreamStep: null });
        await askAndFail();
        expect(await screen.findByText(/None of these fields says/i)).toBeTruthy();
        expect(screen.queryByLabelText('Name the possible answers')).toBeNull();
    });

    it('goes away again when the sentence changes', async () => {
        setup();
        await askAndFail();
        await screen.findByLabelText('Name the possible answers');
        type('split these files by pdf and word');
        expect(screen.queryByLabelText('Name the possible answers')).toBeNull();
    });
});

describe('what it shows before anything happens', () => {
    it('SAYS IT ADDS A STEP, in those words', async () => {
        setup();
        await askAndFail();
        await screen.findByLabelText('Name the possible answers');
        expect(screen.getByText(/ADDS A STEP to your automation/)).toBeTruthy();
    });

    it('shows nothing to accept until the answers are named', async () => {
        setup();
        await askAndFail();
        await screen.findByLabelText('Name the possible answers');
        expect(screen.queryByRole('button', { name: /Add the step/i })).toBeNull();
    });

    it('asks for a second answer rather than offering a one-output router', async () => {
        setup();
        await askAndFail();
        answers('complaint');
        expect(await screen.findByText(/at least two possible answers/i)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Add the step/i })).toBeNull();
    });

    it('previews the step and reads every output back as a sentence', async () => {
        setup();
        await askAndFail();
        answers('complaint, question, something else');
        expect(await screen.findByText(/Classify: is this e-mail about a complaint/)).toBeTruthy();
        // The names of the ports...
        expect(screen.getByText('something_else')).toBeTruthy();
        // ...and what each one checks, as words — never the expression.
        // New text rules are `equals()`, which reads "is" (R7).
        expect(screen.getByText(/\bis “complaint”/)).toBeTruthy();
        expect(screen.queryByText(/is exactly/)).toBeNull();
        expect(screen.queryByText(/steps\..*\.output\./)).toBeNull();
        expect(screen.queryByText(/==|equals\(/)).toBeNull();
    });

    it('says the sample rows cannot answer this one, instead of counting zero', async () => {
        // Every other preview here counts against real rows. The field being
        // compared does not exist in any of them yet, and "0 of 12 matched"
        // would read as a broken rule rather than an unanswered question.
        setup({ sampleRows: [{ subject: 'a' }, { subject: 'b' }], unit: 'items', sourceRef: 'steps.gmail.output.messages' });
        await askAndFail();
        answers('complaint, other');
        expect(await screen.findByText(/Nothing can be counted against the sample items yet/i)).toBeTruthy();
    });

    it('names what the accept would cost on the canvas before it costs it', async () => {
        setup({ existingRuleCount: 2, wiredOutputNames: ['vip', 'complaint'] });
        await askAndFail();
        answers('complaint, other');
        expect(await screen.findByText(/replaces the 2 outputs already/i)).toBeTruthy();
        // 'complaint' survives because the plan reuses the name, so only 'vip'
        // actually loses its connection.
        expect(screen.getByText(/vip is wired on the canvas/i)).toBeTruthy();
    });

    it('changes nothing at all while it is only being previewed', async () => {
        const { onApply, onApplyHandoff, onInsertUpstreamStep } = setup();
        await askAndFail();
        answers('complaint, question, something else');
        await screen.findByRole('button', { name: /Add the step/i });
        expect(onInsertUpstreamStep).not.toHaveBeenCalled();
        expect(onApplyHandoff).not.toHaveBeenCalled();
        expect(onApply).not.toHaveBeenCalled();
    });
});

describe('accepting it', () => {
    async function accept(props = {}) {
        const handles = setup(props);
        await askAndFail();
        answers('complaint, question, something else');
        fireEvent.click(await screen.findByRole('button', { name: /Add the step/i }));
        return handles;
    }

    it('inserts an ai_step that declares the field the rules read', async () => {
        const { onInsertUpstreamStep, onApplyHandoff } = await accept();
        const step = onInsertUpstreamStep.mock.calls[0][0];
        expect(step.type).toBe('ai_step');
        const field = Object.keys(step.outputSchema.properties)[0];
        for (const rule of onApplyHandoff.mock.calls[0][0].rules) {
            expect(rule.expr).toBe(`equals(steps.${step.id}.output.${field}, ${JSON.stringify(ruleWord(rule.name))})`);
        }
    });

    it('puts the STEP IN FIRST, then the rules that name it', async () => {
        const { onInsertUpstreamStep, onApplyHandoff } = await accept();
        expect(onInsertUpstreamStep).toHaveBeenCalledTimes(1);
        expect(onApplyHandoff).toHaveBeenCalledTimes(1);
        expect(onInsertUpstreamStep.mock.invocationCallOrder[0])
            .toBeLessThan(onApplyHandoff.mock.invocationCallOrder[0]);
    });

    it('WRITES NOTHING when the shell refuses the insert', async () => {
        // Rules naming a step that was never added is the silent-empty-branch
        // failure this whole feature exists to remove.
        const { onApplyHandoff } = await accept({ onInsertUpstreamStep: vi.fn(() => false) });
        expect(onApplyHandoff).not.toHaveBeenCalled();
    });

    it('hands the per-item list over too, so the rules have something to read', async () => {
        const { onInsertUpstreamStep, onApplyHandoff } = await accept({
            unit: 'items',
            sourceRef: 'steps.gmail.output.messages',
        });
        const step = onInsertUpstreamStep.mock.calls[0][0];
        expect(step.forEach).toEqual({ overRef: 'steps.gmail.output.messages', itemVar: 'item' });
        const plan = onApplyHandoff.mock.calls[0][0];
        expect(plan.source).toBe(`steps.${step.id}.output.results`);
        expect(plan.rules[0].expr.startsWith('equals(item.output.')).toBe(true);
    });

    it('never sends anything anywhere — the whole handoff is local', async () => {
        await accept();
        // One call, the one the author clicked "Ask the AI" for. Building a
        // step out of the author's own words needs no round trip, and a
        // Condition node sits over customer records (BFSF-441).
        expect(api.suggestRouteRules).toHaveBeenCalledTimes(1);
    });
});

/** The word an output was named after — `something_else` → `something else`. */
function ruleWord(name) {
    return name.replace(/_/g, ' ');
}
