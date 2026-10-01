// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getBindingDropPath, onBindingDragOver, startPathDrag } from './bindingDnd';
import { SOURCE_MIME } from '../valueSlot/slotDnd';

const BINDING_MIME = 'application/x-binding-path';

function transfer(data: Record<string, string> = {}) {
    const store: Record<string, string> = { ...data };
    return {
        get types() { return Object.keys(store); },
        getData: (type: string) => store[type] ?? '',
        setData: (type: string, value: string) => { store[type] = value; },
        dropEffect: 'none',
        effectAllowed: 'all',
        store,
    };
}

const event = (dataTransfer: ReturnType<typeof transfer>) => ({ dataTransfer, preventDefault: vi.fn() });

// Confirmed bug: "A plain-text drop is treated as a binding path". Words
// dragged inside a prompt (or from another window) were inserted as a
// `{{some words}}` template that resolves to '' at run time.
describe('bindingDnd — only the two value types are read', () => {
    it('a plain-text drop is not a path, and the browser keeps its text move', () => {
        const e = event(transfer({ 'text/plain': 'some words' }));
        onBindingDragOver(e);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(getBindingDropPath(e)).toBeNull();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('reads the legacy path type', () => {
        const e = event(transfer({ [BINDING_MIME]: 'steps.s1.output.rows[*].email', 'text/plain': 'ignored' }));
        expect(getBindingDropPath(e)).toBe('steps.s1.output.rows[*].email');
        expect(e.preventDefault).toHaveBeenCalled();
    });

    it('reads a structured source when no legacy path came with it', () => {
        const source = { root: 'trigger', path: ['Klant', 'E-mail adres'] };
        const e = event(transfer({ [SOURCE_MIME]: JSON.stringify({ source }) }));
        onBindingDragOver(e);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(getBindingDropPath(e)).toBe('trigger.output.Klant["E-mail adres"]');
    });

    it('a drag publishes both types (and text/plain for plain inputs)', () => {
        const dt = transfer();
        startPathDrag({ dataTransfer: dt as unknown as DataTransfer }, 'steps.s1.output.items[*].email');
        expect(dt.store[BINDING_MIME]).toBe('steps.s1.output.items[*].email');
        expect(JSON.parse(dt.store[SOURCE_MIME]).source).toEqual({ root: 'steps', id: 's1', path: ['items', 'email'] });
        expect(dt.store['text/plain']).toBe('steps.s1.output.items[*].email');
        expect(dt.effectAllowed).toBe('copy');
    });

    it('a path that names no Source (an App Studio scope) is still a path drag', () => {
        const dt = transfer();
        startPathDrag({ dataTransfer: dt as unknown as DataTransfer }, 'currentUser.email');
        expect(dt.store[BINDING_MIME]).toBe('currentUser.email');
        expect(dt.store[SOURCE_MIME]).toBeUndefined();
    });
});
