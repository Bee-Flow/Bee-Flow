import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * WebpagesList — the overview (plan W1, Webpages artboard 1a).
 *
 * What is pinned:
 *   - the header row is StudioSectionHeader with the webpage kind tile, the
 *     count, the 220px search field and ONE primary action;
 *   - describe-to-build: the brief and the picked sources leave through
 *     `onBuild`, the brief survives a failed build, and the name-only
 *     shortcut still posts a bare name from under "All options";
 *   - the card's fourth visibility state: a live public share outranks the
 *     audience pair, and nothing else can reach it;
 *   - the linking pills come from `bridgeGrants` (automations today, tables
 *     the day W3 stops dropping them);
 *   - a preset fills the build bar rather than creating anything.
 */

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

import WebpagesList from './WebpagesList';

const NOW = '2026-09-04T10:00:00.000Z';

function row(id, name, extra = {}) {
    return {
        id, name, userId: 'u1', updatedAt: NOW, htmlSize: 100,
        isPublished: false, sharedGroups: [], settings: {}, ...extra,
    };
}

function renderList(props = {}) {
    const base = {
        webpages: [row('A', 'Page A')],
        loading: false,
        loadingWebpageId: null,
        error: null,
        onDismissError: vi.fn(),
        newName: '',
        onNewNameChange: vi.fn(),
        creating: false,
        onCreate: vi.fn((e) => e?.preventDefault?.()),
        onBuild: vi.fn(async () => {}),
        building: false,
        onOpen: vi.fn(),
        onEdit: vi.fn(),
        onClone: vi.fn(),
        onDelete: vi.fn(),
        onRename: vi.fn(),
    };
    const merged = { ...base, ...props };
    return { ...render(<WebpagesList {...merged} />), props: merged };
}

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockImplementation(async (url) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).includes('/api/datatables')
            ? { datatables: [{ id: 't1', name: 'Quotes' }] }
            : { automations: [{ id: 'a1', title: 'Request from website' }] }),
    }));
});

afterEach(() => { vi.restoreAllMocks(); });

/* ── the shared header ────────────────────────────────────────────────── */

describe('WebpagesList — header', () => {
    it('is the shared section header, with the webpage tile, the count and one primary', () => {
        renderList({ webpages: [row('A', 'Page A'), row('B', 'Page B')] });

        const header = screen.getByTestId('studio-section-header');
        expect(within(header).getByTestId('studio-section-kind')).toHaveAttribute('data-kind', 'webpage');
        expect(within(header).getByTestId('studio-section-title')).toHaveTextContent('Webpages');
        expect(within(header).getByTestId('studio-section-status')).toHaveTextContent('2');
        expect(within(header).getByRole('searchbox', { name: 'Search…' })).toBeInTheDocument();
        expect(within(header).getByRole('button', { name: 'New webpage' })).toBeInTheDocument();
    });

    it('shows no count while the list is still loading', () => {
        renderList({ loading: true });
        expect(screen.queryByTestId('studio-section-status')).not.toBeInTheDocument();
    });

    it('filters on name and tagline, and says so when nothing matches', () => {
        renderList({
            webpages: [row('A', 'Page A', { tagline: 'quote status' }), row('B', 'Something else')],
        });
        const search = screen.getByRole('searchbox', { name: 'Search…' });

        fireEvent.change(search, { target: { value: 'quote' } });
        expect(screen.getByText('Page A')).toBeInTheDocument();
        expect(screen.queryByText('Something else')).not.toBeInTheDocument();

        fireEvent.change(search, { target: { value: 'zzz' } });
        expect(screen.getByText('No matches')).toBeInTheDocument();
        // The examples card is a suggestion, not a search result.
        expect(screen.queryByTestId('webpages-examples')).not.toBeInTheDocument();
    });
});

/* ── describe to build ────────────────────────────────────────────────── */

describe('WebpagesList — describe to build', () => {
    it('hands the brief and the picked sources to onBuild, then clears the bar', async () => {
        const onBuild = vi.fn(async () => {});
        renderList({ onBuild });

        const input = screen.getByRole('textbox', { name: 'Describe the page you want' });
        fireEvent.change(input, { target: { value: '  A status page  ' } });

        // Pick one table and one automation out of the chooser.
        await act(async () => { fireEvent.click(screen.getByTestId('webpages-source-picker')); });
        await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Quotes/ })); });
        await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Request from website/ })); });

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Build' })); });

        expect(onBuild).toHaveBeenCalledTimes(1);
        expect(onBuild.mock.calls[0][0]).toEqual({
            prompt: 'A status page',
            sources: [
                { kind: 'datatable', id: 't1', name: 'Quotes' },
                { kind: 'automation', id: 'a1', name: 'Request from website' },
            ],
        });
        expect(input).toHaveValue('');
        expect(screen.queryByTestId('webpages-build-sources')).not.toBeInTheDocument();
    });

    it('keeps the brief when the build fails', async () => {
        const onBuild = vi.fn(async () => { throw new Error('nope'); });
        renderList({ onBuild });

        const input = screen.getByRole('textbox', { name: 'Describe the page you want' });
        fireEvent.change(input, { target: { value: 'A status page' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Build' })); });

        expect(onBuild).toHaveBeenCalledTimes(1);
        expect(input).toHaveValue('A status page');
    });

    it('cannot build an empty brief', () => {
        const onBuild = vi.fn();
        renderList({ onBuild });
        expect(screen.getByRole('button', { name: 'Build' })).toBeDisabled();
    });

    it('a picked source can be taken back off the bar', async () => {
        renderList();
        await act(async () => { fireEvent.click(screen.getByTestId('webpages-source-picker')); });
        await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Quotes/ })); });
        expect(screen.getByTestId('webpages-build-sources')).toHaveTextContent('Quotes');

        fireEvent.click(screen.getByRole('button', { name: 'Remove Quotes' }));
        expect(screen.queryByTestId('webpages-build-sources')).not.toBeInTheDocument();
    });

    it('a preset fills the build bar and creates nothing by itself', () => {
        const { props } = renderList();
        fireEvent.click(screen.getByRole('button', { name: 'Status page on a table' }));

        const input = screen.getByRole('textbox', { name: 'Describe the page you want' });
        expect(input.value.length).toBeGreaterThan(20);
        expect(props.onBuild).not.toHaveBeenCalled();
        expect(props.onCreate).not.toHaveBeenCalled();
    });
});

