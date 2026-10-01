/**
 * REGRESSION (confirmed bug "BindingField's focus handle captures stale text
 * and mode, so Comes-in clicks use outdated state"): the handle was a
 * closure made at focus time. A field focused while empty, then typed into,
 * still answered "empty" when a value was clicked, and the typed text was
 * replaced. The registry reads each field through getLatest(), at the moment
 * the value arrives.
 */
import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
    SlotRegistryContext, createSlotRegistry, useRegisterSlot, useSlotRegistry, useSlotRegistryContext,
    type SlotHandle, type SlotRegistry,
} from './useSlotRegistry';
import type { DraggedSource } from './slotDnd';

const VALUE: DraggedSource = { source: { root: 'trigger', path: ['email'] } };

/** A text field that, like the old one, decides on arrival whether it is empty. */
function Field({ id, label, required = false }: { id: string; label: string; required?: boolean }) {
    const registry = useSlotRegistryContext();
    const [text, setText] = useState('');
    const [received, setReceived] = useState<string | null>(null);
    const handle: SlotHandle = {
        id,
        label,
        required,
        isEmpty: () => text.trim() === '',
        // Empty: the value replaces; typed text: the value joins it.
        accept: (v) => setReceived(text.trim() === '' ? `replace:${v.source.path.join('.')}` : `keep:${text}`),
    };
    const { onFocus } = useRegisterSlot(registry, handle);
    return (
        <label>
            {label}
            <input aria-label={label} value={text} onFocus={onFocus} onChange={(e) => setText(e.target.value)} />
            {received && <output>{received}</output>}
        </label>
    );
}

function Form({ onRegistry, children }: { onRegistry: (r: SlotRegistry) => void; children: React.ReactNode }) {
    const registry = useSlotRegistry();
    onRegistry(registry);
    return <SlotRegistryContext.Provider value={registry}>{children}</SlotRegistryContext.Provider>;
}

function setup() {
    let registry: SlotRegistry | null = null;
    const utils = render(
        <Form onRegistry={(r) => { registry = r; }}>
            <Field id="subject" label="Subject" />
            <Field id="to" label="To" required />
            <Field id="cc" label="Cc" />
        </Form>,
    );
    return { ...utils, registry: () => registry! };
}

describe('useSlotRegistry', () => {
    it('a value goes to the field as it is NOW, not as it was at focus time', async () => {
        const { registry } = setup();
        const subject = screen.getByLabelText('Subject');
        await userEvent.click(subject);
        await userEvent.type(subject, 'Re: ');
        expect(registry().active()?.isEmpty()).toBe(false);
        expect(registry().deliver(VALUE)).toBe(true);
        expect(await screen.findByText('keep:Re:')).toBeInTheDocument();
    });

    it('the field that last had focus is the active one', async () => {
        const { registry } = setup();
        expect(registry().active()).toBeNull();
        expect(registry().deliver(VALUE)).toBe(false);
        await userEvent.click(screen.getByLabelText('Cc'));
        expect(registry().active()?.id).toBe('cc');
        await userEvent.click(screen.getByLabelText('To'));
        expect(registry().active()?.id).toBe('to');
        registry().clearFocus();
        expect(registry().active()).toBeNull();
    });

    it('emptySlots: the empty fields now, required first, then in form order', async () => {
        const { registry } = setup();
        expect(registry().emptySlots().map(s => s.id)).toEqual(['to', 'subject', 'cc']);
        await userEvent.type(screen.getByLabelText('Subject'), 'Hi');
        expect(registry().emptySlots().map(s => s.id)).toEqual(['to', 'cc']);
    });

    it('deliverTo puts the value in the chosen field and makes it the active one', async () => {
        const { registry } = setup();
        expect(registry().deliverTo('cc', VALUE)).toBe(true);
        expect(await screen.findByText('replace:email')).toBeInTheDocument();
        expect(registry().active()?.id).toBe('cc');
        expect(registry().deliverTo('nope', VALUE)).toBe(false);
    });

    it('an unmounted field is forgotten, and its focus with it', async () => {
        let registry: SlotRegistry | null = null;
        const { rerender } = render(<Form onRegistry={(r) => { registry = r; }}><Field id="to" label="To" /></Form>);
        await userEvent.click(screen.getByLabelText('To'));
        expect(registry!.active()?.id).toBe('to');
        rerender(<Form onRegistry={(r) => { registry = r; }}><span /></Form>);
        expect(registry!.active()).toBeNull();
        expect(registry!.emptySlots()).toEqual([]);
    });
});

describe('createSlotRegistry', () => {
    it('a later registration under the same key is not undone by the earlier one leaving', () => {
        const r = createSlotRegistry();
        const a = { id: 'x', label: 'A', isEmpty: () => true, accept: () => {} };
        const b = { ...a, label: 'B' };
        const offA = r.register('x', () => a);
        r.register('x', () => b);
        offA();
        expect(r.emptySlots().map(s => s.label)).toEqual(['B']);
    });

    it('focus on a key nobody registered is ignored', () => {
        const r = createSlotRegistry();
        r.focus('ghost');
        expect(r.active()).toBeNull();
    });
});
