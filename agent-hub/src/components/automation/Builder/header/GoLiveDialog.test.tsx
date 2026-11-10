import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import GoLiveDialog, { goLiveSentence, putsNewVersionLive, type GoLiveKind, type GoLiveRow } from './GoLiveDialog';
import { liveStateOf } from './liveState';

/**
 * The question in front of "Make vN live" and "Activate". What it must get
 * right: say what the server will really do, show what changes, and hold the
 * confirm button back until the person says "anyway" when the last test
 * failed, never ran, or could not be read.
 */

const t = (_key: string, fallback: string, vars: Record<string, unknown> = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? ''));

const LIVE: GoLiveRow = { id: 'a1', isActive: true, version: 5, liveVersion: 3, neverLive: false, pendingChanges: 2 };
const PAUSED: GoLiveRow = { ...LIVE, isActive: false };
const NEVER: GoLiveRow = { id: 'a1', isActive: false, version: 2, liveVersion: null, neverLive: true };

const readiness = (lastTest: unknown) => ({
    stepsComplete: { ok: true, issues: [] }, lastTest,
    aiAct: { required: false, status: 'not_required', expiresAt: null }, description: { ok: true }, canActivate: true,
});
const DIFF = {
    changes: [{ stepId: 's8', stepNumber: 8, stepLabel: 'Post to finance', change: 'changed', setting: 'to', settingLabel: 'To', before: 'a@x.test', after: 'b@x.test' }],
    stepIds: { added: [], removed: [], changed: ['s8'] }, description: 'Changed To of step 8', layoutOnly: false,
};

/** The two GETs the dialog makes; `null` for either answers 500. */
function serve({ ready, diff = DIFF }: { ready: unknown; diff?: unknown }) {
    const seen: string[] = [];
    const headers = new Headers({ 'content-type': 'application/json' });
    const answer = (body: unknown) => (body === null
        ? { ok: false, status: 500, headers, json: async () => ({ error: 'down' }), text: async () => 'down' }
        : { ok: true, status: 200, headers, json: async () => body, text: async () => JSON.stringify(body) });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        seen.push(String(url));
        if (String(url).endsWith('/readiness')) return answer(ready);
        if (String(url).endsWith('/versions/working/fielddiff/live')) return answer(diff);
        return answer({});
    }));
    return seen;
}

function open(automation: GoLiveRow, action: GoLiveKind) {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(withQueryClient(<GoLiveDialog automation={automation} action={action} onCancel={onCancel} onConfirm={onConfirm} />));
    return { onCancel, onConfirm, confirm: () => screen.getByTestId('golive-confirm') };
}

afterEach(() => vi.unstubAllGlobals());

describe('goLiveSentence', () => {
    it('says what each press does, as the server does it', () => {
        expect(goLiveSentence(liveStateOf(LIVE), 'publish', t)).toBe('v3 is live. This makes v5 live.');
        expect(goLiveSentence(liveStateOf(NEVER), 'activate', t)).toBe('This automation has never been live. This makes v2 live and switches it on.');
        expect(goLiveSentence(liveStateOf(NEVER), 'publish', t)).toBe('This makes v2 the live version.');
        // Activate on a paused automation switches the LIVE version on; saved changes stay behind.
        expect(goLiveSentence(liveStateOf(PAUSED), 'activate', t))
            .toBe('This switches the automation back on with v3. Your changes in v5 stay in the working copy until you make them live.');
        expect(goLiveSentence(liveStateOf({ ...PAUSED, pendingChanges: 0 }), 'activate', t))
            .toBe('This switches the automation back on. Runs use v3, the live version.');
    });

    it('knows when a new version goes live', () => {
        expect(putsNewVersionLive(liveStateOf(LIVE), 'publish')).toBe(true);
        expect(putsNewVersionLive(liveStateOf(NEVER), 'activate')).toBe(true);
        expect(putsNewVersionLive(liveStateOf(PAUSED), 'activate')).toBe(false);
    });
});

describe('GoLiveDialog', () => {
    it('a passed test: shows the changes and the checks, and confirms without a tick', async () => {
        const user = userEvent.setup();
        serve({ ready: readiness({ ok: true, at: new Date().toISOString(), version: 5, status: 'success' }) });
        const { onConfirm, onCancel, confirm } = open(LIVE, 'publish');

        const dialog = screen.getByRole('dialog', { name: 'Make v5 live?' });
        expect(within(dialog).getByTestId('golive-what')).toHaveTextContent('v3 is live. This makes v5 live.');
        expect(await within(dialog).findByTestId('golive-changes')).toHaveTextContent('Post to finance');
        expect(await within(dialog).findByText(/^Last test passed/)).toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
        expect(screen.queryByTestId('golive-tested-on')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

        await user.click(confirm());
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
    });

    it.each([
        ['a failed test', readiness({ ok: false, at: new Date().toISOString(), version: 4, status: 'error' }), 'The last test failed.'],
        ['no test at all', readiness(null), 'This automation has not been tested yet.'],
        ['checks that could not be read', null, 'The checks could not be loaded, so this version counts as not tested.'],
    ])('%s: the confirm button waits for "Make it live anyway"', async (_name, ready, reason) => {
        const user = userEvent.setup();
        serve({ ready });
        const { onConfirm, confirm } = open(LIVE, 'publish');

        const tick = await screen.findByRole('checkbox', { name: new RegExp('^Make it live anyway') });
        expect(screen.getByText(reason)).toBeInTheDocument();
        expect(confirm()).toBeDisabled();
        await user.click(confirm());
        expect(onConfirm).not.toHaveBeenCalled();

        await user.click(tick);
        expect(confirm()).toBeEnabled();
        await user.click(confirm());
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('says which version the last test ran on when it is not this one', async () => {
        serve({ ready: readiness({ ok: false, at: null, version: 4, status: 'error' }) });
        open(LIVE, 'publish');
        expect(await screen.findByTestId('golive-tested-on')).toHaveTextContent('The last test ran on v4, not on v5.');
    });

    it('changes that could not be loaded say so, and the dialog still works', async () => {
        const user = userEvent.setup();
        serve({ ready: readiness({ ok: true, at: null, version: 5, status: 'success' }), diff: null });
        const { onConfirm, confirm } = open(LIVE, 'publish');
        expect(await screen.findByText('The changes could not be loaded.')).toBeInTheDocument();
        await screen.findByText(/^Last test passed/);
        await user.click(confirm());
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('Cancel and Escape close it without confirming', async () => {
        const user = userEvent.setup();
        serve({ ready: readiness(null) });
        const { onConfirm, onCancel } = open(LIVE, 'publish');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await user.keyboard('{Escape}');
        expect(onCancel).toHaveBeenCalledTimes(2);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('switching a paused automation back on puts nothing new live: no checks, no tick, no requests', async () => {
        const user = userEvent.setup();
        const seen = serve({ ready: readiness(null) });
        const { onConfirm } = open(PAUSED, 'activate');
        expect(screen.getByRole('dialog', { name: 'Switch this automation back on?' })).toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Activate' }));
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([]);
    });

    it('a first go-live has no live version to compare with, and still asks about the test', async () => {
        const seen = serve({ ready: readiness(null) });
        open(NEVER, 'activate');
        expect(await screen.findByRole('checkbox', { name: /^Make it live anyway/ })).toBeInTheDocument();
        expect(screen.queryByText('What changes')).not.toBeInTheDocument();
        expect(seen.some((u) => u.includes('fielddiff'))).toBe(false);
    });
});
