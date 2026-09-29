/**
 * The semantic handoff, end to end through the Condition editor.
 *
 * `RouteAssist.handoff.test.jsx` pins what the box offers and in what order it
 * writes. This drives the same feature the way an author meets it — a real
 * SettingsForm over a real step — and checks what LANDS, because the two
 * halves of an accepted handoff are written by different owners and the shape
 * of the failure is a node that looks configured and routes nothing:
 *
 *   - the STEP goes to the shell, which owns the graph;
 *   - the RULES go into this node's own draft, through the same writeRoute
 *     path a hand-built router takes, so a handed-off switch saves exactly
 *     like every other switch;
 *   - and for a node that works through a LIST, so does the source. That one
 *     is not decoration: the inserted step is fanned out over the list, which
 *     publishes a results list rather than the rows, and rules addressing
 *     `item.output.<field>` against the old source would resolve to nothing
 *     for every row — an empty branch with no error anywhere, which is the
 *     failure this whole feature exists to remove.
 *
 * Run: cd agent-hub && npx vitest run src/components/automation/Builder/flow/settings/routeEditors.handoff.test.jsx
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import scopedStorage from '../../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';

const api = { suggestRouteRules: vi.fn() };
vi.mock('../../../../../hooks/useAutomationApi', () => ({ default: () => api }));

const { default: SettingsForm } = await import('../SettingsForm');

const noIssues = { errors: [], warnings: [] };

const MAIL_ROWS = [{ subject: 'Bestelling 4471' }, { subject: 'Waar blijft mijn pakket' }];

const MAIL_GROUP = {
    id: 'm', label: 'gmail search', kind: 'integration_action', basePath: 'steps.m.output',
    sample: { messages: MAIL_ROWS },
    fields: [{ key: 'messages', path: 'steps.m.output.messages', sample: MAIL_ROWS }],
};
const MAIL_ROOT = { steps: { m: { output: { messages: MAIL_ROWS } } } };

const DOC_GROUP = {
    id: 'g', label: 'get message', kind: 'integration_action', basePath: 'steps.g.output',
    sample: { body: 'Waar blijft mijn pakket' },
    fields: [{ key: 'body', path: 'steps.g.output.body', sample: 'Waar blijft mijn pakket' }],
};
const DOC_ROOT = { steps: { g: { output: { body: 'Waar blijft mijn pakket' } } } };

const LIST_STEP = { id: 'f1', type: 'filter', arrayRef: 'steps.m.output.messages', expr: '' };
const IF_STEP = { id: 'r1', type: 'condition', expr: '' };

function renderForm(step, { groups, previewSample, onInsertUpstreamStep = vi.fn(() => true) }) {
    const onPatch = vi.fn();
    render(
        <VariablePickerProvider groups={groups} previewSample={previewSample} stepLabelById={new Map()}>
            <SettingsForm
                step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null}
                onPatch={onPatch} catalog={null} groups={groups} previewSample={previewSample}
                onInsertUpstreamStep={onInsertUpstreamStep}
            />
        </VariablePickerProvider>,
    );
    return { onPatch, onInsertUpstreamStep };
}

const describeIt = (text) => fireEvent.change(
    screen.getByLabelText('Describe the outputs you want'),
    { target: { value: text } },
);
const nameAnswers = (text) => fireEvent.change(
    screen.getByLabelText('Name the possible answers'),
    { target: { value: text } },
);
const save = () => fireEvent.click(screen.getByText('Save'));

/** The state the offer belongs in: asked, and the model found no field. */
async function askAndFail() {
    api.suggestRouteRules.mockResolvedValue({
        rules: [], problem: 'None of these fields says what the message is about.',
    });
    describeIt('is this e-mail about a complaint');
    fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
    await screen.findByLabelText('Name the possible answers');
}

beforeEach(() => {
    cleanup();
    api.suggestRouteRules.mockReset();
    scopedStorage.setCurrentUser('route-handoff-test-user');
    try { localStorage.clear(); } catch { /* ignore */ }
});

