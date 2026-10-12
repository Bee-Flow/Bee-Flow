import { FLATTEN_MAIL_STEP, flattenMailRoot } from '@shared/expr/corpus.mjs';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import scopedStorage from '../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import { NODE_DEFS } from './nodeDefs';
import SettingsFormJs from './SettingsForm';

// A JS component: its props type from their defaults, looser than what it takes.
const SettingsForm = SettingsFormJs as unknown as React.FC<Record<string, unknown>>;

/** Invented Fabrikam invoice mails (corpus.mjs). */
const MAIL = flattenMailRoot();
const GROUPS = [{
    id: 'g_read_many', label: 'Read many', kind: 'integration_action', basePath: 'steps.g_read_many.output', hasRealData: true,
    sample: MAIL.steps.g_read_many.output,
    fields: [{ key: 'messages', path: 'steps.g_read_many.output.messages', sample: (MAIL.steps.g_read_many.output as { messages: unknown[] }).messages }],
}];

function renderForm(step: Record<string, unknown>, onPatch = vi.fn()) {
    render(
        <VariablePickerProvider groups={GROUPS} previewSample={MAIL} stepLabelById={new Map([['g_read_many', 'Read many']])} stepTypeById={new Map()}>
            <SettingsForm
                step={step} modelTiers={{}} stepIssues={{ errors: [], warnings: [] }} saving={false} saveError={null}
                onPatch={onPatch} catalog={{ apps: [] }} groups={GROUPS} previewSample={MAIL}
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

describe('SettingsForm: flatten', () => {
    it('declares a Simple config section and an Advanced more section', () => {
        expect(NODE_DEFS.flatten.sectionKeys).toEqual(['config', 'more']);
        expect(NODE_DEFS.flatten.simpleSections).toEqual(['config']);
        expect(NODE_DEFS.flatten.issueSections.map.keepEmpty).toBe('more');
    });

    it('dispatches to the flatten editor, with counts from the last run', () => {
        renderForm(FLATTEN_MAIL_STEP);
        expect(screen.getByText('One row per attachment')).toBeTruthy();
        expect(screen.getByText('64 attachments in 4 messages (last run)')).toBeTruthy();
    });

    it('saves the planned columns of a step opened without them', async () => {
        const onPatch = renderForm({ id: 'mf_flatten', type: 'flatten', label: 'One row per attachment', arrayRef: FLATTEN_MAIL_STEP.arrayRef });
        await waitFor(() => expect(onPatch).toHaveBeenCalled(), { timeout: 4000 });
        const patch = onPatch.mock.calls.at(-1)?.[0];
        expect(patch.parents).toEqual(FLATTEN_MAIL_STEP.parents);
        expect(patch.keepEmpty).toBe(false);
    });
});
