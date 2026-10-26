import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RulesEditor from './RulesEditor';
import SkillStepEditor from './SkillStepEditor';

/**
 * The two editors that replaced a textarea: steps and rules.
 *
 * The claims worth pinning are the ones a free-text box could never make:
 *   - a step is an OBJECT with an id, so it survives being reordered and can
 *     be pointed at by a test result;
 *   - a reference is picked, not typed, and only from what exists;
 *   - polarity is a field with two values, not a word in the sentence, and
 *     the mark that shows it is the control that changes it;
 *   - a read-only viewer gets no affordance at all — not a disabled one.
 */

vi.mock('@/utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}));

const REF_OPTIONS = {
    automation: [{ id: 'a1', name: 'Look up quote status' }],
    kb: [{ id: 'k1', name: 'Quote terms' }],
    table: [{ id: 't1', name: 'Pricelist' }],
};

/** useSkillPickerData's answer when all four reads came back. */
const LISTS_READ = { loaded: true, unavailable: [] };

function Harness({ initial = [], readOnly = false, refOptions = REF_OPTIONS, listStatus = LISTS_READ, onSteps, onOpenRef }) {
    const [steps, setSteps] = useState(initial);
    return (
        <SkillStepEditor
            steps={steps}
            readOnly={readOnly}
            refOptions={refOptions}
            listStatus={listStatus}
            onOpenRef={onOpenRef}
            onChange={(next) => { setSteps(next); onSteps?.(next); }}
        />
    );
}

function RulesHarness({ initial = [], readOnly = false, onRules }) {
    const [rules, setRules] = useState(initial);
    return (
        <RulesEditor
            rules={rules}
            readOnly={readOnly}
            onChange={(next) => { setRules(next); onRules?.(next); }}
        />
    );
}

beforeEach(() => { cleanup(); vi.clearAllMocks(); });
// `measureCardsAsAStack` hangs a spy on Element.prototype; without this, that
// geometry leaks into every subsequent test in this file.
afterEach(() => { vi.restoreAllMocks(); });

/**
 * ── GIVING THE CARDS REAL GEOMETRY ───────────────────────────────────
 * jsdom measures nothing: every getBoundingClientRect is 0x0. dnd-kit reads REAL
 * rectangles where an arrow key points to — `sortableKeyboardCoordinates` compares
 * the top edges of the boxes and picks the nearest one in that direction — so with
 * nothing but zeros every arrow points nowhere and the test would stay green for
 * the wrong reason. The cards therefore get the geometry a browser would give them:
 * a stack of rows in DOM order, as tall as a real step card with a textarea in it.
 * Nothing else is imitated.
 *
 * That height is not inconsequential. dnd-kit's OWN default coordinateGetter moves
 * a fixed number of pixels per keypress; only `sortableKeyboardCoordinates` jumps
 * to the neighbouring box, however tall that is. With rows of 40px both succeed and
 * the test does not hold the choice in place — at a realistic card height the
 * default does not get across the edge and this one does.
 */
const CARD_HEIGHT = 96;
const NO_RECT = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON() {} };

function measureCardsAsAStack() {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function measured() {
        if (!this.matches?.('[data-step-id]')) return { ...NO_RECT };
        const top = Array.prototype.indexOf.call(this.parentElement.children, this) * CARD_HEIGHT;
        return { x: 0, y: top, top, bottom: top + CARD_HEIGHT, left: 0, right: 240, width: 240, height: CARD_HEIGHT, toJSON() {} };
    });
}

/**
 * dnd-kit only attaches its keydown listener in a `setTimeout` after picking up,
 * and measures the boxes in a frame. Between two keystrokes the macrotask queue
 * must therefore be drained.
 */
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