describe('Condition editor — the semantic handoff', () => {
    it('is not offered at all when the shell handed down no insert', async () => {
        // A control that cannot save must not be on screen. The rest of the
        // box still works — this is the only part that needs the definition.
        renderForm(IF_STEP, { groups: [DOC_GROUP], previewSample: DOC_ROOT, onInsertUpstreamStep: null });
        api.suggestRouteRules.mockResolvedValue({ rules: [], problem: 'No field says what this is about.' });
        describeIt('is this e-mail about a complaint');
        fireEvent.click(screen.getByRole('button', { name: /Ask the AI/i }));
        expect(await screen.findByText(/No field says what this is about/)).toBeTruthy();
        expect(screen.queryByLabelText('Name the possible answers')).toBeNull();
    });

    it('saves nothing until the plan is accepted', async () => {
        const { onPatch, onInsertUpstreamStep } = renderForm(IF_STEP, { groups: [DOC_GROUP], previewSample: DOC_ROOT });
        await askAndFail();
        nameAnswers('complaint, question, something else');
        await screen.findByRole('button', { name: /Add the step/i });
        // The node still has the single output it opened with.
        expect(screen.getByText('This node has 1 output.')).toBeTruthy();
        expect(onInsertUpstreamStep).not.toHaveBeenCalled();
        expect(onPatch).not.toHaveBeenCalled();
    });

    it('hands the STEP to the shell and writes the RULES through the normal route model', async () => {
        const { onPatch, onInsertUpstreamStep } = renderForm(IF_STEP, { groups: [DOC_GROUP], previewSample: DOC_ROOT });
        await askAndFail();
        nameAnswers('complaint, question, something else');
        fireEvent.click(await screen.findByRole('button', { name: /Add the step/i }));

        const inserted = onInsertUpstreamStep.mock.calls[0][0];
        expect(inserted.type).toBe('ai_step');
        const field = Object.keys(inserted.outputSchema.properties)[0];

        expect(screen.getByText('This node has 3 outputs.')).toBeTruthy();
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        // Straight through writeRoute, exactly like a hand-built router:
        // several rules ⇒ a switch, with the fan-out opt-in one built here gets.
        expect(patch.type).toBe('switch');
        expect(patch.matchMode).toBe('all');
        expect(patch.cases).toEqual([
            { name: 'complaint', expr: `steps.${inserted.id}.output.${field} == "complaint"` },
            { name: 'question', expr: `steps.${inserted.id}.output.${field} == "question"` },
            { name: 'something_else', expr: `steps.${inserted.id}.output.${field} == "something else"` },
        ]);
    });

    it('RE-POINTS A LIST NODE AT THE NEW STEP\'S RESULTS, not just its rules', async () => {
        const { onPatch, onInsertUpstreamStep } = renderForm(LIST_STEP, { groups: [MAIL_GROUP], previewSample: MAIL_ROOT });
        await askAndFail();
        nameAnswers('complaint, something else');
        fireEvent.click(await screen.findByRole('button', { name: /Add the step/i }));

        const inserted = onInsertUpstreamStep.mock.calls[0][0];
        // The step runs once per message of the list this node already read...
        expect(inserted.forEach).toEqual({ overRef: 'steps.m.output.messages', itemVar: 'item' });
        const field = Object.keys(inserted.outputSchema.properties)[0];

        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        // ...and the node now works through what that produced, where each row
        // carries its own answer. Leaving arrayRef on the old list would make
        // every rule below read undefined, forever, silently.
        expect(patch.arrayRef).toBe(`steps.${inserted.id}.output.results`);
        expect(patch.cases).toEqual([
            { name: 'complaint', expr: `item.output.${field} == "complaint"` },
            { name: 'something_else', expr: `item.output.${field} == "something else"` },
        ]);
    });

    it('leaves the rules editable, like any other accepted suggestion', async () => {
        renderForm(IF_STEP, { groups: [DOC_GROUP], previewSample: DOC_ROOT });
        await askAndFail();
        nameAnswers('complaint, something else');
        fireEvent.click(await screen.findByRole('button', { name: /Add the step/i }));
        // Named ports in ordinary rows — not a frozen blob the author now has
        // to live with.
        expect(screen.getByDisplayValue('complaint')).toBeTruthy();
        expect(screen.getByDisplayValue('something_else')).toBeTruthy();
    });

    it('writes nothing when the shell refuses the insert', async () => {
        const { onPatch } = renderForm(IF_STEP, {
            groups: [DOC_GROUP], previewSample: DOC_ROOT, onInsertUpstreamStep: vi.fn(() => false),
        });
        await askAndFail();
        nameAnswers('complaint, something else');
        fireEvent.click(await screen.findByRole('button', { name: /Add the step/i }));
        // Rules naming a step that was never added would be the empty branch
        // this feature exists to remove, arriving through its own front door.
        expect(screen.getByText('This node has 1 output.')).toBeTruthy();
        expect(onPatch).not.toHaveBeenCalled();
    });
});

/**
 * The chain from the shell down to the box.
 *
 * Everything above is driven from a SettingsForm that was handed the callback
 * directly, so it cannot see a link missing further up — and a missing link
 * here fails in the quietest way this feature has: the offer simply is not
 * rendered, which is also exactly what it does on a surface that legitimately
 * cannot insert a step. Nothing goes red, nothing looks wrong, and the
 * feature is gone. BuildTab and NodeDetailView have no render harness between
 * them (BuildTab needs the whole builder around it — see
 * BuildTab.planPanel.test.js), so the chain is pinned in the source.
 */
const BUILDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(BUILDER, rel), 'utf8');

describe('the chain that reaches this box', () => {
    it('BuildTab owns the graph edit and hands it to the node editor', () => {
        const src = read('BuildTab.jsx');
        expect(src).toMatch(/const onInsertStepBefore = useCallback\(\(targetId, newStep\) => \{/);
        expect(src).toMatch(/insertStepBefore\(flatDef, targetId, newStep\)/);
        expect(src).toMatch(/onInsertStepBefore=\{onInsertStepBefore\}/);
    });

    it('NodeDetailView narrows it to this step, and to the nodes it applies to', () => {
        const src = read('NodeDetailView.jsx');
        // Same shape as onRenameField: bound to this step's id, null when the
        // shell handed nothing down or the node is not one that asks for it.
        expect(src).toMatch(/typeof onInsertStepBefore === 'function' && !isTrigger && isRouteStep\(step\)/);
        expect(src).toMatch(/\(newStep\) => onInsertStepBefore\(step\.id, newStep\)/);
        expect(src).toMatch(/onInsertUpstreamStep=\{onInsertUpstreamStep\}/);
    });

    it('SettingsForm forwards it to the Condition editor', () => {
        expect(read('flow/SettingsForm.jsx')).toMatch(/onInsertUpstreamStep=\{onInsertUpstreamStep\}/);
    });
});
