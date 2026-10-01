// UpgradeMappingsDialog, M8b: the AI section. Asking is a click; what comes
// back is listed apart as checked; nothing of it is applied unless ticked;
// a suggestion the server no longer accepts drops them all and checks again.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';

const { state } = vi.hoisted(() => ({
    state: {
        preview: null as unknown,
        applied: null as unknown,
        aiFix: null as unknown,
        applyStatus: 200,
        aiStatus: 200,
        calls: [] as Array<{ url: string; body: unknown }>,
    },
}));

vi.mock('../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url: string, opts: { body?: string } = {}) => {
        state.calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
        const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
        if (url.endsWith('/upgrade-mappings?dryRun=1')) return reply(200, state.preview);
        if (url.endsWith('/upgrade-mappings/ai-fix')) return reply(state.aiStatus, state.aiFix);
        if (url.endsWith('/upgrade-mappings')) return reply(state.applyStatus, state.applied);
        return reply(404, {});
    }),
}));

import UpgradeMappingsDialog from './UpgradeMappingsDialog';

const CHANGED = [{ stepId: 'mail', step: 'Mail klant', field: 'inputs.to', kind: 'ref', take: 'one', root: 'trigger', source: null, label: 'E-mail' }];
const KEPT = [
    { stepId: 'mail', step: 'Mail klant', field: 'inputs.count', kind: 'expr', reason: 'formula' },
    { stepId: 'mail', step: 'Mail klant', field: 'inputs.greet', kind: 'expr', reason: 'formula' },
    { stepId: 'mail', step: 'Mail klant', field: 'inputs.later', kind: 'ref', reason: 'no_evidence' },
];
const PREVIEW = { dryRun: true, saved: false, version: 4, changed: CHANGED, kept: KEPT, evidence: { lastRun: true, sample: false } };
const COUNT = { kind: 'pick', v: 1, from: { root: 'steps', id: 'get', path: ['orders'] }, take: 'count', as: 'native' };
const GREET = { kind: 'compose', v: 1, parts: ['Order ', { from: { root: 'steps', id: 'get', path: ['orders', 0, 'id'] }, take: 'one', as: 'text' }] };
const AI = {
    version: 4,
    suggestions: [
        { stepId: 'mail', step: 'Mail klant', field: 'inputs.count', kind: 'expr', binding: COUNT, take: 'count', root: 'steps', source: 'Orders ophalen', label: 'Orders' },
        { stepId: 'mail', step: 'Mail klant', field: 'inputs.greet', kind: 'expr', binding: GREET, composed: 1 },
    ],
    counts: { candidates: 2, noEvidence: 0, asked: 2, accepted: 2, discarded: 0, truncated: false },
};

const calls = (suffix: string) => state.calls.filter(c => c.url.endsWith(suffix));

function dialog() {
    const onApplied = vi.fn();
    render(withQueryClient(<UpgradeMappingsDialog open automationId="a1" onClose={vi.fn()} onApplied={onApplied} />));
    return { onApplied };
}

function fresh() {
    state.calls.length = 0;
    state.preview = PREVIEW;
    state.aiFix = AI;
    state.applied = { ...PREVIEW, dryRun: false, saved: true, version: 5, automation: { id: 'a1', version: 5, definition: { steps: [] } } };
    state.applyStatus = 200;
    state.aiStatus = 200;
}

