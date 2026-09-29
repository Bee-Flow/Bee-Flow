import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import SettingsForm from './SettingsForm';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import scopedStorage from '../../../../utils/scopedStorage';

/**
 * "1 field still empty" — the footer pill (artboard 2b).
 *
 * It is the INVERSE of boundPaths over the slots a step DECLARES, so the two
 * things worth pinning are the silences: a step with nothing wrong says
 * nothing, and a tool's optional parameters are not counted. A pill that reads
 * "31 fields still empty" on a freshly added step is a pill people learn to
 * ignore — and then the one that says "1" does not stop anybody either.
 */
const noIssues = { errors: [], warnings: [] };

function renderForm(step, { catalog = null } = {}) {
    const onPatch = vi.fn();
    render(
        <VariablePickerProvider groups={[]} previewSample={null} stepLabelById={new Map()}>
            <SettingsForm
                step={step} modelTiers={{}} stepIssues={noIssues}
                saving={false} saveError={null} onPatch={onPatch}
                catalog={catalog} groups={[]}
            />
        </VariablePickerProvider>,
    );
    return { onPatch };
}

const CATALOG = {
    apps: [{
        id: 'gmail',
        actions: [{
            name: 'gmail_send',
            inputSchema: {
                type: 'object',
                required: ['to', 'subject'],
                properties: { to: { type: 'string' }, subject: { type: 'string' }, cc: { type: 'string' } },
            },
        }],
    }],
};

describe('SettingsForm — the "still empty" footer pill', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    it('says nothing at all when no declared slot is empty', () => {
        renderForm({ id: 's1', type: 'set', label: 'Edit', fields: { name: 'Ada' } });
        expect(screen.queryByTestId('settings-empty-slots')).toBeNull();
    });

    it('counts one empty declared field in the singular', () => {
        renderForm({ id: 's1', type: 'set', label: 'Edit', fields: { name: '' } });
        expect(screen.getByTestId('settings-empty-slots').textContent).toBe('1 field still empty');
    });

    it('counts several in the plural, and names them in the tooltip', () => {
        renderForm({ id: 's1', type: 'set', label: 'Edit', fields: { name: '', city: '' } });
        const pill = screen.getByTestId('settings-empty-slots');
        expect(pill.textContent).toBe('2 fields still empty');
        expect(pill.getAttribute('title')).toContain('name');
        expect(pill.getAttribute('title')).toContain('city');
    });

    it('counts a REQUIRED tool parameter nobody has touched — it leaves no trace in the step', () => {
        // ToolInputForm deletes a cleared tool param, so an unfilled required
        // parameter is absent from `inputs` entirely. Counting only the keys
        // present would make the pill silent on exactly the step that cannot run.
        renderForm({ id: 's1', type: 'integration_action', label: 'Send', appId: 'gmail', tool: 'gmail_send', inputs: {} }, { catalog: CATALOG });
        expect(screen.getByTestId('settings-empty-slots').textContent).toBe('2 fields still empty');
    });

    it('does NOT count optional tool parameters', () => {
        // `cc` is in the schema and not in `inputs`. Thirty optional parameters
        // are not thirty empty fields.
        renderForm({
            id: 's1', type: 'integration_action', label: 'Send', appId: 'gmail', tool: 'gmail_send',
            inputs: { to: 'a@b.nl', subject: 'Hi' },
        }, { catalog: CATALOG });
        expect(screen.queryByTestId('settings-empty-slots')).toBeNull();
    });

    it('updates while you type, not after a save', () => {
        // The count is read off the live DRAFT. Reading the saved step instead
        // would leave the pill claiming "1 field still empty" over a field the
        // user just filled in.
        renderForm({ id: 's1', type: 'set', label: '', fields: { name: '' } });
        expect(screen.getByTestId('settings-empty-slots').textContent).toBe('1 field still empty');
        const label = screen.getByDisplayValue('');
        fireEvent.change(label, { target: { value: 'Renamed' } });
        // The label is not a declared slot, so the count is unchanged — but the
        // pill re-rendered off the draft rather than going stale or vanishing.
        expect(screen.getByTestId('settings-empty-slots').textContent).toBe('1 field still empty');
    });
});

describe('SettingsForm — when the tool\'s parameter list is missing', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    // The catalog is what makes this count COMPLETE for a tool step: a
    // required parameter nobody has touched leaves no trace in the definition
    // (ToolInputForm deletes a cleared one), so without the schema the pill is
    // counting only the keys that happen to be written down. Both fetch sites
    // are fire-and-forget `.catch(() => {})`, so a 401 or one bad response
    // leaves `catalog` null for the rest of the session — this is a state the
    // user reaches without doing anything wrong.
    const GMAIL = (inputs) => ({ id: 's1', type: 'integration_action', label: 'Send', appId: 'gmail', tool: 'gmail_send', inputs });

    it('says "cannot check" rather than a number it cannot stand behind', () => {
        renderForm(GMAIL({ body: { kind: 'literal', value: '' } }), { catalog: null });
        expect(screen.queryByTestId('settings-empty-slots')).toBeNull();
        expect(screen.getByTestId('settings-empty-slots-unknown').textContent).toBe('Cannot check the fields');
    });

    it('is LOUDER, not quieter, on the step it knows least about', () => {
        // The dangerous shape: an untouched Gmail step carries no `inputs` at
        // all, so with the schema missing the count is zero and the pill used
        // to be ABSENT — indistinguishable, on screen, from a step where
        // everything is filled in. "Unknown" must never render as "fine".
        renderForm(GMAIL(undefined), { catalog: null });
        expect(screen.queryByTestId('settings-empty-slots')).toBeNull();
        expect(screen.getByTestId('settings-empty-slots-unknown')).not.toBeNull();
    });

    it('a catalog that simply does not carry this tool is just as unknown', () => {
        // Not only a failed fetch: a catalog loaded from an org that has no
        // Gmail app answers `action: null` the same way, and the Inputs editor
        // above degrades to generic key/value rows. The footer agrees with it.
        renderForm(GMAIL({ body: { kind: 'literal', value: '' } }), { catalog: { apps: [] } });
        expect(screen.getByTestId('settings-empty-slots-unknown')).not.toBeNull();
    });

    it('goes back to counting the moment the schema is there', () => {
        // The same step, the same emptiness, with the catalog present: three
        // required parameters, none of them filled.
        renderForm(GMAIL(undefined), { catalog: CATALOG });
        expect(screen.queryByTestId('settings-empty-slots-unknown')).toBeNull();
        expect(screen.getByTestId('settings-empty-slots').textContent).toBe('2 fields still empty');
    });

    it('a step with no tool has no schema to miss — it is never "unknown"', () => {
        renderForm({ id: 's1', type: 'set', label: 'Edit', fields: { name: '' } }, { catalog: null });
        expect(screen.queryByTestId('settings-empty-slots-unknown')).toBeNull();
        expect(screen.getByTestId('settings-empty-slots').textContent).toBe('1 field still empty');
    });
});
