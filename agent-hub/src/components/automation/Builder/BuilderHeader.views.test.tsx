import { render, screen, cleanup, waitFor } from '@testing-library/react';
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
 * The view switcher: a segmented control in the middle of the 52px bar
 * (handoff 5, artboard 5a). The ids stay `build/settings/history/versions`
 * (persisted initialTab values, BFSF-343); only the words change.
 */
const props = (over: Partial<BuilderHeaderProps> = {}): BuilderHeaderProps => ({
    title: 'My automation',
    triggerKind: 'manual',
    automation: { id: 'a1', isActive: false, isDraft: true, version: 1, liveVersion: null, neverLive: true },
    tab: 'build',
    onTabChange: vi.fn(),
    onBack: vi.fn(),
    onRename: vi.fn(),
    onDryRun: vi.fn(),
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
    onPublish: vi.fn(),
    ...over,
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
    cleanup();
    authFetch.mockReset();
    authFetch.mockResolvedValue(ok({ runs7d: 38, runsFailed7d: 2, versions: 5, pendingChanges: 0 }));
});

describe('BuilderHeader: view switcher', () => {
    it('offers the four views as one segmented control, Editor first, and keeps the build id', async () => {
        const user = userEvent.setup();
        const p = props({ automation: null });
        render(withQueryClient(<BuilderHeader {...p} />));
        const group = screen.getByRole('radiogroup', { name: 'Builder views' });
        expect([...group.querySelectorAll('[role="radio"]')].map(el => el.textContent?.trim()))
            .toEqual(['Editor', 'Settings', 'Runs', 'Versions']);
        await user.click(screen.getByRole('radio', { name: 'Editor' }));
        expect(p.onTabChange).toHaveBeenCalledWith('build');
        // No row, no id: the counts are never asked for.
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('shows the run and version counts from GET /:id/counts', async () => {
        render(withQueryClient(<BuilderHeader {...props()} />));
        await waitFor(() => expect(screen.getByRole('radio', { name: /Runs/ }).textContent).toBe('Runs38'));
        expect(screen.getByRole('radio', { name: /Versions/ }).textContent).toBe('Versions5');
        expect(authFetch).toHaveBeenCalledWith('/api/automation/a1/counts', expect.anything());
    });

    it('offers Versions as a view of its own and marks the current view', async () => {
        const user = userEvent.setup();
        const p = props({ tab: 'versions' });
        render(withQueryClient(<BuilderHeader {...p} />));
        expect(screen.getByRole('radio', { name: /Versions/ }).getAttribute('aria-checked')).toBe('true');
        expect(screen.getByRole('radio', { name: 'Editor' }).getAttribute('aria-checked')).toBe('false');
        await user.click(screen.getByRole('radio', { name: /Settings/ }));
        expect(p.onTabChange).toHaveBeenCalledWith('settings');
    });
});

describe('BuilderHeader: the name', () => {
    it('a long name truncates and its tooltip carries the whole name, then how to rename', () => {
        const long = 'Weekly AI/SaaS spend report for finance, legal and procurement across every EU entity';
        render(withQueryClient(<BuilderHeader {...props({ title: long })} />));
        const name = screen.getByRole('button', { name: long });
        expect(name.className).toContain('truncate');
        expect(name.getAttribute('title')).toBe(`${long}\nClick to rename`);
    });

    it('the bar leaves 24px between the name and the centred views', () => {
        const { container } = render(withQueryClient(<BuilderHeader {...props()} />));
        const bar = container.querySelector('.grid') as HTMLElement;
        expect(bar.className).toContain('grid-cols-[1fr_auto_1fr]');
        expect(bar.className).toContain('gap-x-6');
    });
});

describe('BuilderHeader: right cluster per view', () => {
    it('shows undo/redo on the Editor only', () => {
        const onUndo = vi.fn();
        const { rerender } = render(withQueryClient(<BuilderHeader {...props({ onUndo, onRedo: vi.fn(), canUndo: true })} />));
        expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
        rerender(withQueryClient(<BuilderHeader {...props({ onUndo, tab: 'settings' })} />));
        expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });

    it('says "Saved automatically" on Settings, and "Saving…" while a save is in flight', () => {
        const { rerender } = render(withQueryClient(<BuilderHeader {...props({ tab: 'settings' })} />));
        expect(screen.getByText('Saved automatically')).toBeTruthy();
        rerender(withQueryClient(<BuilderHeader {...props({ tab: 'settings', savingState: 'saving' })} />));
        expect(screen.getByText('Saving…')).toBeTruthy();
        rerender(withQueryClient(<BuilderHeader {...props({ tab: 'build' })} />));
        expect(screen.queryByText('Saved automatically')).toBeNull();
    });

    it('Test runs a dry-run straight away; Run live and Start from sit behind the chevron', async () => {
        const user = userEvent.setup();
        const p = props({
            onRunLive: vi.fn(),
            triggers: [{ id: 'trig_b', label: 'Label commands', kind: 'app_event' }],
            primaryTriggerLabel: 'New email',
        });
        render(withQueryClient(<BuilderHeader {...p} />));
        await user.click(screen.getByRole('button', { name: 'Test' }));
        expect(p.onDryRun).toHaveBeenLastCalledWith(null);
        await user.click(screen.getByRole('button', { name: 'More ways to run' }));
        expect(screen.getByRole('menuitemradio', { name: 'New email' }).getAttribute('aria-checked')).toBe('true');
        await user.click(screen.getByRole('menuitemradio', { name: 'Label commands' }));
        await user.click(screen.getByRole('menuitem', { name: /run live/i }));
        expect(p.onRunLive).toHaveBeenLastCalledWith('trig_b');
        // The choice sticks for the Test button too.
        await user.click(screen.getByRole('button', { name: 'Test' }));
        expect(p.onDryRun).toHaveBeenLastCalledWith('trig_b');
        expect(screen.getByRole('button', { name: 'Test' }).textContent).toContain('from Label commands');
    });

    it('shows no entry-point choice for a single-trigger automation', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<BuilderHeader {...props({ onRunLive: vi.fn() })} />));
        await user.click(screen.getByRole('button', { name: 'More ways to run' }));
        expect(screen.queryByRole('menuitemradio')).toBeNull();
    });
});

