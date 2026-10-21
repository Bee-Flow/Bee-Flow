import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import scopedStorage from '../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import { NODE_DEFS, nodeDefaultLabel } from './nodeDefs';
import SettingsFormJs from './SettingsForm';
import { buildPatch, extractFormState } from './settings/formState';

// A JS component: its props type from their defaults, looser than what it takes.
const SettingsForm = SettingsFormJs as unknown as React.FC<Record<string, unknown>>;

const GROUPS = [{
    id: 'read', label: 'Read table', kind: 'read_table', basePath: 'steps.read.output', hasRealData: false,
    sample: { table: { kind: 'table', tableId: 'dry-run', runId: null, name: 'Sheet1', columns: [], rowCount: 0, preview: [] } }, fields: [],
}];

function renderForm(step: Record<string, unknown>, onPatch = vi.fn()) {
    render(
        <VariablePickerProvider groups={GROUPS as never} previewSample={null} stepLabelById={new Map([['read', 'Read table']])} stepTypeById={new Map()}>
            <SettingsForm
                step={step} modelTiers={{}} stepIssues={{ errors: [], warnings: [] }} saving={false} saveError={null}
                onPatch={onPatch} catalog={{ apps: [] }} groups={GROUPS} previewSample={null} automation={{ id: 'auto1' }}
            />
        </VariablePickerProvider>,
    );
    return onPatch;
}

beforeEach(() => {
    scopedStorage.setCurrentUser('test-user');
    try { localStorage.clear(); } catch { /* storage blocked */ }
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the spreadsheet steps', () => {
    it('are named the way the AI builder names them', () => {
        expect(nodeDefaultLabel('read_table')).toBe('Read table');
        expect(nodeDefaultLabel('table')).toBe('Edit table');
        expect(NODE_DEFS.table.sectionKeys).toEqual(['config', 'output', 'advanced']);
        expect(NODE_DEFS.table.issueSections.map.ops).toBe('config');
        expect(NODE_DEFS.read_table.simpleSections).toEqual(['config']);
    });
});

describe('SettingsForm: table', () => {
    const STEP = { id: 'edit', type: 'table', label: 'Edit table', source: { kind: 'ref', path: 'steps.read.output.table' }, ops: [], expiresInDays: 7 };

    it('dispatches to the Edit table editor', async () => {
        renderForm(STEP);
        expect(await screen.findByRole('combobox', { name: 'Table to work on' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Add a step' })).toBeTruthy();
        expect(screen.getByText('Run the steps before this one once to see a preview.')).toBeTruthy();
    });

    it('saves the steps as a whole, and only what changed', async () => {
        const user = userEvent.setup();
        const onPatch = renderForm(STEP);
        await user.click(await screen.findByRole('button', { name: 'Add a step' }));
        await user.click(screen.getByRole('menuitem', { name: /Take a sample/ }));
        await waitFor(() => expect(onPatch).toHaveBeenCalled(), { timeout: 4000 });
        const patch = onPatch.mock.calls.at(-1)?.[0];
        expect(patch.ops).toEqual([{ id: 'op1', op: 'sample', enabled: true, mode: 'first', n: 100, percent: null, seed: 'sample' }]);
        expect(patch.source).toBeUndefined();
        expect(patch.expiresInDays).toBeUndefined();
    });
});

describe('SettingsForm: read_table', () => {
    const STEP = {
        id: 'read', type: 'read_table', label: 'Read table', source: { kind: 'ref', path: 'trigger.output.report' },
        sheets: 'all', headerRow: 1, provenanceSheet: 'auto', format: 'auto', delimiter: 'auto', skipHiddenSheets: true, expiresInDays: 7,
    };

    it('dispatches to the Read table editor', async () => {
        renderForm(STEP);
        expect(await screen.findByRole('radio', { name: 'All sheets' })).toBeTruthy();
        expect(screen.getByRole('spinbutton', { name: 'Row with the column names' })).toBeTruthy();
    });

    it('saves a change of sheets', async () => {
        const user = userEvent.setup();
        const onPatch = renderForm(STEP);
        await user.click(await screen.findByRole('radio', { name: 'The first sheet' }));
        await waitFor(() => expect(onPatch).toHaveBeenCalled(), { timeout: 4000 });
        const { icon: _icon, ...rest } = onPatch.mock.calls.at(-1)?.[0];
        expect(rest).toEqual({ sheets: 'first' });
    });
});

describe('the form draft of a table step', () => {
    it('round-trips: a stored step needs no change of its own', () => {
        const step = {
            id: 'edit', type: 'table', label: 'Edit table', source: { kind: 'ref', path: 'steps.read.output.table' }, expiresInDays: 7,
            ops: [{ id: 'op1', op: 'filter', enabled: true, match: 'all', rules: [{ column: 'A', test: 'equals', value: { kind: 'literal', value: 'x' } }], rulesFrom: null, rulesFromMatch: 'all', expr: null }],
        };
        // The icon is the one field every step type writes (null when none is set).
        expect(buildPatch(step, extractFormState(step))).toEqual({ icon: null });
    });

    it('replaces the operations wholesale and keeps run-per-item', () => {
        const step = { id: 'edit', type: 'table', label: 'Edit table', source: null, ops: [{ id: 'op1', op: 'sample', n: 5 }], expiresInDays: 7 };
        const draft = { ...extractFormState(step), ops: [{ id: 'op2', op: 'describe' }], forEach: { overRef: 'steps.list.output.items', itemVar: 'item' } };
        const patch = buildPatch(step, draft);
        expect(patch.ops).toEqual([{ id: 'op2', op: 'describe' }]);
        expect(patch.forEach).toMatchObject({ overRef: 'steps.list.output.items', itemVar: 'item' });
    });

    it('limits the days a table is kept to 1..90', () => {
        const step = { id: 'read', type: 'read_table', label: 'Read table' };
        expect(buildPatch(step, { ...extractFormState(step), expiresInDays: 500 }).expiresInDays).toBe(90);
        expect(buildPatch(step, { ...extractFormState(step), headerRow: 0 }).headerRow).toBe(1);
    });
});
