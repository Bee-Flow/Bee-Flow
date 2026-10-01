import { beforeEach, describe, expect, it } from 'vitest';
import type { PickPart } from '@shared/mapping/index.mjs';
import {
    buildFragment, buildPill, FILLER_ATTR, insertAtCaret, PILL_SELECTOR, pillBeforeCaret, pillIndex,
    renderInto, replacePill, serializeHost,
} from './slotDom';
import type { PillSpec } from './slotDom';
import type { SlotPiece } from './composeValue';

/**
 * The one invariant: the editor is a PRESENTATION of the field's pieces,
 * never a rewrite of them. serializeHost(buildFragment(pieces)) gives the
 * pieces back, for typed text, value pills and legacy `{{ }}` pills alike.
 */

const PRODUCTS: PickPart = { from: { root: 'trigger', path: ['orders', 'lines', 'product'] }, take: 'all', as: 'text', join: 'lines', label: 'Product' };
const NAME: PickPart = { from: { root: 'steps', id: 'ai_1', path: ['name'] }, take: 'one', as: 'text' };

const pillFor = (piece: Exclude<SlotPiece, string>): PillSpec => ({
    piece,
    tone: 'part' in piece ? 'value' : 'formula',
    name: 'part' in piece ? (piece.part.label || 'Value') : 'Formula',
    list: 'part' in piece && piece.part.take === 'all',
    count: 'part' in piece && piece.part.take === 'all' ? 12 : null,
});

let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
});

function roundTrip(pieces: SlotPiece[]) {
    host.replaceChildren(buildFragment(pieces, pillFor));
    return serializeHost(host);
}

describe('round-trip', () => {
    const CASES: Record<string, SlotPiece[]> = {
        'plain text': ['Make a short summary:'],
        'empty': [],
        'one pill': [{ part: PRODUCTS }],
        'text around pills': ['Beste ', { part: NAME }, ',\nUw orders:\n', { part: PRODUCTS }],
        'two pills in a row': [{ part: NAME }, { part: PRODUCTS }],
        'a legacy placeholder, spacing kept': ['Key: ', { raw: '{{ secrets.apiKey }}' }, '!'],
        'a trailing newline': ['line one\n'],
        'consecutive newlines': ['a\n\n\nb'],
        'a pill after a newline': ['a\n', { part: NAME }],
    };
    for (const [name, pieces] of Object.entries(CASES)) {
        it(name, () => expect(roundTrip(pieces)).toEqual(pieces));
    }

    it('renderInto adds a filler the value never sees', () => {
        renderInto(host, ['a\n'], pillFor);
        expect(host.lastElementChild?.hasAttribute(FILLER_ATTR)).toBe(true);
        expect(serializeHost(host)).toEqual(['a\n']);
        renderInto(host, ['a', { part: NAME }], pillFor);
        expect(host.lastChild?.nodeType).toBe(3);
        expect(serializeHost(host)).toEqual(['a', { part: NAME }]);
    });

    it('wrappers a browser adds on its own cost structure, never text', () => {
        host.innerHTML = 'one<div>two</div><p>three<br></p>';
        expect(serializeHost(host)).toEqual(['one\ntwo\nthree\n']);
    });
});

describe('pills', () => {
    it('carry what they stand for as data; show only words', () => {
        const pill = buildPill(pillFor({ part: PRODUCTS }));
        expect(pill.getAttribute('contenteditable')).toBe('false');
        expect(JSON.parse(pill.getAttribute('data-part') || '')).toEqual(PRODUCTS);
        expect(pill.dataset.raw).toBe('{{trigger.output.orders.lines.product}}');
        expect(pill.textContent).toBe('Product≡ 12');
        expect(pill.textContent).not.toMatch(/trigger|\{\{/);
    });

    it('a list with no known count shows the list mark alone', () => {
        const pill = buildPill({ piece: { part: PRODUCTS }, tone: 'value', name: 'Product', list: true, count: null });
        expect(pill.textContent).toBe('Product≡');
    });

    it('a legacy pill keeps its exact text', () => {
        const pill = buildPill(pillFor({ raw: '{{ x + 1 }}' }));
        expect(pill.dataset.raw).toBe('{{ x + 1 }}');
        expect(pill.hasAttribute('data-part')).toBe(false);
    });
});

describe('editing', () => {
    function caretAt(node: Node, offset: number) {
        const sel = window.getSelection()!;
        const range = document.createRange();
        range.setStart(node, offset);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return range;
    }

    it('Backspace right after a pill finds the whole pill', () => {
        renderInto(host, ['Hi ', { part: NAME }, ' there'], pillFor);
        const after = host.querySelector(PILL_SELECTOR)!.nextSibling!;
        caretAt(after, 0);
        expect(pillBeforeCaret(host)).toBe(host.querySelector(PILL_SELECTOR));
        caretAt(after, 1);
        expect(pillBeforeCaret(host)).toBeNull();
    });

    it('inserting at the caret keeps every typed character, even a selected one', () => {
        renderInto(host, ['Beste klant'], pillFor);
        const text = host.firstChild!;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 5);
        insertAtCaret(host, [buildPill(pillFor({ part: NAME }))], { range });
        expect(serializeHost(host)).toEqual(['Beste', { part: NAME }, ' klant']);
    });

    it('no remembered caret: the value goes at the end', () => {
        renderInto(host, ['Beste '], pillFor);
        insertAtCaret(host, [buildPill(pillFor({ part: NAME }))], { range: null });
        expect(serializeHost(host)).toEqual(['Beste ', { part: NAME }]);
    });

    it('replacePill swaps one pill, found again by position after a re-render', () => {
        renderInto(host, ['a ', { part: NAME }, ' b ', { part: PRODUCTS }], pillFor);
        const old = host.querySelectorAll(PILL_SELECTOR)[1];
        const index = pillIndex(host, old);
        renderInto(host, serializeHost(host), pillFor);
        const changed: PickPart = { ...PRODUCTS, take: 'first' };
        delete changed.join;
        replacePill(host, old, [buildPill(pillFor({ part: changed }))], { index });
        expect(serializeHost(host)).toEqual(['a ', { part: NAME }, ' b ', { part: changed }]);
    });
});
