/**
 * What a key press means on the questions card. Pure, so the card only has to
 * carry the result out. The card handles keys on its root, which also sees the
 * keys typed in its own "Other" field: digits there are text, and a focused
 * button keeps its own Enter.
 */

export type QuestionKeyAction =
    | { type: 'leave-other' }
    | { type: 'next' }
    | { type: 'back' }
    | { type: 'pick'; index: number }
    | { type: 'focus-other' };

export interface QuestionKeyContext {
    key: string;
    shiftKey: boolean;
    /** Alt, Ctrl or Meta held: not ours (Alt+M is the work-mode shortcut). */
    modified: boolean;
    inOther: boolean;
    onButton: boolean;
    onTextarea: boolean;
    optionCount: number;
}

export function questionKeyAction(c: QuestionKeyContext): QuestionKeyAction | null {
    if (c.modified) return null;
    if (c.key === 'Escape') return c.inOther ? { type: 'leave-other' } : null;
    if (c.key === 'Enter') {
        if (c.onButton && !c.shiftKey) return null;                 // the button's own click
        return { type: c.shiftKey ? 'back' : 'next' };
    }
    if (c.inOther || c.onTextarea || !/^[1-9]$/.test(c.key)) return null;
    const n = Number(c.key);
    if (n <= c.optionCount) return { type: 'pick', index: n - 1 };
    return n === c.optionCount + 1 ? { type: 'focus-other' } : null;
}
