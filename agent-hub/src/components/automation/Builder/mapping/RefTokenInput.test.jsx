import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React, { createRef } from 'react';
import RefTokenInput from './RefTokenInput';
import { editorValue, typeInEditor } from '../../../../test/refEditor';

/**
 * The editing surface behind every mapping field. Its promise is narrow and
 * absolute: an author never sees `steps.act_f9aaff0e.output…`, and the value
 * that reaches the step is byte-identical to what it would have been before.
 */

const LABELS = new Map([['act_f9aaff0e', 'gmail read']]);

function setup(props = {}) {
    const onChange = vi.fn();
    const ref = createRef();
    render(
        <RefTokenInput
            ref={ref}
            value=""
            mode="fixed"
            multiline
            stepLabelById={LABELS}
            onChange={onChange}
            ariaLabel="Prompt"
            {...props}
        />,
    );
    return { onChange, ref, el: screen.getByRole('textbox') };
}

beforeEach(cleanup);

describe('what is on screen', () => {
    it('shows the step name where the stored value has an id path', () => {
        const { el } = setup({ value: 'Summarise:\n{{steps.act_f9aaff0e.output.results[*].output}}' });
        expect(el.textContent).toContain('gmail read');
        expect(el.textContent).not.toContain('act_f9aaff0e');
        expect(editorValue(el)).toBe('Summarise:\n{{steps.act_f9aaff0e.output.results[*].output}}');
    });

    it('keeps showing the name after focus — that is the whole point', () => {
        const { el } = setup({ value: '{{steps.act_f9aaff0e.output.body}}' });
        fireEvent.focus(el);
        expect(el.textContent).not.toContain('steps.');
    });

    it('paints a placeholder when empty, and exposes it for assistive tech', () => {
        const { el } = setup({ placeholder: 'Write a prompt…' });
        expect(el.getAttribute('aria-placeholder')).toBe('Write a prompt…');
        expect(screen.getByText('Write a prompt…')).toBeTruthy();
    });
});

describe('inserting a reference', () => {
    it('arrives as a pill, not as text the author has to read', () => {
        const { el, ref, onChange } = setup({ value: 'Summarise ' });
        ref.current.insertSnippet('{{steps.act_f9aaff0e.output.body}}');
        expect(onChange).toHaveBeenCalledWith('Summarise {{steps.act_f9aaff0e.output.body}}');
        expect(el.textContent).toBe('Summarise gmail read▸ Body');
    });

    it('swallows the partial that was typed instead of landing after it', () => {
        // Someone typed "{{ste" and picked from the suggestion list.
        const { el, ref, onChange } = setup();
        typeInEditor(el, 'Summarise {{ste');
        ref.current.replacePartial(5, '{{steps.act_f9aaff0e.output.body}}');
        expect(onChange).toHaveBeenLastCalledWith('Summarise {{steps.act_f9aaff0e.output.body}}');
    });

    it('leaves somewhere to type after a reference at the very end', () => {
        const { el, ref } = setup();
        ref.current.insertSnippet('{{steps.act_f9aaff0e.output.body}}');
        expect(el.lastChild.nodeType).toBe(3);
    });
});

