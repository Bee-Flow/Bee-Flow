import { render, cleanup, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import RefTokenInput from './RefTokenInput';

/**
 * A pill is a control, not just a label (user request 2026-09-03): clicking
 * it hands the host the path it stands for, and the host swaps it for the
 * answer. A drop can name the point it landed on.
 */
const LABELS = new Map([['a', 'Read the figures']]);
const pill = () => document.querySelector('[data-ref-pill]');

describe('RefTokenInput — pills you can click and re-pick', () => {
    beforeEach(cleanup);

    it('a click on a pill reports its path, without the braces', () => {
        const onPillClick = vi.fn();
        render(<RefTokenInput value="Hi {{steps.a.output.x}}" mode="fixed" onChange={() => {}} stepLabelById={LABELS} onPillClick={onPillClick} />);
        fireEvent.click(pill().firstChild);
        expect(onPillClick).toHaveBeenCalledTimes(1);
        expect(onPillClick.mock.calls[0][0]).toMatchObject({ raw: '{{steps.a.output.x}}', path: 'steps.a.output.x' });
        expect(onPillClick.mock.calls[0][0].el).toBe(pill());
    });

    it('a click on plain text is not a pill click', () => {
        const onPillClick = vi.fn();
        const { container } = render(<RefTokenInput value="Hi {{steps.a.output.x}}" mode="fixed" onChange={() => {}} onPillClick={onPillClick} />);
        fireEvent.click(container.querySelector('[data-ref-editor]'));
        expect(onPillClick).not.toHaveBeenCalled();
    });

    it('replacePill swaps exactly that pill and keeps the text around it', () => {
        const onChange = vi.fn();
        const ref = React.createRef();
        render(<RefTokenInput ref={ref} value="Hi {{steps.a.output.x}} there" mode="fixed" onChange={onChange} stepLabelById={LABELS} />);
        act(() => { ref.current.replacePill(pill(), '{{steps.a.output.y}}'); });
        expect(onChange).toHaveBeenLastCalledWith('Hi {{steps.a.output.y}} there');
        expect(document.querySelectorAll('[data-ref-pill]')).toHaveLength(1);
    });

    it('a blur keeps the pill elements — the clicked pill must survive the picker taking focus', () => {
        const { container } = render(<RefTokenInput value="Hi {{steps.a.output.x}}" mode="fixed" onChange={() => {}} stepLabelById={LABELS} />);
        const before = pill();
        fireEvent.blur(container.querySelector('[data-ref-editor]'));
        expect(pill()).toBe(before);
    });

    it('a blur still turns a hand-typed reference into a pill', () => {
        const { container } = render(<RefTokenInput value="" mode="fixed" onChange={() => {}} stepLabelById={LABELS} />);
        const host = container.querySelector('[data-ref-editor]');
        host.textContent = 'See {{steps.a.output.x}} now';
        fireEvent.input(host);
        expect(document.querySelectorAll('[data-ref-pill]')).toHaveLength(0);
        fireEvent.blur(host);
        expect(document.querySelectorAll('[data-ref-pill]')).toHaveLength(1);
    });

    it('replacePill finds the pill again by its raw text if the host was rebuilt meanwhile', () => {
        const onChange = vi.fn();
        const ref = React.createRef();
        const { rerender } = render(<RefTokenInput ref={ref} value="Hi {{steps.a.output.x}}" mode="fixed" onChange={onChange} stepLabelById={LABELS} />);
        const stale = pill();
        // A label change re-renders every pill while the field is not focused.
        rerender(<RefTokenInput ref={ref} value="Hi {{steps.a.output.x}}" mode="fixed" onChange={onChange} stepLabelById={new Map([['a', 'Renamed']])} />);
        expect(pill()).not.toBe(stale);
        act(() => { ref.current.replacePill(stale, '{{steps.a.output.y}}'); });
        expect(onChange).toHaveBeenLastCalledWith('Hi {{steps.a.output.y}}');
    });

    it('insertSnippetAt falls back to the caret (the end) when the browser cannot place a point', () => {
        // jsdom has neither caretRangeFromPoint nor caretPositionFromPoint —
        // the same fallback a browser takes for a point outside the field.
        const onChange = vi.fn();
        const ref = React.createRef();
        render(<RefTokenInput ref={ref} value="Hi " mode="fixed" onChange={onChange} stepLabelById={LABELS} />);
        act(() => { ref.current.insertSnippetAt('{{steps.a.output.z}}', { x: 5, y: 5 }); });
        expect(onChange).toHaveBeenLastCalledWith('Hi {{steps.a.output.z}}');
    });
});
