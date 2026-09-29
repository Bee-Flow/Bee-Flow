/**
 * Clipped text a pointer can still recover.
 *
 * Spread onto whichever element carries `truncate` or a line clamp:
 *
 *   <span className="truncate" {...hoverable(name)}>{name}</span>
 *
 * WHY A HELPER RATHER THAN JUST TYPING title=. Because for two years it was
 * "just type title=", and the result was that seven of the runtime's twenty-odd
 * truncating components did and the rest did not — with no way to tell which,
 * and no reason behind the split. A file gallery let you hover a clipped
 * filename; the preview pane directly beside it, showing THE SAME filename,
 * did not.
 *
 * The rule this encodes: truncation is a layout decision, never an editorial
 * one. Clipping "MW2604-02-1100-001.step" to "MW2604-02-…" is fine as long as
 * the whole string is still available; it is only a bug when the rest is gone.
 *
 * It deliberately returns `undefined` rather than `{ title: '' }` for empty
 * input: an empty title attribute suppresses a parent's tooltip in some
 * browsers, which would make this worse than doing nothing.
 *
 * Its own file, not uiBits.jsx: that file exports components, and
 * react-refresh/only-export-components refuses a plain function beside them.
 */
export function hoverable(value: unknown): { title: string } | undefined {
    if (value === null || value === undefined) return undefined;
    const s = typeof value === 'string' ? value : String(value);
    return s.trim() ? { title: s } : undefined;
}