describe('inserting several references in a row', () => {
    const A = '{{steps.act_f9aaff0e.output.a}}';
    const B = '{{steps.act_f9aaff0e.output.b}}';
    const C = '{{steps.act_f9aaff0e.output.c}}';

    it('separates a reference from the reference before it with one space', () => {
        const { ref, onChange } = setup();
        ref.current.insertSnippet(A);
        ref.current.insertSnippet(B);
        ref.current.insertSnippet(C);
        expect(onChange).toHaveBeenLastCalledWith(`${A} ${B} ${C}`);
    });

    it('separates a reference from text it lands right after', () => {
        const { ref, onChange } = setup({ value: 'Hello' });
        ref.current.insertSnippet(A);
        expect(onChange).toHaveBeenLastCalledWith(`Hello ${A}`);
    });

    it('does not add a second space after a space or a newline', () => {
        const { ref, onChange } = setup({ value: 'Hello\n' });
        ref.current.insertSnippet(A);
        expect(onChange).toHaveBeenLastCalledWith(`Hello\n${A}`);
    });

    it('also separates a drop from the text that follows it', () => {
        const { ref, onChange } = setup({ value: 'world' });
        const range = document.createRange();
        range.setStart(ref.current.element.firstChild, 0);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        fireEvent.keyUp(ref.current.element, { key: 'Home' });
        ref.current.insertSnippet(A);
        expect(onChange).toHaveBeenLastCalledWith(`${A} world`);
    });

    it('keeps a reference glued where a space would change the value: after "/", before "."', () => {
        const { ref, onChange } = setup({ value: 'https://api.example.com/users/' });
        ref.current.insertSnippet(A);
        expect(onChange).toHaveBeenLastCalledWith(`https://api.example.com/users/${A}`);
    });

    it('puts no space before punctuation that follows the drop', () => {
        const { ref, onChange } = setup({ value: '.' });
        const range = document.createRange();
        range.setStart(ref.current.element.firstChild, 0);
        range.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        fireEvent.keyUp(ref.current.element, { key: 'Home' });
        ref.current.insertSnippet(A);
        expect(onChange).toHaveBeenLastCalledWith(`${A}.`);
    });

    it('adds nothing in a data slot (spaced={false})', () => {
        const { ref, onChange } = setup({ value: 'Hello', spaced: false });
        ref.current.insertSnippet(A);
        expect(onChange).toHaveBeenLastCalledWith(`Hello${A}`);
    });

    it('leaves a single-reference (binding) field alone', () => {
        const { ref, onChange } = setup({ mode: 'binding', value: 'x' });
        ref.current.insertSnippet('steps.act_f9aaff0e.output.a');
        expect(onChange.mock.calls.at(-1)[0]).not.toContain(' steps');
    });
});

describe('editing', () => {
    it('emits what was typed, verbatim', () => {
        const { el, onChange } = setup();
        typeInEditor(el, 'Make a short summary:');
        expect(onChange).toHaveBeenCalledWith('Make a short summary:');
    });

    it('removes a whole reference on one Backspace', () => {
        // Browsers mostly do this for a contenteditable=false node, but not
        // consistently — a half-deleted pill would serialize to a raw path
        // nobody can see.
        const { el, onChange } = setup({ value: 'a {{steps.act_f9aaff0e.output.body}}' });
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        fireEvent.keyDown(el, { key: 'Backspace' });
        expect(onChange).toHaveBeenCalledWith('a ');
    });

    it('turns a hand-typed {{…}} into a pill once the caret leaves', () => {
        const { el } = setup();
        typeInEditor(el, 'Hi {{steps.act_f9aaff0e.output.body}}');
        // Still raw while the caret is inside it — rewriting mid-word would move
        // the caret out from under the author.
        expect(el.textContent).toContain('steps.act_f9aaff0e');
        fireEvent.blur(el);
        expect(el.textContent).toBe('Hi gmail read▸ Body');
        expect(editorValue(el)).toBe('Hi {{steps.act_f9aaff0e.output.body}}');
    });

    it('refuses a newline in a single-line slot', () => {
        const { el, onChange } = setup({ multiline: false, value: 'one line' });
        fireEvent.keyDown(el, { key: 'Enter' });
        expect(onChange).not.toHaveBeenCalled();
    });

    it('pastes as plain text — a copied fragment brings markup that cannot survive', () => {
        const { el, onChange } = setup();
        fireEvent.paste(el, { clipboardData: { getData: () => 'first\nsecond' } });
        expect(onChange).toHaveBeenCalledWith('first\nsecond');
        expect(el.querySelector('br')).toBeTruthy();
    });
});

describe('outside changes', () => {
    it('an undo or an AI patch re-renders; our own echo does not', () => {
        const onChange = vi.fn();
        const { rerender } = render(<RefTokenInput value="a" mode="fixed" stepLabelById={LABELS} onChange={onChange} />);
        const el = screen.getByRole('textbox');
        typeInEditor(el, 'ab');
        // The parent echoes our value straight back — re-rendering on that would
        // drop the caret on every keystroke.
        rerender(<RefTokenInput value="ab" mode="fixed" stepLabelById={LABELS} onChange={onChange} />);
        expect(editorValue(el)).toBe('ab');

        rerender(<RefTokenInput value="{{steps.act_f9aaff0e.output.body}}" mode="fixed" stepLabelById={LABELS} onChange={onChange} />);
        expect(el.textContent).toBe('gmail read▸ Body');
    });
});