describe('UpgradeMappingsDialog: asking the AI and applying what it suggests', () => {
    beforeEach(fresh);

    it('asks only when clicked, about the fields that stay a Formula (never one without data)', async () => {
        const user = userEvent.setup();
        dialog();
        const ask = await screen.findByRole('button', { name: 'Let AI try 2 field(s)' });
        expect(screen.getByText(/never the data in them/)).toBeInTheDocument();
        expect(calls('/ai-fix')).toHaveLength(0);
        await user.click(ask);
        expect(await screen.findByText('Suggested by AI, checked: same result')).toBeInTheDocument();
        expect(calls('/ai-fix')).toEqual([{ url: '/api/automation/a1/upgrade-mappings/ai-fix', body: { version: 4 } }]);
        const rows = screen.getAllByTestId('upgrade-ai');
        expect(rows[0]).toHaveTextContent('Orders ophalen › Orders');
        expect(rows[1]).toHaveTextContent('A text with 1 value(s)');
    });

    it('a suggestion is applied only when ticked, in the same version as the rest', async () => {
        const user = userEvent.setup();
        const { onApplied } = dialog();
        await user.click(await screen.findByRole('button', { name: 'Let AI try 2 field(s)' }));
        const box = await screen.findByRole('checkbox', { name: 'Mail klant · Count' });
        expect(box).not.toBeChecked();
        expect(screen.getByRole('button', { name: 'Update 1 field(s)' })).toBeEnabled();
        await user.click(box);
        await user.click(screen.getByRole('button', { name: 'Update 2 field(s)' }));
        await screen.findByText('Updated');
        expect(calls('/upgrade-mappings').map(c => c.body)).toEqual([
            { version: 4, aiFixes: [{ stepId: 'mail', field: 'inputs.count', binding: COUNT }] },
        ]);
        expect(onApplied).toHaveBeenCalled();
    });

    it('not ticked, not sent: Apply writes the deterministic update alone', async () => {
        const user = userEvent.setup();
        dialog();
        await user.click(await screen.findByRole('button', { name: 'Let AI try 2 field(s)' }));
        await screen.findByText('Suggested by AI, checked: same result');
        await user.click(screen.getByRole('button', { name: 'Update 1 field(s)' }));
        await screen.findByText('Updated');
        expect(calls('/upgrade-mappings').map(c => c.body)).toEqual([{ version: 4 }]);
    });

});

describe('UpgradeMappingsDialog: when the AI fix does not work out', () => {
    beforeEach(fresh);

    it('a suggestion the server no longer accepts: says so, drops them, checks again', async () => {
        const user = userEvent.setup();
        state.applyStatus = 409;
        state.applied = { error: 'An AI suggestion no longer gives the same result.', code: 'ai_fix_changed' };
        const { onApplied } = dialog();
        await user.click(await screen.findByRole('button', { name: 'Let AI try 2 field(s)' }));
        await user.click(await screen.findByRole('checkbox', { name: 'Mail klant · Count' }));
        await user.click(screen.getByRole('button', { name: 'Update 2 field(s)' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('An AI suggestion no longer gives the same result');
        await vi.waitFor(() => expect(calls('?dryRun=1')).toHaveLength(2));
        expect(screen.queryByTestId('upgrade-ai')).not.toBeInTheDocument();
        expect(await screen.findByRole('button', { name: 'Let AI try 2 field(s)' })).toBeInTheDocument();
        expect(onApplied).not.toHaveBeenCalled();
    });

    it('nothing found, or the AI unavailable: says so, nothing changes', async () => {
        const user = userEvent.setup();
        state.aiFix = { ...AI, suggestions: [] };
        dialog();
        await user.click(await screen.findByRole('button', { name: 'Let AI try 2 field(s)' }));
        expect(await screen.findByText(/AI found no rewrite/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Update 1 field(s)' })).toBeEnabled();
    });

    it('a failing AI shows the server\'s sentence', async () => {
        const user = userEvent.setup();
        state.aiStatus = 503;
        state.aiFix = { error: 'No AI model is configured for this workspace.', code: 'no_model' };
        dialog();
        await user.click(await screen.findByRole('button', { name: 'Let AI try 2 field(s)' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('No AI model is configured');
    });

    it('no field the AI may look at: no AI section', async () => {
        state.preview = { ...PREVIEW, kept: [KEPT[2]] };
        dialog();
        const d = await screen.findByRole('dialog', { name: 'Update mappings' });
        await within(d).findByText('1 field(s) can be updated, 1 stay a Formula');
        expect(within(d).queryByTestId('upgrade-ai-section')).not.toBeInTheDocument();
    });
});
