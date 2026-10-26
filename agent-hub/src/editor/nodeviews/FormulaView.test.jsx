/**
 * FormulaView — the in-cell formula editor.
 *
 * The interesting part is the reference picker: clicking a cell while the input
 * is open must insert an A1 reference AT THE CARET, keep focus, and not commit
 * the formula (the click blurs the input). Getting any of those wrong makes the
 * editor feel broken in a way no engine test would catch.
 *
 * Run: cd agent-hub && npx vitest run src/editor/nodeviews/FormulaView.test.jsx
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import FormulaView from './FormulaView';

/** Minimal EditorView stand-in exposing just the bridge FormulaView uses. */
function fakeView() {
    const v = {
        refPick: null,
        updates: [],
        deleted: 0,
        beginRefPick(h) { v.refPick = h; },
        endRefPick() { v.refPick = null; },
        formulaTablePath: () => [0],
        resolveAtom: () => ({ inline: true, path: [0, 0, 0, 0], offset: 0 }),
        // Bridge calls report success (the real EditorView returns booleans);
        // a false return means the model op failed and the editor stays open.
        updateAtom: (_n, attrs) => { v.updates.push(attrs); return true; },
        deleteAtom: () => { v.deleted += 1; return true; },
        selectAtom: () => true,
    };
    return v;
}
const nodeWith = (src, extra = {}) => ({ type: 'formula', attrs: { src, ...extra } });
const input = () => screen.getByRole('textbox');
/** An existing formula shows its value until you double-click it. */
const openEditor = (displayText) => fireEvent.doubleClick(screen.getByText(displayText));

beforeEach(() => cleanup());

describe('opening', () => {
    it('opens straight into edit mode for a blank formula', () => {
        render(<FormulaView node={nodeWith('=')} view={fakeView()} editable />);
        expect(input().value).toBe('=');
    });

    it('shows the computed value when not editing', () => {
        render(<FormulaView node={nodeWith('=SUM(A1:A2)', { value: '42' })} view={fakeView()} editable />);
        expect(screen.queryByRole('textbox')).toBe(null);
        expect(screen.getByText('42')).toBeTruthy();
    });

    it('opens on double-click', () => {
        render(<FormulaView node={nodeWith('=A1', { value: '7' })} view={fakeView()} editable />);
        fireEvent.doubleClick(screen.getByText('7'));
        expect(input().value).toBe('=A1');
    });
});

describe('reference picking', () => {
    it('arms picking while the editor is open and disarms on commit', () => {
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        expect(view.refPick).toBeTruthy();
        expect(view.refPick.tablePath).toEqual([0]);
        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(view.refPick).toBe(null);
    });

    it('inserts the picked reference at the caret', () => {
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        act(() => view.refPick.onPick('B2'));
        expect(input().value).toBe('=B2');
    });

    it('a drag rewrites the same reference instead of appending one per move', () => {
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        act(() => view.refPick.onPick('B2'));
        act(() => view.refPick.onPick('B2:B3'));
        act(() => view.refPick.onPick('B2:C4'));
        expect(input().value).toBe('=B2:C4');
    });

    it('appends after an operator', () => {
        const view = fakeView();
        render(<FormulaView node={nodeWith('=A1+')} view={view} editable />);
        openEditor('=A1+');
        act(() => view.refPick.onPick('B2'));
        expect(input().value).toBe('=A1+B2');
    });

    it('replaces a trailing reference when the caret is not after an operator', () => {
        const view = fakeView();
        render(<FormulaView node={nodeWith('=A1')} view={view} editable />);
        openEditor('=A1');
        act(() => view.refPick.onPick('C3'));
        expect(input().value).toBe('=C3');
    });

    it('a separate gesture after a commit-pick appends again', async () => {
        const user = userEvent.setup();
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        act(() => view.refPick.onPick('A1'));
        act(() => view.refPick.onCommitPick());
        await user.clear(input());
        await user.type(input(), '=A1+');
        act(() => view.refPick.onPick('B2'));
        expect(input().value).toBe('=A1+B2');
    });

    it('the blur caused by a pick does not commit the formula', () => {
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        act(() => view.refPick.onPick('B2'));
        fireEvent.blur(input());
        expect(view.updates).toHaveLength(0);
        expect(view.deleted).toBe(0);
        expect(screen.queryByRole('textbox')).toBeTruthy();   // still open
    });

    it('a blur that is NOT a pick still commits', async () => {
        const user = userEvent.setup();
        const view = fakeView();
        render(<FormulaView node={nodeWith('=A1')} view={view} editable />);
        openEditor('=A1');
        await user.clear(input());
        await user.type(input(), '=A1*2');
        fireEvent.blur(input());
        expect(view.updates).toEqual([{ src: '=A1*2' }]);
    });

    // The orphaned-input repro (S2): a pick usually causes NO blur (the view
    // preventDefaults the cell mousedown), so mouseup's onCommitPick must
    // disarm the pick flag — otherwise it ate the NEXT real blur and the
    // floating input stayed open, uncommitted, forever.
    it('a blur AFTER the pick gesture completed commits exactly once', () => {
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        act(() => view.refPick.onPick('B3'));
        act(() => view.refPick.onCommitPick());   // mouseup — no blur happened
        fireEvent.blur(input());                  // clicking away later
        expect(view.updates).toEqual([{ src: '=B3' }]);
        expect(screen.queryByRole('textbox')).toBe(null);   // committed and closed
    });

    it('a keystroke after a pick re-enables blur-commit', () => {
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        act(() => view.refPick.onPick('B3'));     // pick flag armed, no blur yet
        fireEvent.keyDown(input(), { key: 'ArrowLeft' });   // user keeps editing
        fireEvent.blur(input());
        expect(view.updates).toEqual([{ src: '=B3' }]);
    });
});