describe('steps', () => {
    it('adds a step with an id of its own, so nothing is keyed by position', async () => {
        const user = userEvent.setup();
        const onSteps = vi.fn();
        render(<Harness onSteps={onSteps} />);
        await user.click(screen.getByTestId('skill-step-add'));
        const [next] = onSteps.mock.calls.at(-1);
        expect(next).toHaveLength(1);
        expect(next[0].id).toMatch(/^step_/);
        expect(next[0]).toEqual({ id: next[0].id, text: '', refs: [] });
    });

    it('numbers the cards from their position, not from what was typed', () => {
        render(<Harness initial={[
            { id: 'a', text: 'first', refs: [] },
            { id: 'b', text: 'second', refs: [] },
        ]} />);
        const cards = screen.getAllByTestId('skill-step');
        expect(within(cards[0]).getByText('1')).toBeTruthy();
        expect(within(cards[1]).getByText('2')).toBeTruthy();
    });

    it('edits a step in place without disturbing its neighbours', () => {
        const onSteps = vi.fn();
        render(<Harness
            initial={[{ id: 'a', text: 'one', refs: [] }, { id: 'b', text: 'two', refs: [] }]}
            onSteps={onSteps}
        />);
        fireEvent.change(screen.getByDisplayValue('one'), { target: { value: 'ONE' } });
        const [next] = onSteps.mock.calls.at(-1);
        expect(next.map(s => s.text)).toEqual(['ONE', 'two']);
        expect(next[1]).toEqual({ id: 'b', text: 'two', refs: [] });
    });

    it('removes the step that was asked for, by id', async () => {
        const user = userEvent.setup();
        const onSteps = vi.fn();
        render(<Harness
            initial={[{ id: 'a', text: 'one', refs: [] }, { id: 'b', text: 'two', refs: [] }]}
            onSteps={onSteps}
        />);
        const cards = screen.getAllByTestId('skill-step');
        await user.click(within(cards[0]).getByRole('button', { name: /Remove step/i }));
        expect(onSteps.mock.calls.at(-1)[0].map(s => s.id)).toEqual(['b']);
    });

    /**
     * ── THE KEYBOARD IS THE WHOLE TEST ──────────────────────────────
     * There used to be a test here that checked whether the grip had a NAME (“Reorder
     * step 1”) and called that “reachable without a mouse”. That proves nothing: with
     * the KeyboardSensor from `useSensors` removed, the entire SkillsStudio folder
     * stayed green — 106 of 106 at the time. @dnd-kit CAN drag by keyboard, but only
     * if that sensor is switched on, and a reorder that works only with the mouse is
     * no feature for some of the users.
     *
     * So the reorder is now REALLY performed here: Space picks up, ArrowDown moves,
     * Space puts down. What the assertion holds is the OUTCOME (`onChange` receives
     * the new order), not the path to it.
     *
     * TWO keystrokes, not one. Moving a step one place is a swap of neighbours, and
     * that is symmetric: `moveItem(rows, 0, 1)` and `moveItem(rows, 1, 0)` both give
     * ['b','a','c'], so a reversed from/to would slip past the test unnoticed. Over
     * two places the two diverge (['b','c','a'] against ['c','a','b']) — and it
     * immediately proves that the grip survives a second move.
     */
    it('reorders with the keyboard alone: space picks a step up, arrows move it, space drops it', async () => {
        const onSteps = vi.fn();
        measureCardsAsAStack();
        render(<Harness
            initial={[
                { id: 'a', text: 'one', refs: [] },
                { id: 'b', text: 'two', refs: [] },
                { id: 'c', text: 'three', refs: [] },
            ]}
            onSteps={onSteps}
        />);

        // The grip is deliberately the ONLY activator (setActivatorNodeRef): the card
        // contains a textarea, and dnd-kit refuses a start that comes from another
        // element. Hence the grip of card 1, and not the card itself.
        const grip = within(screen.getAllByTestId('skill-step')[0]).getByTestId('skill-step-grip');
        grip.focus();
        fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
        await settle();
        fireEvent.keyDown(grip, { key: 'ArrowDown', code: 'ArrowDown' });
        await settle();
        fireEvent.keyDown(grip, { key: 'ArrowDown', code: 'ArrowDown' });
        await settle();
        fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
        await settle();

        expect(onSteps).toHaveBeenCalledTimes(1);
        expect(onSteps.mock.calls.at(-1)[0].map(s => s.id)).toEqual(['b', 'c', 'a']);
    });

    /**
     * Escape leaves the list as it was. Without this test, a “cancel” that nevertheless
     * saved would look the same as a successful reorder — and with keyboard operation,
     * cancelling is precisely the way out of a grip you started by accident.
     */
    it('leaves the order alone when the keyboard drag is cancelled', async () => {
        const onSteps = vi.fn();
        measureCardsAsAStack();
        render(<Harness
            initial={[{ id: 'a', text: 'one', refs: [] }, { id: 'b', text: 'two', refs: [] }]}
            onSteps={onSteps}
        />);

        const grip = within(screen.getAllByTestId('skill-step')[0]).getByTestId('skill-step-grip');
        grip.focus();
        fireEvent.keyDown(grip, { key: ' ', code: 'Space' });
        await settle();
        // First establish that there IS something to cancel. Without this, this test
        // stays green if the whole keyboard operation disappears: it only holds that
        // NOTHING happened, and if nothing CAN happen, that is automatically true.
        // dnd-kit's live region (aria-live, not the static instruction text) announces
        // the grip as soon as a sensor picks it up; without a KeyboardSensor that
        // region stays empty and this test falls over.
        const announced = () => [...document.querySelectorAll('[aria-live]')]
            .map(el => el.textContent).join(' ');
        expect(announced(), 'de greep is niet opgepakt — er valt niets af te breken')
            .toMatch(/Draggable item/i);
        fireEvent.keyDown(grip, { key: 'ArrowDown', code: 'ArrowDown' });
        await settle();
        fireEvent.keyDown(grip, { key: 'Escape', code: 'Escape' });
        await settle();

        expect(onSteps).not.toHaveBeenCalled();
        expect(screen.getAllByTestId('skill-step').map(el => el.getAttribute('data-step-id')))
            .toEqual(['a', 'b']);
    });

    it('names the drag handle per card, so the grip says WHICH step it moves', () => {
        render(<Harness initial={[{ id: 'a', text: 'one', refs: [] }, { id: 'b', text: 'two', refs: [] }]} />);
        expect(screen.getByRole('button', { name: 'Reorder step 1' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Reorder step 2' })).toBeTruthy();
    });

    it('picks a reference from what exists — never free text — and shows its name', async () => {
        const user = userEvent.setup();
        const onSteps = vi.fn();
        render(<Harness initial={[{ id: 'a', text: 'Fetch it', refs: [] }]} onSteps={onSteps} />);
        await user.click(screen.getByTestId('skill-step-ref-add'));
        await user.click(screen.getByRole('menuitem', { name: /Look up quote status/ }));
        const [next] = onSteps.mock.calls.at(-1);
        expect(next[0].refs).toEqual([{ kind: 'automation', id: 'a1' }]);
    });

    it('does not offer a reference the step already carries', async () => {
        const user = userEvent.setup();
        render(<Harness initial={[{ id: 'a', text: 'x', refs: [{ kind: 'kb', id: 'k1' }] }]} />);
        await user.click(screen.getByTestId('skill-step-ref-add'));
        expect(screen.queryByRole('menuitem', { name: /Quote terms/ })).toBeNull();
        expect(screen.getByRole('menuitem', { name: /Pricelist/ })).toBeTruthy();
    });

    /**
     * ── THREE ANSWERS, NOT TWO ───────────────────────────────────────
     * This test sent `refOptions={{}}` and nothing else. Three empty arrays cannot
     * distinguish “read and empty” from “never read”, so it pinned the wrong
     * behaviour: the menu claimed the organisation had nothing to refer to, even when
     * the lists had never been read. A `table` ref is a real grant (datatable_query),
     * so whoever gets that message walks away from a grant he needs.
     */
    it('offers nothing to reference only when the lists were READ and are empty', async () => {
        const user = userEvent.setup();
        render(<Harness initial={[{ id: 'a', text: 'x', refs: [] }]} refOptions={{}} listStatus={LISTS_READ} />);
        await user.click(screen.getByTestId('skill-step-ref-add'));
        expect(screen.getByTestId('skill-ref-none').textContent).toMatch(/Nothing to reference yet/);
        expect(screen.queryByTestId('skill-ref-unread')).toBeNull();
    });

    it('says it is still asking before the first answer — not "nothing to reference"', async () => {
        const user = userEvent.setup();
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [] }]}
            refOptions={{}}
            listStatus={{ loaded: false, unavailable: [] }}
        />);
        await user.click(screen.getByTestId('skill-step-ref-add'));
        expect(screen.getByTestId('skill-ref-loading')).toBeTruthy();
        expect(screen.queryByTestId('skill-ref-none')).toBeNull();
        expect(screen.queryByText(/Nothing to reference yet/)).toBeNull();
    });

    it('names the lists it could not read, and offers to ask again', async () => {
        const user = userEvent.setup();
        const reload = vi.fn();
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [] }]}
            refOptions={{}}
            listStatus={{ loaded: true, unavailable: ['automations', 'kbs', 'tables'], reload }}
        />);
        await user.click(screen.getByTestId('skill-step-ref-add'));
        const note = screen.getByTestId('skill-ref-unread');
        expect(note.getAttribute('role')).toBe('status');
        expect(note.textContent).toMatch(/Could not be read/);
        expect(note.textContent).toMatch(/Automations/);
        expect(note.textContent).toMatch(/Knowledge bases/);
        expect(note.textContent).toMatch(/Tables/);
        expect(screen.queryByTestId('skill-ref-none')).toBeNull();
        await user.click(screen.getByTestId('skill-ref-retry'));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    /**
     * The silent variant: one list fails, the other two come in. The Automations group
     * then vanished without a trace (an empty group is filtered out) while Tables
     * remained — which reads as “this organisation has no automations”.
     */
    it('keeps the lists that DID arrive and still names the one that did not', async () => {
        const user = userEvent.setup();
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [] }]}
            refOptions={{ automation: [], kb: [], table: REF_OPTIONS.table }}
            listStatus={{ loaded: true, unavailable: ['automations'] }}
        />);
        await user.click(screen.getByTestId('skill-step-ref-add'));
        expect(screen.getByRole('menuitem', { name: /Pricelist/ })).toBeTruthy();
        expect(screen.getByTestId('skill-ref-unread').textContent).toMatch(/Automations/);
        expect(screen.getByTestId('skill-ref-unread').textContent).not.toMatch(/Tables/);
        expect(screen.queryByTestId('skill-ref-none')).toBeNull();
    });

    it('shows a reference by its bare id when the referenced thing is gone', () => {
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [{ kind: 'table', id: 'deleted-table' }] }]}
        />);
        expect(screen.getByText('deleted-table')).toBeTruthy();
    });

    /**
     * The pill used to be a <button> unconditionally, and nothing ever
     * passed `onOpenRef` — so every reference in every step was a control
     * that swallowed a click and did nothing. A control that does nothing is
     * worse than no control: it teaches that the app is broken.
     */
    it('opens the referenced thing when there is somewhere to go', async () => {
        const user = userEvent.setup();
        const onOpenRef = vi.fn();
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [{ kind: 'table', id: 't1' }] }]}
            onOpenRef={onOpenRef}
        />);
        await user.click(screen.getByRole('button', { name: 'Pricelist' }));
        expect(onOpenRef).toHaveBeenCalledWith({ kind: 'table', id: 't1' });
    });

    it('is plain text, not a dead button, when there is nowhere to go', () => {
        render(<Harness initial={[{ id: 'a', text: 'x', refs: [{ kind: 'table', id: 't1' }] }]} />);
        expect(screen.getByText('Pricelist')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Pricelist' })).toBeNull();
    });

    it('still opens a reference for a read-only viewer — looking is not editing', async () => {
        const user = userEvent.setup();
        const onOpenRef = vi.fn();
        render(<Harness
            initial={[{ id: 'a', text: 'x', refs: [{ kind: 'kb', id: 'k1' }] }]}
            onOpenRef={onOpenRef}
            readOnly
        />);
        await user.click(screen.getByRole('button', { name: 'Quote terms' }));
        expect(onOpenRef).toHaveBeenCalledWith({ kind: 'kb', id: 'k1' });
        expect(screen.queryByRole('button', { name: /Remove reference/i })).toBeNull();
    });

    it('gives a read-only viewer no add, no remove, no grip and no ref picker', () => {
        render(<Harness initial={[{ id: 'a', text: 'x', refs: [{ kind: 'kb', id: 'k1' }] }]} readOnly />);
        expect(screen.queryByTestId('skill-step-add')).toBeNull();
        expect(screen.queryByTestId('skill-step-grip')).toBeNull();
        expect(screen.queryByTestId('skill-step-ref-add')).toBeNull();
        expect(screen.queryByRole('button', { name: /Remove step/i })).toBeNull();
    });
});

