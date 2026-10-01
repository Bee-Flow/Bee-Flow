import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';

const { state } = vi.hoisted(() => ({
    state: {
        preview: null as unknown,
        applied: null as unknown,
        applyStatus: 200,
        previewStatus: 200,
        calls: [] as Array<{ url: string; method: string; body: unknown }>,
    },
}));

vi.mock('../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url: string, opts: { method?: string; body?: string } = {}) => {
        state.calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
        if (url.endsWith('/upgrade-mappings?dryRun=1')) {
            return { ok: state.previewStatus < 400, status: state.previewStatus, json: async () => state.preview };
        }
        if (url.endsWith('/upgrade-mappings')) {
            return { ok: state.applyStatus < 400, status: state.applyStatus, json: async () => state.applied };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    }),
}));

import UpgradeMappingsDialog from './UpgradeMappingsDialog';

const CHANGED = [
    { stepId: 'mail', step: 'Mail klant', field: 'inputs.to', kind: 'ref', take: 'one', root: 'trigger', source: null, label: 'Klant › E-mail adres' },
    { stepId: 'each', step: 'Per order', field: 'forEach', kind: 'for_each', take: 'each', root: 'steps', source: 'Orders ophalen', label: 'Orders' },
    { stepId: 'each', step: 'Per order', field: 'inputs.values.Datum', kind: 'ref', take: 'each', root: 'steps', source: 'Orders ophalen', label: 'Datum' },
];
const KEPT = [
    { stepId: 'mail', step: 'Mail klant', field: 'inputs.sku', kind: 'ref', reason: 'would_change', root: 'steps', source: 'Orders ophalen', label: 'Orders › ID' },
    { stepId: 'mail', step: null, field: 'inputs.body', kind: 'expr', reason: 'formula' },
];
const PREVIEW = { dryRun: true, saved: false, version: 4, changed: CHANGED, kept: KEPT, counts: { changed: 3, kept: 2 }, evidence: { lastRun: true, sample: false } };
const ROW = { id: 'a1', title: 'Orders', version: 5, definition: { steps: [] } };

function dialog() {
    const onApplied = vi.fn();
    const onClose = vi.fn();
    render(withQueryClient(<UpgradeMappingsDialog open automationId="a1" onClose={onClose} onApplied={onApplied} />));
    return { onApplied, onClose };
}

const dryRuns = () => state.calls.filter(c => c.url.endsWith('?dryRun=1')).length;
const applies = () => state.calls.filter(c => c.url.endsWith('/upgrade-mappings'));

describe('UpgradeMappingsDialog', () => {
    beforeEach(() => {
        state.calls.length = 0;
        state.preview = PREVIEW;
        state.applied = { ...PREVIEW, dryRun: false, saved: true, version: 5, automation: ROW };
        state.applyStatus = 200;
        state.previewStatus = 200;
    });

    it('shows the dry run first: the summary, what moves and what stays, and why; nothing is written', async () => {
        dialog();
        const d = await screen.findByRole('dialog', { name: 'Update mappings' });
        expect(await within(d).findByText('3 field(s) can be updated, 2 stay a Formula')).toBeInTheDocument();
        const changed = within(d).getAllByTestId('upgrade-changed');
        expect(changed).toHaveLength(3);
        expect(changed[0]).toHaveTextContent('Mail klant');
        expect(changed[0]).toHaveTextContent('· To');
        expect(changed[0]).toHaveTextContent('Incoming data › Klant › E-mail adres');
        expect(changed[1]).toHaveTextContent('Runs separately for each item of Orders ophalen › Orders');
        expect(changed[2]).toHaveTextContent('Orders ophalen › Datum (of this item)');
        const kept = within(d).getAllByTestId('upgrade-kept');
        expect(kept[0]).toHaveTextContent('The last run would give a different result');
        expect(kept[1]).toHaveTextContent('Step mail');
        expect(kept[1]).toHaveTextContent('A formula');
        // No path, bracket or `[*]` reaches the person.
        expect(d.textContent).not.toMatch(/steps\.|\[\*\]|inputs\./);
        expect(dryRuns()).toBe(1);
        expect(applies()).toHaveLength(0);
    });

    it('applies what the preview showed, for the version it was of, and hands back the saved row', async () => {
        const user = userEvent.setup();
        const { onApplied } = dialog();
        const apply = await screen.findByRole('button', { name: 'Update 3 field(s)' });
        await user.click(apply);
        expect(await screen.findByText('3 field(s) updated, 2 stay a Formula')).toBeInTheDocument();
        expect(screen.getByText('Updated')).toBeInTheDocument();
        expect(applies()).toEqual([{ url: '/api/automation/a1/upgrade-mappings', method: 'POST', body: { version: 4 } }]);
        expect(onApplied).toHaveBeenCalledWith(ROW);
        expect(screen.queryByRole('button', { name: /Update \d/ })).not.toBeInTheDocument();
        // The footer's Close, beside the header's X.
        expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);
    });

    it('a routine saved since the preview: says so, checks again, applies nothing', async () => {
        const user = userEvent.setup();
        state.applyStatus = 409;
        state.applied = { error: 'This routine changed since the preview.', code: 'version_changed' };
        const { onApplied } = dialog();
        await user.click(await screen.findByRole('button', { name: 'Update 3 field(s)' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('This automation changed after the check');
        await vi.waitFor(() => expect(dryRuns()).toBe(2));
        expect(onApplied).not.toHaveBeenCalled();
    });

    it('a refused apply shows the server\'s sentence', async () => {
        const user = userEvent.setup();
        state.applyStatus = 400;
        state.applied = { error: 'The updated mappings did not pass the checks, so nothing was changed.', code: 'invalid_definition' };
        dialog();
        await user.click(await screen.findByRole('button', { name: 'Update 3 field(s)' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('did not pass the checks');
    });

    it('without a run to compare with: says so, and there is nothing to apply', async () => {
        state.preview = { ...PREVIEW, changed: [], kept: [{ ...KEPT[0], reason: 'no_evidence' }], evidence: { lastRun: false, sample: false } };
        dialog();
        expect(await screen.findByText('0 field(s) can be updated, 1 stay a Formula')).toBeInTheDocument();
        expect(screen.getByText(/There is no run or pinned example to compare with yet/)).toBeInTheDocument();
        expect(screen.getByText('No run or example shows this value yet')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Update 0 field(s)' })).toBeDisabled();
    });

    it('a check that fails says so, and cannot be applied', async () => {
        state.previewStatus = 500;
        state.preview = { error: 'boom' };
        dialog();
        expect(await screen.findByText('Bee could not check the mappings right now.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Update 0 field(s)' })).toBeDisabled();
    });
});
