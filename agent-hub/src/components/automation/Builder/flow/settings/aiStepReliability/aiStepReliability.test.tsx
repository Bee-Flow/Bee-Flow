import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { typeInEditor } from '../../../../../../test/refEditor';
import { VariablePickerProvider } from '../../../mapping/VariablePickerContext';
import { buildPatch, extractFormState } from '../formState';
import { AiStepAdvancedRows, ConcurrencyField } from './AiStepReliabilitySections';
import { AnswerChecksSection } from './AnswerChecksSection';

type Draft = Record<string, any>;

const SCHEMA = {
    type: 'object',
    properties: {
        category: { type: 'string' },
        summary: { type: 'string' },
        score: { type: 'number' },
        tags: { type: 'array' },
        rows: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
    },
};
const ROWS = [{ id: 'a1', name: 'Alpha' }, { id: 'b2', name: 'Beta' }];
const GROUPS = [{
    id: 's1', label: 'Lookup', kind: 'integration_action', basePath: 'steps.s1.output',
    sample: { rows: ROWS },
    fields: [{ key: 'rows', path: 'steps.s1.output.rows', sample: ROWS }],
}];
const SAMPLE = { steps: { s1: { output: { rows: ROWS } } } };

const stepOf = (over: Draft = {}): Draft => ({ id: 's2', type: 'ai_step', prompt: 'Sort', modelTier: 'auto', outputSchema: SCHEMA, ...over });

/** What SettingsForm does: a draft, a `set` that merges into it, and the latest draft for the assertions. */
function setup(initial: Draft, parts: ('checks' | 'advanced' | 'concurrency')[] = ['checks'], extra: Draft = {}) {
    const latest: { draft: Draft } = { draft: initial };
    function Host() {
        const [draft, setDraft] = useState<Draft>(initial);
        latest.draft = draft;
        const set = (key: string, value: unknown) => setDraft(d => ({ ...d, [key]: value }));
        return (
            <VariablePickerProvider groups={GROUPS as never} previewSample={SAMPLE} stepLabelById={new Map()} stepTypeById={new Map()}>
                {parts.includes('checks') && <AnswerChecksSection draft={draft} set={set} errorSections={new Set(['checks'])} {...extra} />}
                {parts.includes('advanced') && <AiStepAdvancedRows draft={draft} set={set} />}
                {parts.includes('concurrency') && <ConcurrencyField draft={draft} set={set} />}
            </VariablePickerProvider>
        );
    }
    render(<Host />);
    return { latest, user: userEvent.setup(), patch: () => buildPatch(stepOf(), latest.draft) };
}
const fresh = (over: Draft = {}) => extractFormState(stepOf(over));
const addMenu = async (user: ReturnType<typeof userEvent.setup>, kind: RegExp) => {
    await user.click(screen.getByRole('button', { name: /Add a check/ }));
    await user.click(screen.getByRole('menuitem', { name: kind }));
};
const card = (title: RegExp) => screen.getByRole('button', { name: new RegExp(`Remove this check: .*${title.source}`) }).closest('[data-testid="answer-check-card"]') as HTMLElement;

afterEach(() => cleanup());

