import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// NDV fetches the tool catalog on mount — stub the API.
const { api } = vi.hoisted(() => ({
    api: { getCatalog: vi.fn().mockResolvedValue({ apps: [], triggerOutputs: {} }) },
}));
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => api }));

import {
    AI_STEP as step, AI_DEFINITION as definition, aiStepProps as baseProps, renderInQueryClient as render,
} from './ndv/ndvTestProps';
import NodeDetailView from './NodeDetailView';

/**
 * The output sheet's field face, for the value it meets most often: prose.
 *
 * The field list replaced the raw textarea so nobody has to hand-write a
 * brace, and the one-line `<input>` it gives a text field is right for a
 * subject or an order id. It is wrong for a BODY. `<input type="text">` runs
 * the HTML value sanitisation algorithm, which strips every LF and CR: a
 * pinned "Dear Ada,\n\nThanks…" showed up as "Dear Ada,Thanks…" in the box,
 * and the first keystroke in that box handed the flattened string straight
 * back into the JSON — paragraphs deleted without a visible edit, one Save
 * from being the shape every step downstream maps against.
 *
 * That value is not an edge case here. An AI step's answer is one
 * multi-paragraph string, which is exactly the NAMELESS single-value face this
 * sheet opens on for an ai_step. So: a row whose text already has line breaks
 * gets a textarea, and it keeps it (sticky on the row) so deleting the last
 * newline does not swap the control out from under the caret.
 *
 * Against the one-line-input version, every test below fails: the first two on
 * the flattened text in the box, the last two on the flattened value reaching
 * onSaveStep.
 */

const openOn = (pinnedOutput, onSaveStep = vi.fn().mockResolvedValue(undefined)) => {
    const pinned = { ...step, pinnedOutput, pinnedAt: 'now', pinnedSource: 'edited' };
    const def = { ...definition, steps: [pinned] };
    render(<NodeDetailView {...baseProps({ step: pinned, definition: def, rootDefinition: def, onSaveStep })} />);
    fireEvent.click(screen.getByTestId('ndv-edit-output'));
    return onSaveStep;
};

const save = () => fireEvent.click(screen.getByText('Save output'));
const savedOutput = (onSaveStep) => onSaveStep.mock.calls.at(-1)[0].steps[0].pinnedOutput;

const BODY = 'Dear Ada,\n\nThanks for your order.\n\nKind regards';

beforeEach(() => { cleanup(); try { localStorage.clear(); } catch { /* ignore */ } });

describe('NodeDetailView — a multi-paragraph value keeps its paragraphs', () => {
    it('shows a field body in a control that can hold line breaks', () => {
        openOn({ subject: 'Hi', body: BODY });

        const box = screen.getByLabelText('body value');
        expect(box.tagName).toBe('TEXTAREA');
        // The whole value, newlines and all — an <input> would have shown
        // "Dear Ada,Thanks for your order.Kind regards".
        expect(box.value).toBe(BODY);
        // The ordinary one-line field is untouched by this.
        expect(screen.getByLabelText('subject value').tagName).toBe('INPUT');
    });

    it('does the same on the nameless single-value face, where an AI answer lands', () => {
        openOn(BODY);

        const box = screen.getByLabelText('Value');
        expect(box.tagName).toBe('TEXTAREA');
        expect(box.value).toBe(BODY);
    });

    it('saves the paragraphs back after an edit inside them', async () => {
        const onSaveStep = openOn({ body: BODY });

        fireEvent.change(screen.getByLabelText('body value'), { target: { value: `${BODY}\n\nAda` } });
        save();

        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        expect(savedOutput(onSaveStep)).toEqual({ body: `${BODY}\n\nAda` });
    });

    it('keeps the tall control after the last line break is deleted', () => {
        // Sticky on purpose: recomputing "is this multi-line" from the text on
        // every keystroke would swap textarea for input the moment the author
        // deleted the last newline, and the caret would go with it.
        openOn({ body: 'one\ntwo' });

        fireEvent.change(screen.getByLabelText('body value'), { target: { value: 'one two' } });
        expect(screen.getByLabelText('body value').tagName).toBe('TEXTAREA');
        expect(screen.getByLabelText('body value').value).toBe('one two');
    });

    it('leaves an untouched body alone when a sibling field is edited', async () => {
        // True before the repair too (React never writes the sanitised value
        // back on its own) — pinned here because it is the half of the bug that
        // was invisible: the JSON was still right while the box lied about it.
        const onSaveStep = openOn({ body: BODY, subject: 'Hi' });

        fireEvent.change(screen.getByLabelText('subject value'), { target: { value: 'Bye' } });
        save();

        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        expect(savedOutput(onSaveStep)).toEqual({ body: BODY, subject: 'Bye' });
    });
});
