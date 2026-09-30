import { changeLabel, lastDoneIndex, undoLabel, undoStateOf, withUndo, type RefineTurn } from './refineTurns';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
    fallback.replace('{count}', String(params?.count ?? ''));

describe('refine turns', () => {
    it('words each change, singular and plural by key', () => {
        expect(changeLabel(t, { field: 'systemPrompt' })).toBe('Rewrote the instructions');
        expect(changeLabel(t, { field: 'apps', direction: 'added', count: 1 })).toBe('Turned on 1 app');
        expect(changeLabel(t, { field: 'apps', direction: 'removed', count: 2 })).toBe('Turned off 2 apps');
        expect(changeLabel(t, { field: 'skills', direction: 'added', count: 3 })).toBe('Attached 3 skills');
        expect(changeLabel(t, { field: 'knowledge', direction: 'removed', count: 1 })).toBe('Removed 1 knowledge base');
    });

    it('undoes one level deep and says why not otherwise', () => {
        const done = { undoVersionId: 'v1', undo: 'idle' as const };
        expect(undoStateOf(done, false)).toBe('idle');
        expect(undoStateOf(done, true)).toBe('superseded');
        expect(undoStateOf({ ...done, undoVersionId: null }, false)).toBe('unavailable');
        expect(undoStateOf({ ...done, undo: 'undone' }, true)).toBe('undone');
        expect(undoStateOf({ ...done, undo: 'failed' }, false)).toBe('idle');
        expect(undoLabel(t, 'unavailable')).toBe('Undo unavailable — no restore point was saved');
    });

    it('finds the newest Done turn and updates only that one', () => {
        const turns: RefineTurn[] = [
            { kind: 'user', text: 'a' },
            { kind: 'done', changes: [], undoVersionId: 'v1', undo: 'idle' },
            { kind: 'user', text: 'b' },
            { kind: 'done', changes: [], undoVersionId: 'v2', undo: 'idle' },
            { kind: 'error', text: 'x' },
        ];
        expect(lastDoneIndex(turns)).toBe(3);
        expect(lastDoneIndex([])).toBe(-1);
        const next = withUndo(turns, 3, 'busy');
        expect(next[3]).toMatchObject({ undo: 'busy' });
        expect(next[1]).toBe(turns[1]);
    });
});
