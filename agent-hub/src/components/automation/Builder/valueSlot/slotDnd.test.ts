/**
 * REGRESSION (confirmed bug "A plain-text drop is treated as a binding
 * path"): the old drop read text/plain as a fallback, so words dragged
 * inside a prompt were cancelled and stored as `{{some words}}`. A slot drop
 * reads only the structured source type.
 */
import { describe, it, expect, vi } from 'vitest';
import { SOURCE_MIME, isSourceDrag, onSourceDragOver, parseDraggedSource, readSourceDrop, startSourceDrag } from './slotDnd';

function transfer(data: Record<string, string>) {
    const store = new Map(Object.entries(data));
    return {
        get types() { return [...store.keys()]; },
        getData: (type: string) => store.get(type) ?? '',
        setData: (type: string, value: string) => { store.set(type, value); },
        effectAllowed: 'all',
        dropEffect: 'none',
    } as unknown as DataTransfer;
}
const event = (dataTransfer: DataTransfer) => ({ dataTransfer, preventDefault: vi.fn() });
const SOURCE = { root: 'trigger', path: ['Klant', 'E-mail adres'] };

describe('slotDnd', () => {
    it('a drag carries the structured source under its own type, and nothing as text', () => {
        const dt = transfer({});
        startSourceDrag(event(dt), { source: SOURCE as never, shape: 'single', groupLabel: 'Bestelling ontvangen' });
        expect(dt.types).toEqual([SOURCE_MIME]);
        expect(dt.effectAllowed).toBe('copy');
        const e = event(dt);
        expect(readSourceDrop(e)).toEqual({ source: SOURCE, shape: 'single', groupLabel: 'Bestelling ontvangen' });
        expect(e.preventDefault).toHaveBeenCalled();
    });

    it('a plain-text drop is not ours: no value, and the browser keeps its text move', () => {
        const e = event(transfer({ 'text/plain': 'some words' }));
        expect(isSourceDrag(e)).toBe(false);
        onSourceDragOver(e);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(readSourceDrop(e)).toBeNull();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('a path string in text/plain beside nothing else is still not a value', () => {
        const e = event(transfer({ 'text/plain': 'steps.s1.output.items' }));
        expect(readSourceDrop(e)).toBeNull();
    });

    it('dragover accepts a source drag', () => {
        const e = event(transfer({ [SOURCE_MIME]: JSON.stringify({ source: SOURCE }) }));
        onSourceDragOver(e);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(e.dataTransfer.dropEffect).toBe('copy');
    });

    it('a malformed or invalid payload is refused', () => {
        expect(parseDraggedSource('not json')).toBeNull();
        expect(parseDraggedSource(JSON.stringify({ source: { root: 'secrets', path: ['k'] } }))).toBeNull();
        expect(parseDraggedSource(JSON.stringify({ source: { root: 'steps', path: ['x'] } }))).toBeNull();
        expect(parseDraggedSource(JSON.stringify([1]))).toBeNull();
        expect(parseDraggedSource(JSON.stringify({ source: SOURCE, count: 'x', labelParts: 'y' }))).toEqual({ source: SOURCE });
    });
});
