import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import BuilderHeader, { type BuilderHeaderProps } from './BuilderHeader';

const authFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch,
}));

/**
 * The status in plain language and the ONE primary action per state
 * (handoff 5, artboards 5a/5d). Autosave on an active routine is not live
 * until "Make vN live".
 */
type Row = NonNullable<BuilderHeaderProps['automation']>;
const NEVER: Row = { id: 'a1', isActive: false, isDraft: true, version: 2, liveVersion: null, neverLive: true, pendingChanges: 0 };
const LIVE: Row = { id: 'a1', isActive: true, isDraft: false, version: 3, liveVersion: 3, neverLive: false, pendingChanges: 0 };
const AHEAD: Row = { ...LIVE, version: 5, pendingChanges: 2 };
const PAUSED: Row = { ...LIVE, isActive: false };

const setup = (automation: Row, over: Partial<BuilderHeaderProps> = {}) => {
    const p: BuilderHeaderProps = {
        title: 'Invoice intake', triggerKind: 'manual', automation, tab: 'build', onTabChange: vi.fn(),
        onActivate: vi.fn(), onDeactivate: vi.fn(), onPublish: vi.fn(), onDryRun: vi.fn(), ...over,
    };
    render(withQueryClient(<BuilderHeader {...p} />));
    return p;
};

beforeEach(() => {
    cleanup();
    authFetch.mockReset();
    authFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
});

describe('BuilderHeader: status wording', () => {
    it('a routine that never went live reads "Draft · never live"', () => {
        setup(NEVER);
        expect(screen.getByTestId('live-status').textContent).toBe('Draft · never live');
        expect(screen.getByTestId('live-status').dataset.kind).toBe('never');
        expect(screen.queryByTestId('live-pending')).toBeNull();
    });

    it('a live routine names its live version, in the success tint', () => {
        setup(LIVE);
        const pill = screen.getByTestId('live-status');
        expect(pill.textContent).toBe('Live · v3');
        expect(pill.className).toContain('var(--success)');
        expect(screen.queryByTestId('live-pending')).toBeNull();
    });

    it('says quietly which version is being edited and how many changes are not live yet', () => {
        setup(AHEAD);
        expect(screen.getByTestId('live-status').textContent).toBe('Live · v3');
        expect(screen.getByTestId('live-pending').textContent).toBe('editing v5 · 2 changes not live yet');
    });

    it('the pending line only shows on a wide bar; the pill always carries it as its tooltip', () => {
        // A small bar hides the line rather than truncating it into "editing v5 · …".
        setup(AHEAD);
        expect(screen.getByTestId('live-pending').className).toMatch(/(^| )hidden( |$)/);
        expect(screen.getByTestId('live-pending').className).toContain('@min-[1700px]/bar:inline');
        expect(screen.getByTestId('live-status').getAttribute('title')).toBe('editing v5 · 2 changes not live yet');
    });

    it('a pill with nothing pending has no tooltip', () => {
        setup(LIVE);
        expect(screen.getByTestId('live-status').hasAttribute('title')).toBe(false);
    });

    it('a paused routine reads "Paused"', () => {
        setup(PAUSED);
        expect(screen.getByTestId('live-status').textContent).toBe('Paused');
    });
});

describe('BuilderHeader: the primary action per state', () => {
    it('never live: Activate, in the theme accent with its paired foreground', async () => {
        const user = userEvent.setup();
        const p = setup(NEVER);
        const btn = screen.getByRole('button', { name: /^Activate$/ });
        expect(btn.className).toContain('bg-[var(--accent-primary)]');
        expect(btn.className).toContain('text-[var(--accent-primary-fg)]');
        expect(btn.className).not.toContain('text-white');
        expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
        await user.click(btn);
        expect(p.onActivate).toHaveBeenCalledTimes(1);
    });

    it('never live, on the Versions tab: the same call reads "Make v2 live"', async () => {
        const user = userEvent.setup();
        const p = setup(NEVER, { tab: 'versions' });
        await user.click(screen.getByRole('button', { name: 'Make v2 live' }));
        expect(p.onActivate).toHaveBeenCalledTimes(1);
    });

    it('live and up to date: only a quiet Pause', async () => {
        const user = userEvent.setup();
        const p = setup(LIVE);
        expect(screen.queryByRole('button', { name: /activate|live$/i })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Pause' }));
        expect(p.onDeactivate).toHaveBeenCalledTimes(1);
    });

    it('live with pending changes: "Make v5 live" publishes, Pause stays as the secondary', async () => {
        const user = userEvent.setup();
        const p = setup(AHEAD);
        const btn = screen.getByRole('button', { name: 'Make v5 live' });
        expect(btn.className).toContain('bg-[var(--accent-primary)]');
        await user.click(btn);
        expect(p.onPublish).toHaveBeenCalledTimes(1);
        expect(p.onActivate).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    });

    it('waits for a pending autosave before it can go live', () => {
        setup(AHEAD, { savingState: 'saving' });
        expect((screen.getByRole('button', { name: 'Make v5 live' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('paused: Activate switches it back on', async () => {
        const user = userEvent.setup();
        const p = setup(PAUSED);
        await user.click(screen.getByRole('button', { name: /^Activate$/ }));
        expect(p.onActivate).toHaveBeenCalledTimes(1);
    });

    it('an incomplete routine cannot be activated', () => {
        setup(NEVER, { canActivate: false });
        expect((screen.getByRole('button', { name: /^Activate$/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('takes the pending count from GET /:id/counts when the row has none', async () => {
        authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ runs7d: 1, versions: 5, pendingChanges: 1 }) });
        const { pendingChanges: _drop, ...rowWithoutPending } = AHEAD;
        void _drop;
        setup(rowWithoutPending);
        expect(await screen.findByRole('button', { name: 'Make v5 live' })).toBeTruthy();
        expect(screen.getByTestId('live-pending').textContent).toBe('editing v5 · 1 change not live yet');
    });
});
