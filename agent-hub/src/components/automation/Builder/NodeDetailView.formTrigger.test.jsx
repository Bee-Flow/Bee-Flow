import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ndvProps } from './ndv/ndvTestProps';

const { api } = vi.hoisted(() => ({
    api: {
        getCatalog: vi.fn().mockResolvedValue({ apps: [], triggerOutputs: {} }),
        listFormPages: vi.fn().mockResolvedValue({ forms: [] }),
        createFormPage: vi.fn().mockResolvedValue({ form: { id: 'tok1', url: 'https://app.test/f/tok1', submissions: 0 } }),
        rotateFormPage: vi.fn(),
    },
}));
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => api }));

// A switchable dictionary over the REAL useTranslation, null by default so the
// tests below keep reading the shipped English.
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../../hooks/useTranslation', async (importOriginal) =>
    (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

const NodeDetailView = (await import('./NodeDetailView')).default;

/**
 * Opening a form trigger in the NDV, end to end: the whole composition
 * (upstream variables → INPUT tree → SettingsForm → form editor → live
 * preview) on one screen.
 *
 * This exists because the builder crashed into its error boundary with React's
 * minified #310 ("Rendered more hooks than during the previous render") the
 * moment a form trigger was opened. A hook-order break throws during render, so
 * simply mounting and re-rendering this tree is the regression guard.
 */
const formTrigger = (fields) => ({
    id: 'trg',
    type: 'trigger',
    kind: 'form',
    label: 'Form',
    form: {
        title: 'Get in touch',
        description: '',
        submitLabel: 'Submit',
        successMessage: 'Thanks!',
        fields,
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' },
    },
});

const FIELDS = [
    { name: 'name', type: 'text', label: 'Your name', required: true },
    { name: 'email', type: 'email', label: 'Your email', required: true },
];

function props(trigger, extra = {}) {
    const step = { id: 's1', type: 'notification', label: 'Notify', channel: 'email', to: 'a@b.nl', subject: 'x', body: 'y' };
    const definition = { trigger, steps: [step], edges: [{ from: trigger.id, to: 's1' }] };
    return ndvProps(trigger, definition, { automation: { id: 'a1', definition }, ...extra });
}

describe('NodeDetailView — form trigger', () => {
    beforeEach(() => { cleanup(); try { localStorage.clear(); } catch { /* ignore */ } });

    it('opens without crashing and shows the form editor', async () => {
        await act(async () => { render(<NodeDetailView {...props(formTrigger(FIELDS))} />); });
        // The kicker names the trigger KIND, the same wording the canvas node
        // uses — a bare "Trigger" said nothing about which one you opened.
        expect(screen.getByText('Form trigger')).toBeTruthy();
        expect(screen.getByDisplayValue('Get in touch')).toBeTruthy();
        expect(screen.getByDisplayValue('Your name')).toBeTruthy();
    });

    it('survives a re-render after the declaration appears (the #310 path)', async () => {
        // A freshly-switched trigger has no `form` yet; the next autosave gives
        // it one. Both states must render the same hooks.
        const empty = { id: 'trg', type: 'trigger', kind: 'form', label: 'Form' };
        const { rerender } = render(<NodeDetailView {...props(empty)} />);
        expect(screen.getByText('Create the form')).toBeTruthy();

        await act(async () => {
            rerender(<NodeDetailView {...props(formTrigger(FIELDS))} />);
        });
        expect(screen.getByDisplayValue('Get in touch')).toBeTruthy();
    });

    it('survives adding and removing a question (the field list changes length)', async () => {
        await act(async () => { render(<NodeDetailView {...props(formTrigger(FIELDS))} />); });
        await act(async () => { fireEvent.click(screen.getByText('Add a question')); });
        expect(screen.getByDisplayValue('New question')).toBeTruthy();
        await act(async () => { fireEvent.click(screen.getByLabelText('Remove Your name')); });
        expect(screen.queryByDisplayValue('Your name')).toBeNull();
    });

    it('survives toggling the live preview on and off', async () => {
        // No onExecuteStep here, so onTestSubmit is null (canExecute requires
        // it) and the preview keeps its old collapsed default — the
        // default-OPEN behaviour is specifically about the trigger's
        // SUBMITTABLE editor (onTestSubmit truthy), covered below in
        // `describe('supplying the trigger's data')` where onExecuteStep is
        // wired. This test just guards the toggle itself still works.
        await act(async () => { render(<NodeDetailView {...props(formTrigger(FIELDS))} />); });
        await act(async () => { fireEvent.click(screen.getByText('Preview the form')); });
        expect(screen.getByTestId('form-preview')).toBeTruthy();
        await act(async () => { fireEvent.click(screen.getByText('Hide preview')); });
        expect(screen.queryByTestId('form-preview')).toBeNull();
    });

    it('exposes the declared answers as bindable trigger variables in the INPUT panel', async () => {
        // The downstream step is what maps FROM the form, so open the NDV on it.
        const trigger = formTrigger(FIELDS);
        const base = props(trigger);
        await act(async () => {
            render(<NodeDetailView {...base} step={base.definition.steps[0]} />);
        });
        expect(screen.getByText('Form answers')).toBeTruthy();
        expect(screen.getByText('Name')).toBeTruthy();
        expect(screen.getAllByText('Email').length).toBeGreaterThan(0);
    });


    /**
     * BFSF-408 — a trigger is a node like any other, and it is the ONE whose
     * output the author most needs to supply: it never gets a run row (runDag
     * records none for it), so Pin can never enable there and every step
     * mapping off it stayed undefined until a real submission arrived.
     */
    describe('supplying the trigger\'s data', () => {
        const withActions = (trigger, extra = {}) => props(trigger, {
            onExecuteStep: vi.fn(),
            onDeleteStep: vi.fn(),
            onDuplicateStep: vi.fn(),
            ...extra,
        });

        it('offers Edit and ▶ Execute on the PRIMARY trigger, but never Disable / Duplicate / Delete', async () => {
            // Disable is the one worth naming: the runner's `if (step.disabled)`
            // check lives inside dispatchStep, which the entry trigger never
            // enters — so a "Disabled" chip on it would simply be false.
            await act(async () => { render(<NodeDetailView {...withActions(formTrigger(FIELDS))} />); });
            expect(screen.getByTestId('ndv-edit-output')).toBeTruthy();
            expect(screen.getAllByRole('button', { name: /Test step/ }).length).toBeGreaterThan(0);
            expect(screen.queryByText('Disable')).toBeNull();
            expect(screen.queryByText('Duplicate')).toBeNull();
            expect(screen.queryByText('Delete')).toBeNull();
        });

        it('offers ▶ Execute on a SECONDARY trigger too, but not the plumbing row', async () => {
            // This assertion was inverted (multi-trigger, 2026-09). It used to
            // pin "no Execute on a secondary trigger" because
            // automationRunner/partialRuns.js resolved a step id against
            // `def.trigger` and `def.steps` only, so ▶ here 500'd with "step
            // not found". It now resolves the id against `def.triggers[]` as
            // well (partialRuns.js:424-426) and enters the run through that
            // node, so withholding the button would hide a path that works.
            //
            // What is still withheld is the PLUMBING row: duplicate / delete /
            // disable follow the canvas chrome's split, where a secondary
            // trigger manages itself from the trigger list, not from here.
            const primary = { id: 'trg', type: 'trigger', kind: 'manual', label: 'Manually' };
            const secondary = { id: 'trg2', type: 'trigger', kind: 'webhook', label: 'Also on a webhook' };
            const definition = { trigger: primary, triggers: [secondary], steps: [], edges: [] };
            await act(async () => {
                render(<NodeDetailView {...withActions(primary)} step={secondary} definition={definition} rootDefinition={definition} />);
            });
            expect(screen.getAllByRole('button', { name: /Test step/ }).length).toBeGreaterThan(0);
            expect(screen.getByTestId('ndv-edit-output')).toBeTruthy();
            expect(screen.queryByText('Duplicate')).toBeNull();
            expect(screen.queryByText('Delete')).toBeNull();
        });

        it('"Use empty answers" fills the declared key set without filling the form in', async () => {
            // BFSF-408(b). Same helper the renderer seeds its own state with
            // (PublicFormRenderer.initialValues), so this is literally the shape
            // an untouched submission has — not a third sample generator.
            await act(async () => { render(<NodeDetailView {...withActions(formTrigger(FIELDS))} />); });
            fireEvent.click(screen.getByTestId('ndv-edit-output'));
            fireEvent.click(screen.getByText('Use empty answers'));
            expect(JSON.parse(screen.getByLabelText('Output JSON').value)).toEqual({ name: '', email: '' });
        });

        it('saves the trigger payload back onto the TRIGGER, not into steps[]', async () => {
            const onSaveStep = vi.fn().mockResolvedValue(undefined);
            await act(async () => { render(<NodeDetailView {...withActions(formTrigger(FIELDS), { onSaveStep })} />); });
            fireEvent.click(screen.getByTestId('ndv-edit-output'));
            fireEvent.change(screen.getByLabelText('Output JSON'), { target: { value: '{"name":"Ada"}' } });
            fireEvent.click(screen.getByText('Save output'));

            await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
            // mergeStepPatchIntoDefinition already routes a trigger patch to
            // definition.trigger — no new persistence path, no schema change.
            const saved = onSaveStep.mock.calls[0][0];
            expect(saved.trigger.pinnedOutput).toEqual({ name: 'Ada' });
            expect(saved.trigger.pinnedSource).toBe('edited');
            expect(saved.steps.some(st => st.pinnedOutput)).toBe(false);
        });

        it('shows the live preview OPEN by default, with real visual weight, when it is submittable', async () => {
            // BFSF-408, reopened: "hit play... no preview is shown... we do
            // not see a visual form example" was the tester's literal
            // complaint. The preview used to default closed behind a small
            // text link after Theme settings — undiscoverable. Whenever
            // onTestSubmit is wired (a canExecute'able form trigger, i.e. the
            // primary trigger with a live onExecuteStep), it now shows without
            // any click, and no click is needed to reach it.
            await act(async () => { render(<NodeDetailView {...withActions(formTrigger(FIELDS))} />); });
            expect(screen.getByTestId('form-preview')).toBeTruthy();
            // Still toggleable, not force-shown.
            await act(async () => { fireEvent.click(screen.getByText('Hide preview')); });
            expect(screen.queryByTestId('form-preview')).toBeNull();
        });

        it('the live preview is submittable, and sends the typed answers as the run payload', async () => {
            // BFSF-408(a) — an inline test, with no public-route change.
            // Deliberately NOT "copy the test link": formPublic.js 404s the
            // hosted page unless the automation is active and non-draft, i.e. it
            // fails precisely while you are building, and a real submission
            // there fires every downstream step for real. mode 'only' does not.
            const onExecuteStep = vi.fn().mockResolvedValue({});
            await act(async () => { render(<NodeDetailView {...withActions(formTrigger(FIELDS), { onExecuteStep })} />); });
            // No click needed — the preview is open by default now.

            const preview = within(screen.getByTestId('form-preview'));
            fireEvent.change(preview.getByLabelText(/Your name/), { target: { value: 'Ada' } });
            fireEvent.change(preview.getByLabelText(/Your email/), { target: { value: 'ada@example.com' } });
            await act(async () => { fireEvent.click(preview.getByRole('button', { name: 'Submit' })); });

            expect(onExecuteStep).toHaveBeenCalledWith('trg', {
                mode: 'only',
                // The honeypot is anti-bot plumbing, not an answer — it must
                // not end up in what the next steps map against.
                triggerPayload: { name: 'Ada', email: 'ada@example.com' },
            });
        });

        it('leaves the identical preview inert on a form_page step', async () => {
            // Same component, same editor — but a mid-run page has no trigger
            // to fire, so it gets no submit handler and stays a picture.
            const page = {
                id: 'p1', type: 'form_page', label: 'Page two',
                form: { title: 'More', description: '', submitLabel: 'Next', successMessage: 'Ok', fields: FIELDS },
            };
            const trigger = formTrigger(FIELDS);
            const definition = { trigger, steps: [page], edges: [{ from: trigger.id, to: 'p1' }] };
            await act(async () => {
                render(<NodeDetailView {...withActions(trigger)} step={page} definition={definition} rootDefinition={definition} />);
            });
            await act(async () => { fireEvent.click(screen.getByText('Preview the form')); });
            const preview = within(screen.getByTestId('form-preview'));
            expect(preview.getByRole('button', { name: 'Next' }).disabled).toBe(true);
        });
    });

    it('a form with NO fields still opens (an empty declaration is draft-legal)', async () => {
        await act(async () => { render(<NodeDetailView {...props(formTrigger([]))} />); });
        expect(screen.getByText(/No questions yet/)).toBeTruthy();
    });
});

describe('NodeDetailView — the empty-answers shortcut speaks the dictionary', () => {
    beforeEach(() => { cleanup(); transOverride.current = null; try { localStorage.clear(); } catch { /* ignore */ } });

    it('takes its label and its tooltip from t(), not from the JSX', () => {
        // This button only exists on a form trigger, so the general drawer
        // tests never reach it — and it sits on OutputEditorPanel, which had
        // no useTranslation hook at all.
        transOverride.current = {
            'automations.ndv.use_empty_answers': 'Lege antwoorden gebruiken',
            'automations.ndv.empty_answers_title': 'Elke vraag met een leeg antwoord invullen',
        };
        render(<NodeDetailView {...props(formTrigger(FIELDS))} />);
        fireEvent.click(screen.getByTestId('ndv-edit-output'));
        expect(screen.getByText('Lege antwoorden gebruiken')).toBeTruthy();
        expect(screen.getByTitle('Elke vraag met een leeg antwoord invullen')).toBeTruthy();
    });
});