describe('committing', () => {
    it('commits on Enter', async () => {
        const user = userEvent.setup();
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        await user.clear(input());
        await user.type(input(), '=SUM(A1:A3)');
        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(view.updates).toEqual([{ src: '=SUM(A1:A3)' }]);
    });

    it('commits on Tab', async () => {
        const user = userEvent.setup();
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        await user.clear(input());
        await user.type(input(), '=1+1');
        fireEvent.keyDown(input(), { key: 'Tab' });
        expect(view.updates).toEqual([{ src: '=1+1' }]);
    });

    it('adds the leading = when the user omits it', async () => {
        const user = userEvent.setup();
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        await user.clear(input());
        await user.type(input(), 'A1*2');
        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(view.updates).toEqual([{ src: '=A1*2' }]);
    });

    it('removes the atom when committed empty', () => {
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(view.deleted).toBe(1);
        expect(view.updates).toHaveLength(0);
    });

    it('Escape on a brand-new formula removes it', async () => {
        const user = userEvent.setup();
        const view = fakeView();
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        await user.clear(input());
        await user.type(input(), '=A1');
        fireEvent.keyDown(input(), { key: 'Escape' });
        expect(view.deleted).toBe(1);
        expect(view.updates).toHaveLength(0);
    });

    it('Escape on an existing formula reverts without changing it', async () => {
        const user = userEvent.setup();
        const view = fakeView();
        render(<FormulaView node={nodeWith('=A1', { value: '3' })} view={view} editable />);
        fireEvent.doubleClick(screen.getByText('3'));
        await user.clear(input());
        await user.type(input(), '=NONSENSE');
        fireEvent.keyDown(input(), { key: 'Escape' });
        expect(view.updates).toHaveLength(0);
        expect(view.deleted).toBe(0);
    });

    it('an unchanged formula is not re-written', () => {
        const view = fakeView();
        render(<FormulaView node={nodeWith('=A1', { value: '3' })} view={view} editable />);
        fireEvent.doubleClick(screen.getByText('3'));
        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(view.updates).toHaveLength(0);
    });

    // S5: the model op runs FIRST and the editor only closes on success —
    // closing first turned a failed bridge call into a dead read-only "=" chip.
    it('stays open when deleteAtom reports failure', () => {
        const view = fakeView();
        view.deleteAtom = () => false;
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        fireEvent.keyDown(input(), { key: 'Enter' });   // blank → delete → false
        expect(screen.queryByRole('textbox')).toBeTruthy();   // still open
    });

    it('stays open when updateAtom reports failure', async () => {
        const user = userEvent.setup();
        const view = fakeView();
        view.updateAtom = () => false;
        render(<FormulaView node={nodeWith('=')} view={view} editable />);
        await user.clear(input());
        await user.type(input(), '=1+1');
        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(screen.queryByRole('textbox')).toBeTruthy();
    });
});

describe('read-only', () => {
    it('never opens an input when not editable', () => {
        render(<FormulaView node={nodeWith('=A1', { value: '9' })} view={fakeView()} editable={false} />);
        fireEvent.doubleClick(screen.getByText('9'));
        expect(screen.queryByRole('textbox')).toBe(null);
    });
});
