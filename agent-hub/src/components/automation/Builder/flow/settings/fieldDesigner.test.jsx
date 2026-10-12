import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import scopedStorage from '../../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';
import SettingsForm from '../SettingsForm';
import { applyBindingRename, nameProblem } from './fieldDesigner';
import { extractFormState, buildPatch } from './formState';

/**
 * The one field designer, seen from the three parameter-row editors that used
 * to hand-roll it: a flowlet's inputs, an agent tool's parameters, and a
 * Studio App trigger's inputs.
 *
 * What is pinned here is the RENAME PATH, because that is the reason the three
 * share a designer at all. Each of them used to write `set('params', …)` on
 * every character typed into the name box: `email` on the way to
 * `email_address` was stored as `e`, `em`, `ema` … and every step binding
 * `trigger.output.email` quietly started receiving nothing. That is the bug
 * `f9f81153` closed for approval questions; these three had it too.
 *
 * Every test below drives the real SettingsForm, not the designer in
 * isolation, because the claim is about the CALL SITES: each of the three has
 * to reach the shared path, and a component test of the designer alone would
 * have stayed green while a trigger editor kept its own copy.
 */

const noIssues = { errors: [], warnings: [] };

/** A trigger of a given kind with declared params — agent_call stores a schema. */
function trigger(kind, params) {
    const base = { id: 'trg', type: 'trigger', kind };
    if (kind !== 'agent_call') return { ...base, params };
    const properties = {};
    const required = [];
    for (const p of params) {
        properties[p.name] = { type: p.type || 'string', ...(p.description ? { description: p.description } : {}) };
        if (p.required) required.push(p.name);
    }
    return { ...base, parametersSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false } };
}

function renderForm(step, { onPatch = vi.fn(), onRenameField = null } = {}) {
    const utils = render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm
                step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null}
                onPatch={onPatch} catalog={null} groups={[]} onRenameField={onRenameField}
            />
        </VariablePickerProvider>,
    );
    return { onPatch, onRenameField, ...utils };
}

/** Type a new name and commit it the way a keyboard user does. */
function rename(to) {
    const box = screen.getByLabelText('Field 1 name');
    fireEvent.change(box, { target: { value: to } });
    fireEvent.keyDown(box, { key: 'Enter' });
    return box;
}

const PARAM_KINDS = ['layer_input', 'agent_call', 'app_trigger'];

/** Every describe below starts from the same clean, scoped storage. */
function freshPanel() {
    cleanup();
    scopedStorage.setCurrentUser('field-designer-test-user');
    // Private mode / blocked site data: the accordions then simply start on
    // their coded default, which is open for all three of these sections.
    try { localStorage.clear(); } catch { /* nothing to clear */ }
}

describe('the shared field designer — the rename path reaches all three editors', () => {
    beforeEach(freshPanel);

    it.each(PARAM_KINDS)('a %s parameter rename carries the whole automation with it', (kind) => {
        const onRenameField = vi.fn(() => 3);
        renderForm(trigger(kind, [{ name: 'email', type: 'string' }]), { onRenameField });

        rename('contact');

        // The host rewrites every ref, template and expression that pointed at
        // the old name, and says how many moved — "12 steps were repointed"
        // and "nothing pointed here yet" must not read the same.
        expect(onRenameField).toHaveBeenCalledWith('email', 'contact');
        expect(screen.getByText(/Renamed — 3 bindings in this automation now point at it\./)).toBeTruthy();
    });

    it.each(PARAM_KINDS)('a %s parameter is renamed once, on purpose, not per keystroke', (kind) => {
        const onRenameField = vi.fn(() => 0);
        renderForm(trigger(kind, [{ name: 'email', type: 'string' }]), { onRenameField });
        const box = screen.getByLabelText('Field 1 name');

        fireEvent.change(box, { target: { value: 'e' } });
        fireEvent.change(box, { target: { value: 'em' } });
        fireEvent.change(box, { target: { value: 'email_address' } });
        // Nothing has been renamed yet — `e` and `em` are not names the author
        // meant, and rewriting the automation to each of them in turn is exactly
        // how a binding walks away from the step that reads it.
        expect(onRenameField).not.toHaveBeenCalled();

        fireEvent.keyDown(box, { key: 'Enter' });
        expect(onRenameField).toHaveBeenCalledTimes(1);
        expect(onRenameField).toHaveBeenCalledWith('email', 'email_address');
    });

    it('commits on blur too, because clicking away is how most people leave a box', () => {
        const onRenameField = vi.fn(() => 1);
        renderForm(trigger('layer_input', [{ name: 'email', type: 'string' }]), { onRenameField });
        const box = screen.getByLabelText('Field 1 name');

        fireEvent.change(box, { target: { value: 'contact' } });
        fireEvent.blur(box);

        expect(onRenameField).toHaveBeenCalledWith('email', 'contact');
        expect(screen.getByText(/Renamed — 1 binding in this automation now points at it\./)).toBeTruthy();
    });

    it('does not nag about bindings a row it minted a moment ago cannot have', () => {
        renderForm(trigger('layer_input', []));
        fireEvent.click(screen.getByText('Add input'));

        // `input1` is the designer's own placeholder — nothing downstream can
        // be pointing at it, so naming the row is not a rename.
        expect(screen.getByLabelText('Field 1 name').value).toBe('input1');
        rename('email');
        expect(screen.queryByText(/still point at the old name/)).toBeNull();
    });

    it('mints a name no sibling already holds, instead of counting off the length', () => {
        renderForm(trigger('layer_input', [{ name: 'input1', type: 'string' }, { name: 'input2', type: 'string' }]));
        fireEvent.click(screen.getByText('Add input'));
        // Two rows already, so a length-based name mints `input3`; remove the
        // middle one and the next add would mint `input3` a second time — a
        // duplicate the server drops silently, taking the row with it.
        expect(screen.getByLabelText('Field 3 name').value).toBe('input3');

        fireEvent.click(screen.getAllByLabelText('Remove input')[0]);
        fireEvent.click(screen.getByText('Add input'));
        expect(screen.getByLabelText('Field 3 name').value).toBe('input4');
    });
});