describe('Answer checks — adding each kind', () => {
    it('offers the four kinds', async () => {
        const { user } = setup(fresh());
        await user.click(screen.getByRole('button', { name: /Add a check/ }));
        const items = screen.getAllByRole('menuitem').map(i => i.textContent);
        expect(items).toEqual([
            'Must be one of the values in a list', 'Numbers must come from the data', 'Written in one alphabet', 'Number of items',
        ]);
    });

    it('a list of allowed values is shown to the AI by default and stored in enumFrom', async () => {
        const { user, latest, patch } = setup(fresh());
        await addMenu(user, /one of the values/);
        // Two text fields, so nothing is guessed; the author picks.
        const c = card(/one of the values/);
        await user.selectOptions(within(c).getByRole('combobox', { name: /Field of the answer/ }), 'category');
        await user.click(within(c).getByTitle('steps.s1.output.rows'));
        await user.selectOptions(within(c).getByRole('combobox', { name: /Part of each item/ }), 'name');
        expect(latest.draft.enumFrom).toEqual([{ field: 'category', ref: 'steps.s1.output.rows', value: 'name' }]);
        expect(latest.draft.checks).toEqual([]);
        expect(patch().enumFrom).toEqual([{ field: 'category', ref: 'steps.s1.output.rows', value: 'name' }]);
    });

    it('only text fields are offered for a list of allowed values', async () => {
        const { user } = setup(fresh());
        await addMenu(user, /one of the values/);
        const options = within(screen.getByRole('combobox', { name: /Field of the answer/ })).getAllByRole('option').map(o => o.textContent);
        expect(options).toEqual(['Pick a field of the answer', 'category', 'summary', 'tags (each item)', 'rows: name (each item)']);
    });

    it('the toggle moves the entry between enumFrom and checks, and back', async () => {
        const { user, latest } = setup(fresh({ enumFrom: [{ field: 'category', ref: 'steps.s1.output.rows', value: 'name', ignoreCase: false }] }));
        const tick = () => screen.getByRole('checkbox', { name: /Show the list to the AI/ });
        expect(tick()).toBeChecked();
        await user.click(tick());
        expect(latest.draft.enumFrom).toEqual([]);
        expect(latest.draft.checks).toEqual([{ kind: 'allowedFrom', field: 'category', ref: 'steps.s1.output.rows', value: 'name', ignoreCase: false }]);
        expect(tick()).not.toBeChecked();
        await user.click(tick());
        expect(latest.draft.checks).toEqual([]);
        expect(latest.draft.enumFrom).toEqual([{ field: 'category', ref: 'steps.s1.output.rows', value: 'name', ignoreCase: false }]);
    });

    it('ignoring case is on by default and "may be left empty" is off', async () => {
        const { user, latest } = setup(fresh({ enumFrom: [{ field: 'category', ref: 'r' }] }));
        expect(screen.getByRole('checkbox', { name: /Ignore upper and lower case/ })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: /May be left empty/ })).not.toBeChecked();
        await user.click(screen.getByRole('checkbox', { name: /Ignore upper and lower case/ }));
        await user.click(screen.getByRole('checkbox', { name: /May be left empty/ }));
        expect(latest.draft.enumFrom[0]).toMatchObject({ ignoreCase: false, allowEmpty: true });
    });

});

describe('Answer checks — the other kinds', () => {
    it('numbers must come from the data', async () => {
        const { user, latest, patch } = setup(fresh());
        await addMenu(user, /Numbers must come/);
        const c = card(/Numbers must come/);
        await user.selectOptions(within(c).getByRole('combobox', { name: /Field of the answer/ }), 'summary');
        typeInEditor(within(c).getByRole('textbox', { name: 'No data picked yet' }), 'steps.s1.output.rows');
        await user.type(within(c).getByRole('spinbutton', { name: /Allowed difference/ }), '0.5');
        await user.type(within(c).getByRole('spinbutton', { name: /Ignore small whole numbers up to/ }), '10');
        await user.click(within(c).getByRole('checkbox', { name: /Check percentages too/ }));
        await user.click(within(c).getByRole('checkbox', { name: /Ignore dates and years/ }));
        expect(latest.draft.checks).toEqual([{
            kind: 'numbersFrom', field: 'summary', ref: 'steps.s1.output.rows', tolerance: 0.5, ignoreUpTo: 10, percent: false, ignoreDates: false,
        }]);
        expect(patch().checks).toEqual(latest.draft.checks);
    });

    it('written in one alphabet', async () => {
        const { user, latest } = setup(fresh());
        await addMenu(user, /Written in one alphabet/);
        const c = card(/Written in one alphabet/);
        await user.selectOptions(within(c).getByRole('combobox', { name: /Field of the answer/ }), 'summary');
        const names = within(within(c).getByRole('combobox', { name: /Alphabet/ })).getAllByRole('option').map(o => o.textContent);
        expect(names).toEqual(['Latin', 'Cyrillic', 'Greek', 'Arabic', 'Hebrew', 'Chinese characters', 'Japanese', 'Korean', 'Devanagari', 'Thai']);
        await user.selectOptions(within(c).getByRole('combobox', { name: /Alphabet/ }), 'greek');
        expect(latest.draft.checks).toEqual([{ kind: 'script', field: 'summary', script: 'greek' }]);
    });

    it('number of items offers only lists, with a minimum of one to start from', async () => {
        const { user, latest } = setup(fresh());
        await addMenu(user, /Number of items/);
        const c = card(/Number of items/);
        const options = within(within(c).getByRole('combobox', { name: /List in the answer/ })).getAllByRole('option').map(o => o.textContent);
        expect(options).toEqual(['Pick a field of the answer', 'tags', 'rows']);
        await user.selectOptions(within(c).getByRole('combobox', { name: /List in the answer/ }), 'rows');
        await user.type(within(c).getByRole('spinbutton', { name: /At most/ }), '5');
        typeInEditor(within(c).getByRole('textbox', { name: 'Not compared with a list' }), 'steps.s1.output.rows');
        expect(latest.draft.checks).toEqual([{ kind: 'items', field: 'rows', minItems: 1, maxItems: 5, sameCountAs: 'steps.s1.output.rows' }]);
    });

    it('preselects the field when only one fits', async () => {
        const { user, latest } = setup(extractFormState(stepOf({ outputSchema: { type: 'object', properties: { label: { type: 'string' } } } })));
        await addMenu(user, /Written in one alphabet/);
        expect(latest.draft.checks[0].field).toBe('label');
    });

    it('removing a card removes the entry', async () => {
        const { user, latest } = setup(fresh({ checks: [{ kind: 'script', field: 'summary', script: 'latin' }] }));
        await user.click(screen.getByRole('button', { name: /Remove this check/ }));
        expect(latest.draft.checks).toEqual([]);
    });

    it('points at Structured output instead of the menu when the step has no fields', () => {
        setup(extractFormState(stepOf({ outputSchema: undefined })));
        expect(screen.getByText(/Add fields under Structured output first/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Add a check/ })).toBeNull();
    });

    it('rings a card red with the validator\'s reason', () => {
        setup(fresh({ checks: [{ kind: 'items', field: 'rows', minItems: 1 }, { kind: 'script', field: 'summary', script: 'latin' }] }), ['checks'], {
            stepIssues: { errors: [{ path: 'steps[s2].checks[1].field', message: 'Step s2: checks[1].field is required.' }] },
        });
        const ringed = document.querySelectorAll('[data-problem="true"]');
        expect(ringed).toHaveLength(1);
        expect(within(ringed[0] as HTMLElement).getByText(/Written in one alphabet/)).toBeInTheDocument();
        expect(within(ringed[0] as HTMLElement).getByText('checks[1].field is required.')).toBeInTheDocument();
    });
});