describe('rules', () => {
    it('adds a rule that defaults to "always", not to a negation', async () => {
        const user = userEvent.setup();
        const onRules = vi.fn();
        render(<RulesHarness onRules={onRules} />);
        await user.click(screen.getByTestId('skill-rule-add'));
        expect(onRules.mock.calls.at(-1)[0][0].polarity).toBe('must');
    });

    it('flips polarity from the mark that shows it, in both directions', async () => {
        const user = userEvent.setup();
        const onRules = vi.fn();
        render(<RulesHarness
            initial={[{ id: 'r1', polarity: 'must', text: 'Answer in the language of the question.' }]}
            onRules={onRules}
        />);
        await user.click(screen.getByTestId('skill-rule-polarity'));
        expect(onRules.mock.calls.at(-1)[0][0].polarity).toBe('never');
        await user.click(screen.getByTestId('skill-rule-polarity'));
        expect(onRules.mock.calls.at(-1)[0][0].polarity).toBe('must');
    });

    it('names the flip by what it will DO, not by what the rule currently is', () => {
        render(<RulesHarness initial={[{ id: 'r1', polarity: 'never', text: 'x' }]} />);
        expect(screen.getByTestId('skill-rule-polarity').getAttribute('aria-label'))
            .toBe('Change to “always do this”');
    });

    it('leaves a read-only viewer the state but not the control', () => {
        render(<RulesHarness initial={[{ id: 'r1', polarity: 'never', text: 'x' }]} readOnly />);
        expect(screen.getByTestId('skill-rule-polarity').getAttribute('aria-label')).toBe('Never');
        expect(screen.getByTestId('skill-rule-polarity').disabled).toBe(true);
        expect(screen.queryByTestId('skill-rule-add')).toBeNull();
    });

    it('removes the rule that was asked for, by id', async () => {
        const user = userEvent.setup();
        const onRules = vi.fn();
        render(<RulesHarness
            initial={[{ id: 'r1', polarity: 'must', text: 'a' }, { id: 'r2', polarity: 'never', text: 'b' }]}
            onRules={onRules}
        />);
        const rows = screen.getAllByTestId('skill-rule');
        await user.click(within(rows[1]).getByRole('button', { name: /Remove rule/i }));
        expect(onRules.mock.calls.at(-1)[0].map(r => r.id)).toEqual(['r1']);
    });
});
