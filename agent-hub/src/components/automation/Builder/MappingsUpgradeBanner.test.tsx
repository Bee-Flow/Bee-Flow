// MappingsUpgradeBanner + useMappingsUpgradeOnOpen (M8b): the offer to update
// an automation's mappings when it is opened, and the organisation's update
// on open with Undo. The server is faked at authFetch; the dialog, the hook,
// the shared legacyBindings and scopedStorage are the real ones.
import { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import * as scopedStorage from '../../../utils/scopedStorage';

const { state } = vi.hoisted(() => ({
    state: {
        auto: null as unknown,
        /** When set, the update on open answers only once this resolves. */
        gate: null as Promise<void> | null,
        calls: [] as Array<{ url: string; body: unknown }>,
    },
}));

vi.mock('../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url: string, opts: { body?: string } = {}) => {
        state.calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
        const reply = (status: number, body: unknown) => ({
            ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body,
        });
        if (url.endsWith('/upgrade-mappings?dryRun=1')) {
            return reply(200, { dryRun: true, saved: false, version: 4, changed: [], kept: [], evidence: { lastRun: true, sample: false } });
        }
        if (url.endsWith('/upgrade-mappings')) {
            if (state.gate) await state.gate;
            return reply(200, state.auto);
        }
        if (url.endsWith('/versions/row-4/restore')) return reply(200, { automation: { ...ROW, version: 6, definition: LEGACY } });
        return reply(404, {});
    }),
}));

import MappingsUpgradeBanner from './MappingsUpgradeBanner';
import { legacyFingerprint, memoryKey } from './useMappingsUpgradeOnOpen';

const LEGACY = { trigger: { kind: 'manual' }, steps: [{ id: 's', type: 'integration_action', inputs: { to: { kind: 'ref', path: 'trigger.output.email' } } }] };
const UPGRADED = { trigger: { kind: 'manual' }, steps: [{ id: 's', type: 'integration_action', inputs: { to: { kind: 'pick', v: 1, from: { root: 'trigger', path: ['email'] }, take: 'one', as: 'native' } } }] };
const ROW = { id: 'a1', title: 'Orders', version: 4, myRole: 'owner', definition: LEGACY };
const AUTO_OFF = { dryRun: false, version: 4, saved: false, autoOff: true };
const AUTO_SAVED = {
    dryRun: false, saved: true, version: 5, previous: { version: 4, versionId: 'row-4' },
    changed: [{ stepId: 's', step: null, field: 'inputs.to', kind: 'ref', take: 'one' }], kept: [],
    evidence: { lastRun: true, sample: false }, automation: { ...ROW, version: 5, definition: UPGRADED },
};

const autoCalls = () => state.calls.filter(c => c.url.endsWith('/upgrade-mappings'));

type Props = Partial<{ automation: Record<string, unknown> | null; active: boolean; pristine: boolean }>;

/**
 * The banner as BuilderShell mounts it: the row it adopts is the row it is
 * handed next (syncServerRow), unless a test hands one in itself.
 */
function Shell({ onApplied, onSuperseded, ...p }: Props & { onApplied: (row: Record<string, unknown>) => void; onSuperseded: () => void }) {
    const [row, setRow] = useState<Record<string, unknown> | null>(null);
    const automation = p.automation === undefined ? (row ?? ROW) : p.automation;
    return (
        <div className="relative">
            <MappingsUpgradeBanner
                automation={automation}
                active={p.active ?? true}
                pristine={p.pristine ?? true}
                onApplied={(r) => { onApplied(r); setRow(r); }}
                onSuperseded={onSuperseded}
            />
        </div>
    );
}

function banner(props: Props = {}) {
    const onApplied = vi.fn();
    const onSuperseded = vi.fn();
    const ui = (p: Props) => withQueryClient(<Shell onApplied={onApplied} onSuperseded={onSuperseded} {...p} />);
    const view = render(ui(props));
    return { onApplied, onSuperseded, rerender: (p: Props) => view.rerender(ui(p)) };
}

function fresh() {
    state.calls.length = 0;
    state.auto = AUTO_OFF;
    state.gate = null;
    localStorage.clear();
    scopedStorage.setCurrentUser('u1');
}