describe('Fallback', () => {
    it('is not offered until something is checked', () => {
        setup(fresh());
        expect(screen.queryByText(/still fails after one automatic retry/)).toBeNull();
    });

    it('stops with an error by default, and nothing is written for that', () => {
        const { patch } = setup(fresh({ checks: [{ kind: 'script', field: 'summary', script: 'latin' }] }));
        expect(screen.getByRole('radio', { name: /Stop the run with an error/ })).toBeChecked();
        expect(patch()).not.toHaveProperty('fallback');
    });

    it('takes a value per output field: literal, number or template', async () => {
        const { user, latest, patch } = setup(fresh({ checks: [{ kind: 'script', field: 'summary', script: 'latin' }] }));
        await user.click(screen.getByRole('radio', { name: /Use these values instead/ }));
        typeInEditor(screen.getByRole('textbox', { name: 'Fallback value for category' }), 'Other');
        typeInEditor(screen.getByRole('textbox', { name: 'Fallback value for score' }), '0');
        typeInEditor(screen.getByRole('textbox', { name: 'Fallback value for summary' }), 'No summary for {{trigger.output.id}}');
        expect(latest.draft.fallback).toEqual({ kind: 'value', fields: {
            category: { kind: 'literal', value: 'Other' },
            score: { kind: 'literal', value: 0 },
            summary: { kind: 'template', value: 'No summary for {{trigger.output.id}}' },
        } });
        expect(patch().fallback).toEqual(latest.draft.fallback);
        await user.click(screen.getByRole('radio', { name: /Stop the run with an error/ }));
        expect(latest.draft.fallback).toEqual({ kind: 'fail' });
        expect(patch()).not.toHaveProperty('fallback');
    });

    it('says to add fields first when there is nothing to fill', async () => {
        const { user } = setup(extractFormState(stepOf({ outputSchema: undefined, checks: [{ kind: 'items', field: 'rows', minItems: 1 }] })));
        await user.click(screen.getByRole('radio', { name: /Use these values instead/ }));
        expect(screen.getByText(/the values you give here fill those fields/)).toBeInTheDocument();
    });
});