describe('BuilderHeader: step mode keeps its Publish cluster', () => {
    it('shows Publish and no Activate / Test for a reusable Step', async () => {
        const user = userEvent.setup();
        const onPublishStep = vi.fn();
        render(withQueryClient(<BuilderHeader {...props({ mode: 'step', automation: null, step: { publishedVersion: null }, onPublishStep })} />));
        expect(screen.queryByRole('button', { name: /activate/i })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Test' })).toBeNull();
        await user.click(screen.getByRole('button', { name: /^Publish$/ }));
        expect(onPublishStep).toHaveBeenCalledTimes(1);
    });
});

/**
 * The strip under the bar: the ONLY place AppRefBreadcrumb and
 * UsedByButtonsCapsule are mounted. BuilderShell.breadcrumbSlot.test.jsx pins
 * what the shell puts in the prop.
 */
describe('BuilderHeader: the breadcrumb strip under the bar', () => {
    it('renders what is in breadcrumbSlot', () => {
        render(withQueryClient(<BuilderHeader {...props({ breadcrumbSlot: <div data-testid="slot-marker">here</div> })} />));
        expect(screen.getByTestId('slot-marker')).toBeTruthy();
    });

    it('and without a slot the bar still stands', () => {
        render(withQueryClient(<BuilderHeader {...props()} />));
        expect(screen.queryByTestId('slot-marker')).toBeNull();
        expect(screen.getByRole('radiogroup', { name: 'Builder views' })).toBeTruthy();
    });
});
