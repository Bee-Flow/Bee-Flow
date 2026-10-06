import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import SettingsForm from './SettingsForm';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import scopedStorage from '../../../../utils/scopedStorage';

/**
 * The Gmail case: "Read attachment" runs once per read mail (loop.result),
 * each mail holds a list of attachments. Auto-map must fill attachmentId by
 * running the step per attachment; messageId keeps reading the MAIL, which
 * stays bound as the attachment's outer item (`forEach.parents`, see
 * deepenForEach.ts). Values fictional.
 */
const noIssues = { errors: [], warnings: [] };
const CATALOG = {
    apps: [{
        id: 'gmail',
        actions: [{
            name: 'gmail_read_attachment',
            inputSchema: {
                type: 'object',
                required: ['messageId', 'attachmentId'],
                properties: { messageId: { type: 'string' }, attachmentId: { type: 'string' }, filename: { type: 'string' } },
            },
        }],
    }],
};
const ITEM = {
    id: 'm1', subject: 'Je factuur',
    attachments: [{ filename: 'f.pdf', mimeType: 'application/pdf', attachmentId: 'a1', messageId: 'm1' }],
};
const GROUPS = [{
    id: 'read__foreach', label: 'Current item (result)', kind: 'loop', basePath: 'loop.result', sample: ITEM,
    fields: Object.entries(ITEM).map(([k, v]) => ({ key: k, path: `loop.result.${k}`, sample: v })),
}];
const STEP = {
    id: 'att', type: 'integration_action', label: 'Read attachment', tool: 'gmail_read_attachment',
    forEach: { overRef: 'steps.read.output.results[*].output', itemVar: 'result', maxIterations: 100 },
    inputs: { messageId: { kind: 'ref', path: 'loop.result.id' }, attachmentId: { kind: 'literal', value: '' } },
};

describe('SettingsForm — a list inside the item the step runs over', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    it('Auto-map runs the step per attachment and keeps messageId on the mail', async () => {
        const onPatch = vi.fn();
        render(
            <VariablePickerProvider groups={GROUPS} previewSample={{ loop: { result: ITEM } }} stepLabelById={new Map()}>
                <SettingsForm
                    step={STEP} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null}
                    onPatch={onPatch} catalog={CATALOG} groups={GROUPS} previewSample={{ loop: { result: ITEM } }}
                />
            </VariablePickerProvider>,
        );
        await userEvent.setup().click(screen.getByRole('button', { name: /Auto-map/ }));
        await waitFor(() => expect(onPatch).toHaveBeenCalled(), { timeout: 3000 });
        const patch = onPatch.mock.calls.at(-1)[0];
        expect(patch.forEach).toMatchObject({
            overRef: 'steps.read.output.results[*].output.attachments', itemVar: 'attachment',
            parents: [{ itemVar: 'result', overRef: 'steps.read.output.results[*].output' }],
        });
        expect(patch.inputs.attachmentId).toEqual({ kind: 'ref', path: 'loop.attachment.attachmentId' });
        // The mail's own id, bound per attachment to the mail it came from — not
        // a same-named field of the attachment that happens to match.
        expect(patch.inputs.messageId).toEqual({ kind: 'ref', path: 'loop.result.id' });
    });

    it('Auto-map never moves the step for a parameter that takes a list (as on the phone)', async () => {
        const listCatalog = { apps: [{ id: 'gmail', actions: [{
            name: 'gmail_read_attachment',
            inputSchema: {
                type: 'object', required: ['messageId', 'attachmentId'],
                properties: { messageId: { type: 'string' }, subject: { type: 'string' }, attachmentId: { type: 'array', items: { type: 'string' } } },
            },
        }] }] };
        const onPatch = vi.fn();
        render(
            <VariablePickerProvider groups={GROUPS} previewSample={{ loop: { result: ITEM } }} stepLabelById={new Map()}>
                <SettingsForm
                    step={STEP} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null}
                    onPatch={onPatch} catalog={listCatalog} groups={GROUPS} previewSample={{ loop: { result: ITEM } }}
                />
            </VariablePickerProvider>,
        );
        await userEvent.setup().click(screen.getByRole('button', { name: /Auto-map/ }));
        await waitFor(() => expect(onPatch).toHaveBeenCalled(), { timeout: 3000 });
        const patch = onPatch.mock.calls.at(-1)[0];
        // The one-value input is filled; the list parameter does not move the step.
        expect(patch.inputs.subject).toEqual({ kind: 'ref', path: 'loop.result.subject' });
        expect(patch.forEach).toBeUndefined();
        expect(patch.inputs.attachmentId?.path).toBeUndefined();
    });
});