describe('MappingsUpgradeBanner: the offer', () => {
    beforeEach(fresh);
    afterEach(() => scopedStorage.setCurrentUser(null));

    it('offers the update when legacy bindings remain; Update opens the dry run inline', async () => {
        const user = userEvent.setup();
        banner();
        const strip = await screen.findByTestId('mappings-upgrade-banner');
        expect(strip).toHaveTextContent('This automation can be updated to the new mappings.');
        expect(autoCalls()[0].body).toEqual({ version: 4, auto: true });
        await user.click(screen.getByRole('button', { name: 'Update' }));
        expect(await screen.findByRole('dialog', { name: 'Update mappings' })).toBeInTheDocument();
        expect(state.calls.some(c => c.url.endsWith('?dryRun=1'))).toBe(true);
        expect(screen.queryByTestId('mappings-upgrade-banner')).not.toBeInTheDocument();
    });

    it('no legacy binding: no banner, and no request at all', async () => {
        banner({ automation: { ...ROW, definition: UPGRADED } });
        await act(async () => {});
        expect(screen.queryByTestId('mappings-upgrade-banner')).not.toBeInTheDocument();
        expect(state.calls).toEqual([]);
    });

    it('only for someone who may edit, and never during a run view', async () => {
        const { rerender } = banner({ automation: { ...ROW, myRole: 'view' } });
        await act(async () => {});
        expect(screen.queryByTestId('mappings-upgrade-banner')).not.toBeInTheDocument();
        rerender({ automation: { ...ROW, myRole: 'run' } });
        await act(async () => {});
        expect(screen.queryByTestId('mappings-upgrade-banner')).not.toBeInTheDocument();
        rerender({ active: false });
        await act(async () => {});
        expect(screen.queryByTestId('mappings-upgrade-banner')).not.toBeInTheDocument();
        expect(state.calls).toEqual([]);
    });

    it('Later hides it for this automation, for this person', async () => {
        const user = userEvent.setup();
        banner();
        await user.click(await screen.findByRole('button', { name: 'Later' }));
        expect(screen.queryByTestId('mappings-upgrade-banner')).not.toBeInTheDocument();
        expect(scopedStorage.getJSON(memoryKey('a1'))).toEqual({ later: true });
        scopedStorage.setCurrentUser('u2');
        expect(scopedStorage.getJSON(memoryKey('a1'))).toBeNull();
    });

    it('once looked at, it does not come back for the same bindings; it does when they change', async () => {
        scopedStorage.setJSON(memoryKey('a1'), { checked: legacyFingerprint(LEGACY) });
        const { rerender } = banner();
        await act(async () => {});
        expect(screen.queryByTestId('mappings-upgrade-banner')).not.toBeInTheDocument();
        const changed = { ...LEGACY, steps: [...LEGACY.steps, { id: 't', type: 'integration_action', inputs: { n: { kind: 'expr', value: '1 + 1' } } }] };
        rerender({ automation: { ...ROW, definition: changed } });
        expect(await screen.findByTestId('mappings-upgrade-banner')).toBeInTheDocument();
    });

});

describe('MappingsUpgradeBanner: the organisation\'s update on open', () => {
    beforeEach(fresh);
    afterEach(() => scopedStorage.setCurrentUser(null));

    it('unsaved edits on the canvas: no update on open', async () => {
        banner({ pristine: false });
        await screen.findByTestId('mappings-upgrade-banner');
        expect(autoCalls()).toEqual([]);
    });

    it('the organisation\'s update on open: adopted, "Mappings updated", and Undo restores the version before it', async () => {
        const user = userEvent.setup();
        state.auto = AUTO_SAVED;
        const { onApplied } = banner();
        const notice = await screen.findByTestId('mappings-upgrade-notice');
        expect(notice).toHaveTextContent('Mappings updated (1 field(s))');
        expect(onApplied).toHaveBeenCalledWith(AUTO_SAVED.automation);
        expect(screen.queryByTestId('mappings-upgrade-banner')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        expect(await screen.findByText('The mappings are back as they were.')).toBeInTheDocument();
        expect(state.calls.some(c => c.url === '/api/automation/a1/versions/row-4/restore')).toBe(true);
        expect(onApplied).toHaveBeenLastCalledWith(expect.objectContaining({ version: 6, definition: LEGACY }));
        // Undo is a no for this automation: neither the offer nor the update comes back.
        expect(scopedStorage.getJSON(memoryKey('a1'))).toMatchObject({ later: true });
    });

    it('edited while the update was out: the canvas wins, nothing adopted, the canvas written again', async () => {
        let open = () => {};
        state.gate = new Promise<void>((resolve) => { open = resolve; });
        state.auto = AUTO_SAVED;
        const { onApplied, onSuperseded, rerender } = banner();
        await act(async () => {});
        expect(autoCalls()).toHaveLength(1);
        rerender({ pristine: false });
        await act(async () => { open(); });
        expect(onApplied).not.toHaveBeenCalled();
        expect(onSuperseded).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('mappings-upgrade-notice')).not.toBeInTheDocument();
        // Not marked as looked at: the offer may come back for these bindings.
        expect(scopedStorage.getJSON(memoryKey('a1'))).toBeNull();
    });

    it('Undo goes once the canvas holds an edit', async () => {
        state.auto = AUTO_SAVED;
        const { rerender } = banner();
        expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
        rerender({ pristine: false });
        expect(screen.queryByTestId('mappings-upgrade-notice')).not.toBeInTheDocument();
        rerender({ pristine: true });
        expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
        expect(state.calls.some(c => c.url.endsWith('/restore'))).toBe(false);
    });

    it('Undo goes once the row is saved again after the update', async () => {
        state.auto = AUTO_SAVED;
        const { rerender } = banner();
        expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
        rerender({ automation: { ...ROW, version: 6, definition: UPGRADED } });
        expect(screen.queryByTestId('mappings-upgrade-notice')).not.toBeInTheDocument();
    });

    it('asks once per open, not per render', async () => {
        const { rerender } = banner();
        await screen.findByTestId('mappings-upgrade-banner');
        rerender({ active: false });
        rerender({ active: true });
        await act(async () => {});
        expect(autoCalls()).toHaveLength(1);
    });
});
