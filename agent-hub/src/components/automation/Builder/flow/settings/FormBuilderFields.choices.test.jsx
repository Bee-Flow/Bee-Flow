import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalChoicesInput } from './approvalEditors';
import FormBuilderFields from './FormBuilderFields';
import { GmailLabelFilterFields } from './triggerFilters';

/**
 * BFSF-407 — the list boxes that swallow the key that separates two entries.
 *
 * "Choices (one per line)" derived its text from the stored array, which is
 * trimmed and blank-free. Typing Space or Enter at the end therefore produced
 * an array that re-joined WITHOUT that character; the write-back is
 * synchronous, so React re-asserted node.value inside the same event and the
 * keystroke was reverted — and, because the whole value is reassigned, the
 * caret jumped to the end of the box. A second choice could only be pasted in.
 *
 * These tests only reproduce that with a CONTROLLED host: with a bare
 * vi.fn() as onChange (as in FormBuilderFields.download.test.jsx) the array
 * never comes back, so nothing re-renders and the bug cannot appear.
 */

/**
 * The host the card actually has in the builder: it holds the declaration and
 * takes back whatever the card emits. Re-rendering it with a new `external`
 * declaration plays the part of an edit from OUTSIDE the card — an undo, or
 * the AI builder rewriting the field.
 */
function Controlled({ initial, external = null, onForm }) {
    const [form, setForm] = useState(initial);
    const [applied, setApplied] = useState(external);
    if (applied !== external) {
        setApplied(external);
        if (external) setForm(external);
    }
    return (
        <FormBuilderFields
            form={form}
            onChange={(next) => { setForm(next); onForm?.(next); }}
            bindingBase="trigger.output"
        />
    );
}

const selectForm = (options = ['Red']) => ({
    title: 'Get in touch',
    description: '',
    submitLabel: 'Submit',
    successMessage: 'Thanks!',
    fields: [{ name: 'colour', type: 'select', label: 'Colour', required: false, options }],
    theme: null,
});

/**
 * One keystroke, the way a browser delivers it: the new value, and where the
 * caret sits afterwards. RTL assigns `value` through the native setter first
 * and the rest of `target` after, so the caret survives into the event.
 */
function typeInto(el, value, caret = value.length) {
    fireEvent.change(el, { target: { value, selectionStart: caret, selectionEnd: caret } });
}

const optionsOf = (form) => form.fields[0].options;

describe('FormBuilderFields — choices, one per line', () => {
    beforeEach(cleanup);

    it('keeps the newline that starts a second choice', () => {
        render(<Controlled initial={selectForm(['Red'])} />);
        const box = screen.getByLabelText('Question 1 choices');

        typeInto(box, 'Red\n');

        expect(box.value).toBe('Red\n');
    });

    it('keeps a trailing space', () => {
        render(<Controlled initial={selectForm(['Red'])} />);
        const box = screen.getByLabelText('Question 1 choices');

        typeInto(box, 'Red ');

        expect(box.value).toBe('Red ');
    });

    it('lets a second choice be typed, and persists both', () => {
        const seen = [];
        render(<Controlled initial={selectForm(['Red'])} onForm={(f) => seen.push(f)} />);
        const box = screen.getByLabelText('Question 1 choices');

        // Keystroke by keystroke: the newline has to SURVIVE for the next
        // character to land on line two. Pasting the whole value at once
        // always worked, which is why the bug looked intermittent.
        typeInto(box, 'Red\n');
        expect(box.value).toBe('Red\n');
        typeInto(box, `${box.value}B`);
        typeInto(box, `${box.value}lue`);

        expect(box.value).toBe('Red\nBlue');
        expect(optionsOf(seen.at(-1))).toEqual(['Red', 'Blue']);
    });

    it('keeps the spaces INSIDE a choice, and stores them', () => {
        const seen = [];
        render(<Controlled initial={selectForm(['Red'])} onForm={(f) => seen.push(f)} />);
        const box = screen.getByLabelText('Question 1 choices');

        typeInto(box, 'Red Car');

        expect(box.value).toBe('Red Car');
        expect(optionsOf(seen.at(-1))).toEqual(['Red Car']);
    });

    it('leaves the caret where the typist put it', () => {
        // The symptom the reporter actually felt: with several choices, the
        // reverted keystroke reassigned the whole value, so the caret snapped
        // to the end of the box and the next character landed on the wrong line.
        render(<Controlled initial={selectForm(['Red', 'Blue'])} />);
        const box = screen.getByLabelText('Question 1 choices');

        // A space typed at the end of line ONE — caret sits at index 4.
        typeInto(box, 'Red \nBlue', 4);

        expect(box.value).toBe('Red \nBlue');
        expect(box.selectionStart).toBe(4);
    });

    it('keeps the newline when the last character of a line is deleted', () => {
        // The case a useEffect-based resync gets wrong: `Red\nB` → Backspace
        // changes the stored array, and an effect would then re-join it to
        // `Red`, removing a newline the author never touched.
        const seen = [];
        render(<Controlled initial={selectForm(['Red', 'B'])} onForm={(f) => seen.push(f)} />);
        const box = screen.getByLabelText('Question 1 choices');
        expect(box.value).toBe('Red\nB');

        typeInto(box, 'Red\n');

        expect(box.value).toBe('Red\n');
        expect(optionsOf(seen.at(-1))).toEqual(['Red']);
    });

    it('adopts an edit that came from outside the card', () => {
        // The buffer must not become write-only: an undo or the AI builder
        // rewriting the field has to reach the textarea.
        const { rerender } = render(<Controlled initial={selectForm(['Red'])} />);
        const box = screen.getByLabelText('Question 1 choices');
        typeInto(box, 'Red\n');

        rerender(<Controlled initial={selectForm(['Red'])} external={selectForm(['Green'])} />);

        expect(box.value).toBe('Green');
    });

    it('renders a stored choice that carries stray whitespace', () => {
        // Nothing this editor writes has it, but an AI-authored or imported
        // routine can. The resync compares both sides the way the write-back
        // normalises them, so such a value settles instead of re-triggering
        // itself every render ("Too many re-renders").
        render(<Controlled initial={selectForm(['Red ', 'Blue'])} />);

        expect(screen.getByLabelText('Question 1 choices').value).toBe('Red \nBlue');
    });

    it('offers an example of the shape it wants', () => {
        render(<Controlled initial={selectForm(['Red'])} />);
        expect(screen.getByLabelText('Question 1 choices').placeholder).toBe('Red\nGreen\nBlue');
    });
});