/* ── the name-only shortcut ───────────────────────────────────────────── */

describe('WebpagesList — the name-only shortcut', () => {
    it('lives under "All options" and still submits through onCreate', () => {
        const { props } = renderList({ newName: 'Page C' });

        const disclosure = screen.getByRole('button', { name: /All options/ });
        expect(disclosure).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(disclosure);
        expect(disclosure).toHaveAttribute('aria-expanded', 'true');

        fireEvent.click(screen.getByRole('button', { name: /Create/ }));
        expect(props.onCreate).toHaveBeenCalledTimes(1);
    });

    it('keeps the name field addressable while collapsed, so nothing is lost mid-typing', () => {
        renderList();
        // Collapsed is `hidden`, not unmounted — the draft survives a toggle.
        expect(screen.getByPlaceholderText('New webpage name…')).toBeInTheDocument();
    });
});

/* ── the cards ────────────────────────────────────────────────────────── */

describe('WebpagesList — cards', () => {
    it('shows the audience on the capsule', () => {
        renderList({ webpages: [row('A', 'Page A', { isPublished: true, sharedGroups: [] })] });
        const badge = screen.getByTestId('webpage-card-visibility');
        expect(badge).toHaveAttribute('data-mode', 'org');
        expect(badge).toHaveTextContent('Entire organisation');
    });

    it('a live public share outranks the audience — a personal page CAN be public', () => {
        renderList({ webpages: [row('A', 'Page A', { isPublished: false, publicShareCount: 1 })] });
        const badge = screen.getByTestId('webpage-card-visibility');
        expect(badge).toHaveAttribute('data-mode', 'public');
        expect(badge).toHaveTextContent('Public');
    });

    it('no share count means the audience, never "Public"', () => {
        renderList({ webpages: [row('A', 'Page A', { publicShareCount: 0 })] });
        expect(screen.getByTestId('webpage-card-visibility')).toHaveAttribute('data-mode', 'personal');
    });

    it('renders the linking pills from bridgeGrants, tables included', () => {
        renderList({
            webpages: [row('A', 'Page A', {
                bridgeGrants: {
                    automations: [{ automationId: 'a1', label: 'vPlan sync' }],
                    tables: [{ datatableId: 't1', label: 'Rates' }],
                },
            })],
        });
        const links = screen.getByTestId('webpage-card-links');
        expect(links).toHaveTextContent('Rates');
        expect(links).toHaveTextContent('vPlan sync');
    });

    it('routes open / edit / duplicate / delete out through the callbacks', () => {
        const { props } = renderList();
        const card = screen.getByTestId('webpage-card');

        fireEvent.click(within(card).getByTitle('Edit in IDE'));
        fireEvent.click(within(card).getByTitle('Duplicate'));
        fireEvent.click(within(card).getByTitle('Delete'));
        expect(props.onEdit).toHaveBeenCalledWith('A');
        expect(props.onClone).toHaveBeenCalledWith('A');
        expect(props.onDelete).toHaveBeenCalledWith('A');
        // The row actions must not also open the page.
        expect(props.onOpen).not.toHaveBeenCalled();

        fireEvent.click(card);
        expect(props.onOpen).toHaveBeenCalledWith('A');
    });

    it('does not open another card while one is already opening', () => {
        const { props } = renderList({
            webpages: [row('A', 'Page A'), row('B', 'Page B')],
            loadingWebpageId: 'A',
        });
        const cards = screen.getAllByTestId('webpage-card');
        expect(cards[0]).toHaveAttribute('aria-busy', 'true');
        fireEvent.click(cards[1]);
        expect(props.onOpen).not.toHaveBeenCalled();
    });

    it('renames from the card on Enter, once', () => {
        const { props } = renderList();
        fireEvent.doubleClick(screen.getByText('Page A'));
        const input = screen.getByRole('textbox', { name: 'Rename' });
        fireEvent.change(input, { target: { value: '  Renamed  ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        fireEvent.blur(input);
        expect(props.onRename).toHaveBeenCalledTimes(1);
        expect(props.onRename).toHaveBeenCalledWith('A', 'Renamed');
    });
});