describe('the shared field designer — the names it refuses', () => {
    beforeEach(freshPanel);

    it.each(PARAM_KINDS)('a %s name the server would refuse never reaches the automation', (kind) => {
        const onRenameField = vi.fn(() => 0);
        const { onPatch, unmount } = renderForm(trigger(kind, [{ name: 'email', type: 'string' }]), { onRenameField });

        rename('2nd');

        // PARAM_NAME_RE wants a letter first. Refused here, where the author
        // has a box to correct it in — not at save time, naming a string they
        // never typed.
        expect(screen.getByText(/Start with a letter; letters, digits and underscores only\./)).toBeTruthy();
        expect(onRenameField).not.toHaveBeenCalled();
        // Nothing was stored either, so the unmount flush has nothing to send.
        unmount();
        expect(onPatch).not.toHaveBeenCalled();
    });

    it.each(PARAM_KINDS)('a %s name a sibling already binds is refused, not silently dropped', (kind) => {
        const onRenameField = vi.fn(() => 0);
        const { onPatch, unmount } = renderForm(
            trigger(kind, [{ name: 'email', type: 'string' }, { name: 'phone', type: 'string' }]),
            { onRenameField },
        );

        rename('phone');

        // The server's normalizeFields keeps the FIRST of a duplicate pair and
        // drops the rest without a word, so the collision has to be refused
        // before the edit rather than discovered after it.
        expect(screen.getByText(/already binds that name/)).toBeTruthy();
        expect(onRenameField).not.toHaveBeenCalled();
        unmount();
        expect(onPatch).not.toHaveBeenCalled();
    });

    it('says the bindings stayed behind when there is no rewrite behind the box', () => {
        // No onRenameField: the host did not hand one down, so this editor can
        // see the declaration but not the steps that bind it.
        const { onPatch, unmount } = renderForm(trigger('layer_input', [{ name: 'email', type: 'string' }]));

        rename('contact');

        expect(screen.getByText(/Renamed here only — steps that bind “email” still point at the old name\./)).toBeTruthy();
        // The rename still lands on the declaration — a parameter has no label
        // to read instead, so a read-only name would make it unnameable.
        expect(screen.getByLabelText('Field 1 name').value).toBe('contact');
        unmount();
        expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({
            params: [{ name: 'contact', type: 'string', required: false }],
        }));
    });

    it.each(PARAM_KINDS)('flags a %s name already stored that the server will refuse', (kind) => {
        renderForm(trigger(kind, [{ name: '_x', type: 'string' }]));
        // An imported automation, an AI-authored declaration, or a row from
        // before this box existed. The author has to be able to SEE that
        // without touching it first.
        expect(screen.getByText(/must start with a letter/i)).toBeTruthy();
    });
});