/**
 * The two siblings that had the same round-trip, with a comma instead of a
 * newline — and were strictly worse for it: the comma is what SEPARATES two
 * entries, so a second one could not be typed at all.
 */
function ControlledApprovalChoices({ initial, onChange }) {
    const [options, setOptions] = useState(initial);
    return <ApprovalChoicesInput options={options} onChange={(next) => { setOptions(next); onChange?.(next); }} />;
}

describe('ApprovalChoicesInput — choices, comma-separated', () => {
    beforeEach(cleanup);

    it('keeps the comma that starts a second choice', () => {
        render(<ControlledApprovalChoices initial={[{ value: 'Red', label: 'Red' }]} />);
        const box = screen.getByPlaceholderText('Choices, comma-separated');

        typeInto(box, 'Red,');

        expect(box.value).toBe('Red,');
    });

    it('keeps the space after the comma', () => {
        render(<ControlledApprovalChoices initial={[{ value: 'Red', label: 'Red' }]} />);
        const box = screen.getByPlaceholderText('Choices, comma-separated');

        typeInto(box, 'Red, ');

        expect(box.value).toBe('Red, ');
    });

    it('stores the second choice as a value/label pair', () => {
        const seen = [];
        render(<ControlledApprovalChoices initial={[{ value: 'Red', label: 'Red' }]} onChange={(o) => seen.push(o)} />);
        const box = screen.getByPlaceholderText('Choices, comma-separated');

        typeInto(box, 'Red, ');
        expect(box.value).toBe('Red, ');
        typeInto(box, `${box.value}Blue`);

        expect(box.value).toBe('Red, Blue');
        expect(seen.at(-1)).toEqual([{ value: 'Red', label: 'Red' }, { value: 'Blue', label: 'Blue' }]);
    });
});

function ControlledGmailLabelFilter({ initial, onChange }) {
    const [filter, setFilter] = useState(initial);
    return (
        <GmailLabelFilterFields
            filter={filter}
            setFilter={(key, value) => {
                const next = { ...filter, [key]: value };
                if (value === undefined) delete next[key];
                setFilter(next);
                onChange?.(next);
            }}
        />
    );
}

describe('GmailLabelFilterFields — exclude labels, comma-separated', () => {
    beforeEach(cleanup);

    it('keeps the comma that starts a second label', () => {
        render(<ControlledGmailLabelFilter initial={{ labelId: 'Label_3', excludeLabelIds: ['Label_9'] }} />);
        const box = screen.getByLabelText('Exclude labels');

        typeInto(box, 'Label_9,');

        expect(box.value).toBe('Label_9,');
    });

    it('keeps a trailing space', () => {
        render(<ControlledGmailLabelFilter initial={{ labelId: 'Label_3', excludeLabelIds: ['Label_9'] }} />);
        const box = screen.getByLabelText('Exclude labels');

        typeInto(box, 'Label_9, ');

        expect(box.value).toBe('Label_9, ');
    });

    it('persists both labels once the second is typed', () => {
        const seen = [];
        render(<ControlledGmailLabelFilter initial={{ labelId: 'Label_3' }} onChange={(f) => seen.push(f)} />);
        const box = screen.getByLabelText('Exclude labels');

        typeInto(box, 'Label_9,');
        expect(box.value).toBe('Label_9,');
        typeInto(box, `${box.value}IMPORTANT`);

        expect(box.value).toBe('Label_9,IMPORTANT');
        expect(seen.at(-1).excludeLabelIds).toEqual(['Label_9', 'IMPORTANT']);
    });
});
