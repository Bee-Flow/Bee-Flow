import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SettingsForm from './SettingsForm';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import { extractFormState, buildPatch } from './settings/formState';
import { dateInputPatch } from './datetimeTarget';

/**
 * Date & time over a whole column (BFSF-375).
 *
 * Dragging the "Updated" column into "Input date" produced
 * `steps.x.output.results[*].updated`, which resolves to an ARRAY — and the
 * step handed that array straight to a single date parse, so it always failed
 * with "did not resolve to a parseable date". The author's expectation is the
 * obvious one: keep the table, add a `day` column.
 */

const noIssues = { errors: [], warnings: [] };

const dtStep = (over = {}) => ({
    id: 'dt1', type: 'datetime', op: 'extract', part: 'day', label: 'Date & time', ...over,
});

// FormRow renders its label as a <span> unless given htmlFor, so these are
// found by what they DISPLAY — the same way SettingsForm.set.test.jsx does it.
const worksOn = () => screen.getByDisplayValue(/^(One date|Each row of a list)$/);
const queryWorksOn = () => screen.queryByDisplayValue(/^(One date|Each row of a list)$/);
const dateInput = () => screen.getByPlaceholderText(/^(trigger\.output\.timestamp|item\.updated)$/);

function renderForm(step, { onPatch = vi.fn(), groups = [] } = {}) {
    const utils = render(
        <VariablePickerProvider groups={groups} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm
                step={step} modelTiers={{}} stepIssues={noIssues} saving={false}
                saveError={null} onPatch={onPatch} catalog={null} groups={groups}
            />
        </VariablePickerProvider>,
    );
    return { ...utils, onPatch };
}

describe('datetime — form state round-trip', () => {
    it('a step with no arrayRef is single mode', () => {
        const draft = extractFormState(dtStep({ input: 'trigger.output.when' }));
        expect(draft.arrayRef).toBeNull();
        expect(buildPatch(dtStep(), { ...draft }).arrayRef).toBeUndefined();
    });

    it('an empty arrayRef is list mode, and survives the round trip', () => {
        // '' means "list mode, source not picked yet" — losing that on save
        // would silently drop the author back to single mode mid-edit.
        expect(extractFormState(dtStep({ arrayRef: '' })).arrayRef).toBe('');
        // buildPatch returns only what CHANGED, so switching a single-date step
        // into list mode is what has to carry the empty string.
        const step = dtStep({ input: 'trigger.output.when' });
        const patch = buildPatch(step, { ...extractFormState(step), arrayRef: '' });
        expect(patch.arrayRef).toBe('');
    });

    it('leaving list mode removes both keys', () => {
        const step = dtStep({ arrayRef: 'steps.s.output.results', target: 'day', input: 'item.updated' });
        const patch = buildPatch(step, { ...extractFormState(step), arrayRef: null });
        expect(patch.arrayRef).toBeUndefined();
        expect(patch.target).toBeUndefined();
    });

    it('carries the column name through', () => {
        const step = dtStep({ arrayRef: 'steps.s.output.results', input: 'item.updated' });
        const patch = buildPatch(step, { ...extractFormState(step), target: 'dagnummer' });
        expect(patch.target).toBe('dagnummer');
    });

    it('a column name typed in single mode is not saved — there is no column', () => {
        const step = dtStep({ input: 'trigger.output.when' });
        const patch = buildPatch(step, { ...extractFormState(step), target: 'dagnummer' });
        expect(patch.target).toBeUndefined();
    });

    it('a column saved without list mode opens as list mode, and saves that way', () => {
        // Saved before dateInputPatch existed (or imported / AI-written): the
        // runner reads it as list mode, so the editor must not show one date.
        const step = dtStep({ input: 'steps.s.output.results[*].updated' });
        const draft = extractFormState(step);
        expect(draft.arrayRef).toBe('steps.s.output.results');
        expect(draft.input).toBe('item.updated');
        const patch = buildPatch(step, { ...draft });
        expect(patch.arrayRef).toBe('steps.s.output.results');
        expect(patch.input).toBe('item.updated');
    });
});

describe('datetime — the editor', () => {
    beforeEach(cleanup);

    it('offers the choice between one date and a list', () => {
        renderForm(dtStep({ input: 'trigger.output.when' }));
        const select = worksOn();
        expect(select.value).toBe('single');
        expect([...select.querySelectorAll('option')].map(o => o.value)).toEqual(['single', 'items']);
    });

    it('does not offer it for "today", which reads no input at all', () => {
        renderForm(dtStep({ op: 'now' }));
        expect(queryWorksOn()).toBeNull();
    });

    it('shows the source list and the new column once in list mode', () => {
        renderForm(dtStep({ arrayRef: '', input: 'item.updated' }));
        expect(worksOn().value).toBe('items');
        expect(screen.getByText('Source list')).toBeTruthy();
        expect(screen.getByPlaceholderText('day')).toBeTruthy();
    });

    it('names the new column after the part, so the author sees "day" before running', () => {
        renderForm(dtStep({ arrayRef: '', part: 'day', input: 'item.updated' }));
        expect(screen.getByPlaceholderText('day')).toBeTruthy();
    });

    it('hides the list controls in single mode', () => {
        renderForm(dtStep({ input: 'trigger.output.when' }));
        expect(screen.queryByPlaceholderText('day')).toBeNull();
        expect(screen.queryByText('Source list')).toBeNull();
    });

    it('opens a column saved without list mode as a list', () => {
        renderForm(dtStep({ input: 'steps.s.output.results[*].updated' }));
        expect(worksOn().value).toBe('items');
        expect(screen.getByText('Source list')).toBeTruthy();
    });
});

describe('datetime — dropping a whole column', () => {
    /**
     * The fix for the reported bug. The input control is a contentEditable
     * (RefTokenInput), which fireEvent.change cannot drive, so the decision
     * itself is the unit under test — the editor does nothing but apply it.
     */
    it('switches to list mode and splits the path', () => {
        expect(dateInputPatch('steps.act_def3f38e.output.results[*].updated', { listMode: false })).toEqual({
            arrayRef: 'steps.act_def3f38e.output.results',
            input: 'item.updated',
        });
    });

    it('leaves an ordinary single-date path exactly as typed', () => {
        expect(dateInputPatch('trigger.output.timestamp', { listMode: false })).toEqual({
            input: 'trigger.output.timestamp',
        });
    });

    it('does not re-split once already in list mode', () => {
        // The author is addressing the row scope by hand at that point; a
        // second split would rewrite `arrayRef` out from under them.
        expect(dateInputPatch('item.updated', { listMode: true })).toEqual({ input: 'item.updated' });
        expect(dateInputPatch('steps.x.output.rows[*].at', { listMode: true })).toEqual({
            input: 'steps.x.output.rows[*].at',
        });
    });
});
