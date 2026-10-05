import { screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// NDV fetches the tool catalog on mount — stub the API.
const { api } = vi.hoisted(() => ({
    api: { getCatalog: vi.fn().mockResolvedValue({ apps: [], triggerOutputs: {} }) },
}));
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => api }));

// A switchable dictionary over the REAL useTranslation, off by default so every
// other test in this file keeps reading the shipped English. Switched on below
// to prove the drawer's chrome goes through t() at all: with the EN defaults
// live (src/test/setup.js loads them) a hardcoded label and a translated one
// render identically, which is how ~30 attributes stayed English unnoticed.
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../../hooks/useTranslation', async (importOriginal) =>
    (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

import {
    AI_STEP as step, AI_DEFINITION as definition, aiStepProps as baseProps, renderInQueryClient as render,
} from './ndv/ndvTestProps';
import NodeDetailView from './NodeDetailView';

describe('NodeDetailView', () => {
    beforeEach(() => { cleanup(); try { localStorage.clear(); } catch { /* ignore */ } });

    it('renders the three columns and the humanized type + name', () => {
        render(<NodeDetailView {...baseProps()} />);
        expect(screen.getByTestId('ndv-col-input')).toBeTruthy();
        expect(screen.getByTestId('ndv-col-params')).toBeTruthy();
        expect(screen.getByTestId('ndv-col-output')).toBeTruthy();
        expect(screen.getByText('AI step')).toBeTruthy();
        // Parameters column shows the SettingsForm (Label field).
        expect(screen.getByDisplayValue('My AI')).toBeTruthy();
    });

    it('Execute calls onExecuteStep with the step id', () => {
        const onExecuteStep = vi.fn();
        render(<NodeDetailView {...baseProps({ onExecuteStep })} />);
        fireEvent.click(screen.getAllByRole('button', { name: /Test step/ })[0]);
        expect(onExecuteStep).toHaveBeenCalledWith('s1');
    });

    it('close calls onClose', () => {
        const onClose = vi.fn();
        render(<NodeDetailView {...baseProps({ onClose })} />);
        fireEvent.click(screen.getByLabelText('Close'));
        expect(onClose).toHaveBeenCalled();
    });

    it('can hide the Input and Output columns', () => {
        render(<NodeDetailView {...baseProps()} />);
        fireEvent.click(screen.getByLabelText('Hide input'));
        expect(screen.queryByTestId('ndv-col-input')).toBeNull();
        fireEvent.click(screen.getByLabelText('Hide output'));
        expect(screen.queryByText('Output')).toBeNull();
        // Parameters always stays.
        expect(screen.getByTestId('ndv-col-params')).toBeTruthy();
    });

    /**
     * A single click on a node opens the QUICK editor: the settings the step
     * needs and nothing else. Everything it leaves out has to stay one click
     * away, or the simplification just hides features.
     */
    describe('quick density', () => {
        const quickProps = (overrides = {}) => baseProps({ density: 'quick', onDensityChange: vi.fn(), ...overrides });

        it('drops the Input column and the step plumbing', () => {
            render(<NodeDetailView {...quickProps()} />);
            expect(screen.queryByTestId('ndv-col-input')).toBeNull();
            expect(screen.queryByTestId('ndv-col-params')).toBeNull();
            expect(screen.queryByText('Disable')).toBeNull();
            expect(screen.queryByText('Duplicate')).toBeNull();
            // The settings themselves are still right there.
            expect(screen.getByDisplayValue('My AI')).toBeTruthy();
        });

        it('keeps the run result under the settings, so Execute shows something', () => {
            // Pressing Execute here used to produce nothing on screen at all —
            // the result landed in a column this dialog does not render.
            render(<NodeDetailView {...quickProps()} />);
            const panel = screen.getByTestId('ndv-quick-output');
            expect(within(panel).getByText('Output')).toBeTruthy();
            expect(within(panel).getByRole('button', { name: /pin/i })).toBeTruthy();
        });

        /**
         * BFSF-386 — the Output table had no scrollbars in this dialog.
         *
         * The full view hands the output subtree a DEFINITE height; the compact
         * one hands it a `max-height` + `overflow-hidden` cap. Under a cap every
         * box down to the scroller has to take part in a flex layout: one plain
         * BLOCK in the chain leaves the percentage heights below it resolving to
         * `auto`, the table grows to its own content inside the clip, and the
         * scroller ends up exactly as tall as what it was meant to scroll.
         *
         * jsdom does no layout, so this pins the structure that broke — the real
         * proof is a browser. `flex-1` is deliberately NOT accepted: that is a
         * flex-ITEM property and the wrapper had it all along.
         */
        it('keeps a flex chain between the height cap and the output scroller', () => {
            const runStep = {
                status: 'success',
                durationMs: 90,
                output: { results: [{ id: 'a', subject: 'One' }, { id: 'b', subject: 'Two' }] },
            };
            render(<NodeDetailView {...quickProps()} runStep={runStep} />);
            const panel = screen.getByTestId('ndv-quick-output');
            const scroller = panel.querySelector('.overflow-auto');
            expect(scroller).toBeTruthy();

            const chain = [];
            for (let el = scroller.parentElement; el && el !== panel; el = el.parentElement) chain.push(el);
            // cap → RunTabContainer → its output wrapper → StepOutputTab → its
            // body → the OutputView card. Nothing in between may be a block.
            expect(chain.length).toBeGreaterThanOrEqual(5);
            for (const el of chain) {
                expect(el.classList.contains('flex')).toBe(true);
            }
        });

        it('says how the run went ONCE, in the header', () => {
            const runStep = { status: 'success', output: { id: 'm1' }, durationMs: 120 };
            render(<NodeDetailView {...quickProps()} runStep={runStep} />);
            const panel = screen.getByTestId('ndv-quick-output');
            // One "Success", not one in the header and another in a strip below.
            expect(within(panel).getAllByText(/Success/)).toHaveLength(1);
            // …and no standing hint footer eating the little height there is.
            expect(within(panel).queryByText(/Switch to JSON/)).toBeNull();
        });

        it('pins the latest output, and refuses when there is nothing to pin', () => {
            const onSaveStep = vi.fn();
            const { rerender } = render(<NodeDetailView {...quickProps()} onSaveStep={onSaveStep} />);
            const pinOf = () => within(screen.getByTestId('ndv-quick-output')).getByRole('button', { name: /pin/i });
            expect(pinOf().disabled).toBe(true);

            rerender(<NodeDetailView {...quickProps()} onSaveStep={onSaveStep} runStep={{ status: 'success', output: { id: 'm1' } }} />);
            expect(pinOf().disabled).toBe(false);
            fireEvent.click(pinOf());
            expect(onSaveStep).toHaveBeenCalled();
        });

        it('hides advanced sections but keeps the primary ones', () => {
            render(<NodeDetailView {...quickProps()} />);
            expect(screen.getByText('Inputs')).toBeTruthy();
            expect(screen.queryByText('Run once per item')).toBeNull();
            expect(screen.queryByText('Structured output')).toBeNull();
        });

        it('offers Execute, a data line, and a counted way into everything else', () => {
            const onExecuteStep = vi.fn();
            const onModeChange = vi.fn();
            render(<NodeDetailView {...quickProps({ onExecuteStep, onModeChange })} />);
            fireEvent.click(screen.getAllByRole('button', { name: /Test step/ })[0]);
            expect(onExecuteStep).toHaveBeenCalledWith('s1');
            // ai_step hides 2 sections in Simple (Advanced + Structured
            // output). The counted control now reveals them IN THIS dialog by
            // switching the MODE — it must not swap the window for the
            // three-column workspace (the old "More options" did, and still
            // left the sections hidden).
            fireEvent.click(screen.getByText(/Show advanced options \(2\)/));
            expect(onModeChange).toHaveBeenCalledWith('advanced');
        });

        it('without a mode owner, the legacy counted button still opens the full view', () => {
            const onDensityChange = vi.fn();
            render(<NodeDetailView {...quickProps({ onDensityChange })} />);
            fireEvent.click(screen.getByText(/More options \(2\)/));
            expect(onDensityChange).toHaveBeenCalledWith('full');
        });

        it('says what the step produced — or that it has not run', () => {
            cleanup();
            render(<NodeDetailView {...quickProps()} />);
            expect(screen.getByText('not run yet')).toBeTruthy();
            cleanup();
            render(<NodeDetailView {...quickProps({ runStep: { status: 'success', output: { results: [{ id: 1 }, { id: 2 }] } } })} />);
            expect(screen.getByText('2 records')).toBeTruthy();
        });

        it('the expand control switches to the full view', () => {
            const onDensityChange = vi.fn();
            render(<NodeDetailView {...quickProps({ onDensityChange })} />);
            fireEvent.click(screen.getByLabelText('Expand to the full view'));
            expect(onDensityChange).toHaveBeenCalledWith('full');
        });

        it('a validation error in an advanced section is never hidden', () => {
            // Reachability beats tidiness: the error banner must point at a
            // control the user can actually see.
            render(<NodeDetailView {...quickProps({
                validation: { errors: [{ code: 'ai_step.model_tier', path: 'steps[s1].modelTier', message: 'bad tier' }], warnings: [] },
            })} />);
            expect(screen.getByText('Run once per item')).toBeTruthy();
        });
    });

    /**
     * BFSF-408 — "let the author supply the output".
     *
     * The screenshot on the ticket is this panel saying "No data yet — press
     * ▶ Execute to run this step and capture it" with no Execute button on it,
     * next to a Pin button that can never enable. Pinning needs `runStep.output`
     * and a run costs time (and, on a paid API, money) — so the steps after a
     * node could not be built until that node had really run. This is the way
     * out: one pencil, on every node type, always available.
     */
    describe('hand-written output', () => {
        const editorOf = () => screen.getByTestId('ndv-edit-output');
        const textarea = () => screen.getByLabelText('Output JSON');
        // What the NDV saves is the whole next DEFINITION, not the patch — so
        // assertions read the step back out of it.
        const savedStep = (onSaveStep) => onSaveStep.mock.calls.at(-1)[0].steps[0];

        it('is available with no run and no pin — which Pin never is', () => {
            // The regression this feature exists to fix, in one assertion: the
            // two controls sit side by side and only one of them is reachable
            // on a step that has never executed.
            render(<NodeDetailView {...baseProps({ density: 'quick', onDensityChange: vi.fn() })} />);
            const panel = screen.getByTestId('ndv-quick-output');
            expect(within(panel).getByRole('button', { name: /pin/i }).disabled).toBe(true);
            expect(editorOf().disabled).toBe(false);
        });

        it('saves valid JSON as an EDITED pin, not a captured one', async () => {
            const onSaveStep = vi.fn().mockResolvedValue(undefined);
            render(<NodeDetailView {...baseProps({ onSaveStep })} />);

            fireEvent.click(editorOf());
            fireEvent.change(textarea(), { target: { value: '{"subject":"Hi","id":7}' } });
            fireEvent.click(screen.getByText('Save output'));

            await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
            const saved = savedStep(onSaveStep);
            expect(saved.pinnedOutput).toEqual({ subject: 'Hi', id: 7 });
            expect(saved.pinnedSource).toBe('edited');
            expect(typeof saved.pinnedAt).toBe('string');
        });

        it('refuses invalid JSON in place, and saves nothing at all', async () => {
            // "Nothing at all" is the point: a definition save bumps `version`
            // and writes a full snapshot into automation_versions, so a
            // half-typed brace must never reach the server.
            const onSaveStep = vi.fn().mockResolvedValue(undefined);
            render(<NodeDetailView {...baseProps({ onSaveStep })} />);

            fireEvent.click(editorOf());
            fireEvent.change(textarea(), { target: { value: '{ "subject": ' } });
            fireEvent.click(screen.getByText('Save output'));

            expect(screen.getByRole('alert').textContent).toMatch(/^Invalid JSON: /);
            expect(onSaveStep).not.toHaveBeenCalled();
            // Still open, still holding what was typed — an error that clears
            // your work is worse than no error.
            expect(textarea().value).toBe('{ "subject": ');
        });

        it('refuses an oversized payload client-side, before the PUT', () => {
            // The inspector PUTs the WHOLE definition on every save. One
            // oversized pin would 400 every later, unrelated edit to this
            // automation, and failedPatchRef would retry into the same 400 — so
            // the cap is what keeps the automation editable, not a nicety.
            const onSaveStep = vi.fn().mockResolvedValue(undefined);
            render(<NodeDetailView {...baseProps({ onSaveStep })} />);

            fireEvent.click(editorOf());
            fireEvent.change(textarea(), { target: { value: JSON.stringify({ body: 'x'.repeat(70_000) }) } });
            fireEvent.click(screen.getByText('Save output'));

            expect(screen.getByRole('alert').textContent).toMatch(/Too big to save/);
            expect(onSaveStep).not.toHaveBeenCalled();
        });

        it('refuses the server\'s truncation sentinel, exactly as Pin does', () => {
            const onSaveStep = vi.fn().mockResolvedValue(undefined);
            render(<NodeDetailView {...baseProps({ onSaveStep })} />);

            fireEvent.click(editorOf());
            fireEvent.change(textarea(), { target: { value: '{"__truncated__":true}' } });
            fireEvent.click(screen.getByText('Save output'));

            expect(screen.getByRole('alert').textContent).toMatch(/placeholder, not data/);
            expect(onSaveStep).not.toHaveBeenCalled();
        });

        it('badges a hand-written value "Edited", never "Pinned"', () => {
            // A fabricated value must not read like a real capture.
            const edited = { ...step, pinnedOutput: { id: 'x' }, pinnedAt: 'now', pinnedSource: 'edited' };
            const def = { ...definition, steps: [edited] };
            render(<NodeDetailView {...baseProps({ step: edited, definition: def, rootDefinition: def, density: 'quick', onDensityChange: vi.fn() })} />);

            const panel = screen.getByTestId('ndv-quick-output');
            expect(within(panel).getAllByText(/Edited/).length).toBeGreaterThan(0);
            expect(within(panel).queryByText(/Pinned/)).toBeNull();
        });

        it('seeds from the last run, then from the pin, then from the describer', () => {
            const pinned = { ...step, pinnedOutput: { from: 'pin' } };
            const def = { ...definition, steps: [pinned] };
            const p = baseProps({ step: pinned, definition: def, rootDefinition: def });

            render(<NodeDetailView {...p} />);
            fireEvent.click(editorOf());
            expect(JSON.parse(textarea().value)).toEqual({ from: 'pin' });

            // A real run outranks the pin: it is the newer truth about this
            // step, and the author can still edit whatever lands in the box.
            cleanup();
            render(<NodeDetailView {...p} runStep={{ status: 'success', output: { from: 'run' } }} />);
            fireEvent.click(editorOf());
            expect(JSON.parse(textarea().value)).toEqual({ from: 'run' });

            // Neither: the describer's own sample for this node type, so the
            // author starts from the shape every picker already promises
            // rather than an empty box.
            cleanup();
            render(<NodeDetailView {...baseProps()} />);
            fireEvent.click(editorOf());
            expect(() => JSON.parse(textarea().value)).not.toThrow();
        });
    });

    it('the full view offers a way back to the small dialog', () => {
        // "Shrink to the small dialog", not "Simple view" — the words Simple /
        // All options belong to the MODE toggle; this button only resizes.
        const onDensityChange = vi.fn();
        render(<NodeDetailView {...baseProps({ density: 'full', onDensityChange })} />);
        fireEvent.click(screen.getByLabelText('Shrink to the small dialog'));
        expect(onDensityChange).toHaveBeenCalledWith('quick');
    });

    it('the user\'s mode beats the gesture: Simple stays simple in the full view', () => {
        // A user who chose Simple keeps the simple form even in the big
        // window — mode owns content, density owns window size.
        render(<NodeDetailView {...baseProps({ density: 'full', mode: 'simple', onModeChange: vi.fn() })} />);
        expect(screen.queryByText('Run once per item')).toBeNull();
        expect(screen.getByText('Inputs')).toBeTruthy();
    });

    it('switching to Advanced reveals the hidden settings in place', () => {
        const onModeChange = vi.fn();
        const { rerender } = render(<NodeDetailView {...baseProps({ density: 'quick', mode: 'simple', onModeChange })} />);
        expect(screen.queryByText('Run once per item')).toBeNull();
        rerender(<NodeDetailView {...baseProps({ density: 'quick', mode: 'advanced', onModeChange })} />);
        expect(screen.getByText('Run once per item')).toBeTruthy();
        // The counted link now reads the other way and the count drains.
        expect(screen.getByText('Show fewer options')).toBeTruthy();
    });
});

/**
 * Every visible word in the drawer, and every word a screen reader reads out,
 * has to come from the dictionary. These tests switch the dictionary to
 * nonsense: anything still in English afterwards is hardcoded.
 */
describe('NodeDetailView — nothing on the drawer is hardcoded English', () => {
    beforeEach(() => { cleanup(); transOverride.current = null; try { localStorage.clear(); } catch { /* ignore */ } });

    const dutch = (map) => { transOverride.current = map; };

    it('counts the hidden sections with a KEY per form, not a number glued to a word', () => {
        // `hiddenCount > 0 ? `More options (${n})` : 'More options'` handed the
        // dictionary two half-sentences and built the rest in JavaScript.
        dutch({
            'automations.ndv.more_options': 'Meer opties',
            'automations.ndv.more_options_n': 'Nog {n} opties',
        });
        render(<NodeDetailView {...baseProps({ density: 'quick', onDensityChange: vi.fn() })} />);
        expect(screen.getByText(/Nog 2 opties/)).toBeTruthy();
        expect(screen.queryByText(/More options/)).toBeNull();
    });

    it('falls back to the plain form when nothing is hidden', () => {
        dutch({
            'automations.ndv.more_options': 'Meer opties',
            'automations.ndv.more_options_n': 'Nog {n} opties',
        });
        // mode 'advanced' hides nothing, so hiddenCount is 0.
        render(<NodeDetailView {...baseProps({ density: 'quick', mode: 'advanced', onDensityChange: vi.fn() })} />);
        expect(screen.getByText(/Meer opties/)).toBeTruthy();
        expect(screen.queryByText(/Nog 0 opties/)).toBeNull();
    });

    it('translates the header chrome a screen reader reads out', () => {
        dutch({
            'common.close': 'Sluiten',
            'automations.ndv.test_step': 'Uitvoeren',
            'automations.ndv.test_step_title': 'Alleen deze stap uitvoeren',
            'automations.ndv.drawer_columns': 'Kolommen',
            'automations.ndv.resize_editor': 'Hoogte aanpassen',
            'automations.ndv.resize_column': 'Kolombreedte aanpassen',
        });
        render(<NodeDetailView {...baseProps()} />);
        expect(screen.getByLabelText('Sluiten')).toBeTruthy();
        expect(screen.getAllByRole('button', { name: 'Uitvoeren' }).length).toBeGreaterThan(0);
        expect(screen.getAllByTitle('Alleen deze stap uitvoeren').length).toBeGreaterThan(0);
        expect(screen.getByLabelText('Kolommen')).toBeTruthy();
        expect(screen.getByLabelText('Hoogte aanpassen')).toBeTruthy();
        expect(screen.getAllByLabelText('Kolombreedte aanpassen').length).toBeGreaterThan(0);
    });

    it('names the dialog after the step, interpolating instead of concatenating', () => {
        // `Edit ${headerTitle(...)}` cannot be reordered; a language that says
        // the name first has to be able to.
        dutch({ 'automations.ndv.edit_step': '{name} bewerken' });
        render(<NodeDetailView {...baseProps()} />);
        expect(screen.getByLabelText('My AI bewerken')).toBeTruthy();
    });

    it('translates the previous/next pager, title and label alike', () => {
        const second = { id: 's2', type: 'ai_step', label: 'Second', inputs: {} };
        const def = { ...definition, steps: [step, second], edges: [{ from: 's1', to: 's2' }] };
        dutch({
            'automations.ndv.prev_step': 'Vorige stap',
            'automations.ndv.prev_step_title': 'Vorige stap in de flow (Alt+←)',
            'automations.ndv.next_step': 'Volgende stap',
            'automations.ndv.next_step_title': 'Volgende stap in de flow (Alt+→)',
        });
        render(<NodeDetailView {...baseProps({ definition: def, rootDefinition: def, onNavigate: vi.fn() })} />);
        expect(screen.getByLabelText('Vorige stap')).toBeTruthy();
        expect(screen.getByLabelText('Volgende stap')).toBeTruthy();
        expect(screen.getByTitle('Vorige stap in de flow (Alt+←)')).toBeTruthy();
        expect(screen.getByTitle('Volgende stap in de flow (Alt+→)')).toBeTruthy();
    });

    it('translates the plumbing row — duplicate, delete, retry', async () => {
        dutch({
            'automations.ndv.duplicate': 'Dupliceren',
            'automations.ndv.duplicate_title': 'Deze stap dupliceren',
            'common.delete': 'Verwijderen',
            'automations.ndv.delete_title': 'Deze stap verwijderen',
            'automations.ndv.retry': 'Opnieuw',
            'automations.ndv.retry_title': 'Opnieuw vanaf hier',
        });
        render(<NodeDetailView {...baseProps({
            onDuplicateStep: vi.fn(),
            onDeleteStep: vi.fn(),
            onRetryFromStep: vi.fn(),
            runStep: { status: 'error', error: 'boom' },
        })} />);
        // Duplicate and Delete live in the header's ⋯ menu since round 4.
        await userEvent.click(screen.getByTestId('ndv-more-menu'));
        expect(screen.getByText('Dupliceren')).toBeTruthy();
        expect(screen.getByTitle('Deze stap dupliceren')).toBeTruthy();
        expect(screen.getByText('Verwijderen')).toBeTruthy();
        expect(screen.getByTitle('Deze stap verwijderen')).toBeTruthy();
        expect(screen.getByText('Opnieuw')).toBeTruthy();
        expect(screen.getByTitle('Opnieuw vanaf hier')).toBeTruthy();
    });

    it('translates the density controls both ways', () => {
        dutch({
            'automations.ndv.expand_full': 'Volledig weergeven',
            'automations.ndv.expand_full_title': 'Invoer en uitvoer naast elkaar',
            'automations.ndv.shrink_quick': 'Terug naar het kleine venster',
        });
        render(<NodeDetailView {...baseProps({ density: 'quick', onDensityChange: vi.fn() })} />);
        expect(screen.getByLabelText('Volledig weergeven')).toBeTruthy();
        expect(screen.getByTitle('Invoer en uitvoer naast elkaar')).toBeTruthy();
        cleanup();
        render(<NodeDetailView {...baseProps({ density: 'full', onDensityChange: vi.fn() })} />);
        expect(screen.getByLabelText('Terug naar het kleine venster')).toBeTruthy();
    });

    it('translates the quick dialog\'s Output header and its Edit hint', () => {
        dutch({
            'automations.ndv.output': 'Uitvoer',
            'automations.ndv.edit_output_hint': 'Schrijf de uitvoer van deze stap met de hand',
        });
        render(<NodeDetailView {...baseProps({ density: 'quick', onDensityChange: vi.fn() })} />);
        const panel = screen.getByTestId('ndv-quick-output');
        expect(within(panel).getByText('Uitvoer')).toBeTruthy();
        expect(screen.getByTitle('Schrijf de uitvoer van deze stap met de hand')).toBeTruthy();
    });

    it('translates the hand-written-output sheet, which had no t() of its own', () => {
        // OutputEditorPanel is a component in this file with no useTranslation
        // hook at all — every one of its eight strings was hardcoded.
        dutch({
            'automations.ndv.output_editor_hint': 'Wat de stappen hierna moeten zien.',
            'automations.ndv.output_json': 'Uitvoer-JSON',
            'common.cancel': 'Annuleren',
            'automations.ndv.save_output': 'Uitvoer opslaan',
        });
        render(<NodeDetailView {...baseProps()} />);
        fireEvent.click(screen.getByTestId('ndv-edit-output'));
        expect(screen.getByText('Wat de stappen hierna moeten zien.')).toBeTruthy();
        expect(screen.getByLabelText('Uitvoer-JSON')).toBeTruthy();
        expect(screen.getByText('Annuleren')).toBeTruthy();
        expect(screen.getByText('Uitvoer opslaan')).toBeTruthy();
    });

    it('translates Remove on the sheet once there is something to remove', () => {
        dutch({ 'common.remove': 'Weghalen' });
        const pinned = { ...step, pinnedOutput: { id: 'x' }, pinnedAt: 'now', pinnedSource: 'edited' };
        const def = { ...definition, steps: [pinned] };
        render(<NodeDetailView {...baseProps({ step: pinned, definition: def, rootDefinition: def })} />);
        fireEvent.click(screen.getByTestId('ndv-edit-output'));
        expect(screen.getByText('Weghalen')).toBeTruthy();
    });
});