describe('Temperature', () => {
    const select = () => screen.getByRole('combobox', { name: 'How varied the answers are' });

    it('shows Balanced for an untouched step and writes nothing for it', () => {
        const { patch } = setup(fresh(), ['advanced']);
        expect(select()).toHaveValue('balanced');
        expect(patch()).not.toHaveProperty('temperature');
    });

    it('Exact is 0, Creative is 0.7, and Balanced clears it again', async () => {
        const { user, latest } = setup(fresh(), ['advanced']);
        await user.selectOptions(select(), 'exact');
        expect(latest.draft.temperature).toBe(0);
        await user.selectOptions(select(), 'creative');
        expect(latest.draft.temperature).toBe(0.7);
        await user.selectOptions(select(), 'balanced');
        expect(latest.draft.temperature).toBeNull();
    });

    it('Custom takes a number, and stays Custom while typing a preset value', async () => {
        const { user, latest } = setup(fresh(), ['advanced']);
        await user.selectOptions(select(), 'custom');
        const box = screen.getByLabelText('Temperature, from 0 to 2');
        await user.type(box, '0');
        expect(latest.draft.temperature).toBe(0);
        expect(select()).toHaveValue('custom');
        await user.clear(box);
        expect(latest.draft.temperature).toBeNull();
        await user.type(box, '1.3');
        expect(latest.draft.temperature).toBe(1.3);
    });

    it('reads a stored custom value as Custom', () => {
        setup(fresh({ temperature: 1.4 }), ['advanced']);
        expect(select()).toHaveValue('custom');
        expect(screen.getByLabelText('Temperature, from 0 to 2')).toHaveValue(1.4);
    });
});

describe('Reuse the answer', () => {
    const tick = () => screen.getByRole('checkbox', { name: /Reuse the answer when the input is the same/ });

    it('is a tick that writes askOnce, with "for later runs" explained by the organisation setting', async () => {
        const { user, latest, patch } = setup(fresh(), ['advanced']);
        await user.click(tick());
        expect(latest.draft.askOnce).toBe(true);
        expect(patch().askOnce).toBe(true);
        await user.click(screen.getByRole('checkbox', { name: /keep the answer for later runs/ }));
        expect(latest.draft.askOnce).toEqual({ acrossRuns: true });
        expect(screen.getByText(/organisation setting "Answers from AI steps"/)).toBeInTheDocument();
        await user.click(tick());
        expect(latest.draft.askOnce).toBeUndefined();
    });

    it('is disabled with a reason while the step can use tools', () => {
        setup(fresh({ allowTools: true, tools: ['gmail_search'] }), ['advanced']);
        expect(tick()).toBeDisabled();
        expect(screen.getByText(/not reused while the step can use tools/)).toBeInTheDocument();
    });

    it('can still be switched off on a step that has both', async () => {
        const { user, latest } = setup(fresh({ allowTools: true, tools: ['gmail_search'], askOnce: true }), ['advanced']);
        expect(tick()).toBeEnabled();
        await user.click(tick());
        expect(latest.draft.askOnce).toBeUndefined();
    });
});

describe('Items at the same time', () => {
    const forEach = { overRef: 'steps.s1.output.rows', itemVar: 'item', maxIterations: 100 };
    const box = () => screen.getByRole('spinbutton', { name: 'Items at the same time' });

    it('is not shown unless the step runs once per item', () => {
        setup(fresh(), ['concurrency']);
        expect(screen.queryByRole('spinbutton')).toBeNull();
    });

    it('writes the number into forEach, and empties back to the default', async () => {
        const { user, latest, patch } = setup(fresh({ forEach }), ['concurrency']);
        expect(box()).toHaveValue(null);
        await user.type(box(), '8');
        expect(latest.draft.forEach).toEqual({ ...forEach, concurrency: 8 });
        expect(patch().forEach).toEqual({ ...forEach, concurrency: 8 });
        await user.clear(box());
        expect(latest.draft.forEach).toEqual(forEach);
    });

    it('is disabled with a reason when the step can use tools, and says the order is kept', () => {
        setup(fresh({ forEach, tools: ['gmail_search'], concurrency: undefined }), ['concurrency']);
        expect(box()).toBeDisabled();
        expect(screen.getByText(/items then run one after another/)).toBeInTheDocument();
    });

    it('stays available for an extraction step, which has no tools', () => {
        setup({ type: 'data_extraction', forEach: { ...forEach, concurrency: 3 }, fields: [] }, ['concurrency']);
        expect(box()).toBeEnabled();
        expect(box()).toHaveValue(3);
    });
});