describe('the shared field designer — what each editor keeps', () => {
    beforeEach(freshPanel);

    it('a flowlet input carries a description, and it goes BOTH ways', () => {
        // The box is the new half. The description was already persisted for a
        // flowlet input — stepContract.stepParams reads it and
        // CallContractFields renders it as the hint on the caller's row — it
        // simply had nowhere to be typed, which is a stored value nobody can
        // set, the mirror image of a control that does not save.
        renderForm(trigger('layer_input', [{ name: 'email', type: 'string', required: false, description: 'the sender' }]));
        const box = screen.getByDisplayValue('the sender');
        fireEvent.change(box, { target: { value: 'the reply-to' } });
        expect(screen.getByDisplayValue('the reply-to')).toBeTruthy();

        // …and the allow-lists in formState.js read it in both directions, so
        // flushNow finds a patch that differs from the baseline's and calls
        // the server.
        const step = { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'email', type: 'string', required: false, description: 'the sender' }] };
        const draft = extractFormState(step);
        expect(draft.params[0].description).toBe('the sender');
        const patch = buildPatch(step, { ...draft, params: [{ ...draft.params[0], description: 'the reply-to' }] });
        expect(patch.params).toEqual([{ name: 'email', type: 'string', required: false, description: 'the reply-to' }]);
    });

    it('keeps the Studio App type vocabulary, file included and in the server\'s order', () => {
        renderForm(trigger('app_trigger', [{ name: 'doc', type: 'file' }]));
        const options = [...screen.getByLabelText('Field 1 type').querySelectorAll('option')];
        expect(options.map(o => o.value)).toEqual(['string', 'number', 'boolean', 'array', 'object', 'file']);
        expect(options.map(o => o.textContent)).toContain('file (pdf / word / excel / image)');
    });

    it('keeps the flowlet and agent type vocabulary, which has no file in it', () => {
        renderForm(trigger('layer_input', [{ name: 'q', type: 'string' }]));
        expect([...screen.getByLabelText('Field 1 type').querySelectorAll('option')].map(o => o.value))
            .toEqual(['string', 'number', 'boolean', 'object', 'array']);
    });

    it('keeps the Studio App name filter: an identifier, typed or pasted', () => {
        renderForm(trigger('app_trigger', [{ name: 'doc', type: 'file' }]));
        const box = screen.getByLabelText('Field 1 name');
        fireEvent.change(box, { target: { value: 'klant naam-2' } });
        expect(box.value).toBe('klantnaam2');
    });
});

/**
 * The rename path itself. These are the refusals and the wording every editor
 * inherits by calling it, rather than by re-deriving them per editor — which
 * is how three of them ended up with none at all.
 */
describe('applyBindingRename — the shared decision', () => {
    it('does nothing at all when the name did not change', () => {
        const onRenameField = vi.fn();
        const out = applyBindingRename({ from: 'email', to: '  email  ', siblings: [], onRenameField });
        expect(out).toMatchObject({ ok: false, unchanged: true, name: 'email' });
        expect(onRenameField).not.toHaveBeenCalled();
    });

    it('refuses before it rewrites, so a refused rename leaves the declaration alone', () => {
        const onRenameField = vi.fn();
        expect(applyBindingRename({ from: 'a', to: '2b', onRenameField }).ok).toBe(false);
        expect(applyBindingRename({ from: 'a', to: 'b', siblings: [{ name: 'b' }], onRenameField }).ok).toBe(false);
        expect(onRenameField).not.toHaveBeenCalled();
    });

    it('words the collision in the caller\'s own vocabulary', () => {
        const out = applyBindingRename({
            from: 'a', to: 'b', siblings: [{ name: 'b' }],
            takenError: 'Another input on this flowlet already binds that name.',
        });
        expect(out.error).toBe('Another input on this flowlet already binds that name.');
    });

    it('counts in the singular when exactly one binding moved', () => {
        expect(applyBindingRename({ from: 'a', to: 'b', onRenameField: () => 1 }).note)
            .toBe('Renamed — 1 binding in this automation now points at it.');
        expect(applyBindingRename({ from: 'a', to: 'b', onRenameField: () => 2 }).note)
            .toBe('Renamed — 2 bindings in this automation now point at it.');
        expect(applyBindingRename({ from: 'a', to: 'b', onRenameField: () => 0 }).note)
            .toBe('Renamed. Nothing was pointing at it yet.');
    });

    it('stays quiet about orphaned bindings unless the caller asked to be told', () => {
        expect(applyBindingRename({ from: 'a', to: 'b' }).note).toBe('');
        expect(applyBindingRename({ from: 'a', to: 'b', orphanNote: true }).note)
            .toMatch(/steps that bind “a” still point at the old name/);
    });
});

describe('nameProblem — a stored name the server will not take', () => {
    it('says which rule a name broke, rather than one sentence for both', () => {
        expect(nameProblem('_x')).toMatch(/must start with a letter/);
        expect(nameProblem('2nd')).toMatch(/must start with a letter/);
        expect(nameProblem('klant-naam')).toBe('Letters, digits and underscores only.');
    });

    it('has nothing to say about a legal name, or about no name at all', () => {
        expect(nameProblem('klant_naam2')).toBeNull();
        expect(nameProblem('')).toBeNull();
        expect(nameProblem(undefined)).toBeNull();
    });
});
