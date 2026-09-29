import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterisation of the personal tokenization vault (Settings → Security).
 *
 * This screen is the dictionary behind Privacy Shield: which real personal
 * value each placeholder stands for. The source says values are shown, not
 * masked, on purpose — so these tests pin exactly what becomes visible, what
 * a failed call looks like, and what the two destructive paths do.
 *
 * Nothing here judges the behaviour; where today's behaviour is a wart the
 * test NAME says so.
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

// i18n shim. Two reasons it is not the plain "fallback wins" stub:
//
//  1. IDENTITY STABILITY. load() is a useCallback keyed on `t`, and both
//     effects depend on load. The real hook memoises t (useCallback on
//     [strings]) so that holds in the app — but the hook's documented
//     provider-less fallback returns a FRESH t on every call, which turns
//     this component into an unbounded fetch/render loop. A stable t is what
//     production actually has; the coupling itself is pinned below.
//  2. TRUTHFULNESS. The EN catalogue — not the inline fallback string — is
//     what a user sees, and for a few keys the two differ. Resolving against
//     the real catalogue keeps these assertions equal to the real screen.
import EN from '../../i18n/en-defaults';

const stableT = (key, fallbackOrParams, paramsArg) => {
    const hasStringFallback = typeof fallbackOrParams === 'string';
    const params = hasStringFallback ? paramsArg : fallbackOrParams;
    let value = EN[key];
    if (typeof value !== 'string') value = hasStringFallback ? fallbackOrParams : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) {
            value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
    }
    return value;
};
const i18n = { value: { t: stableT, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} } };
vi.mock('../../hooks/useTranslation', () => ({
    useTranslation: () => i18n.value,
    default: () => i18n.value,
}));

import TokenVaultSection from './TokenVaultSection';
import { authFetch } from '../../utils/helpers';

const jsonRes = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

const ENTRY = {
    id: 'e1',
    token: '[PERSON_1]',
    value: 'Jan Jansen',
    useCount: 12,
    lastUsedAt: '2026-08-01T10:00:00Z',
    unreadable: false,
};

/** Serve one GET payload; every DELETE succeeds unless a test says otherwise. */
function serve(payload, { deleteRes = jsonRes({ ok: true }) } = {}) {
    authFetch.mockImplementation(async (_url, opts = {}) => {
        if (opts.method === 'DELETE') return deleteRes;
        return jsonRes(payload);
    });
}

const gets = () => authFetch.mock.calls.filter(c => (c[1]?.method ?? 'GET') === 'GET');
const deletes = () => authFetch.mock.calls.filter(c => c[1]?.method === 'DELETE');
const lastGetUrl = () => String(gets().at(-1)?.[0]);

/** Mount and wait until the first payload has landed. */
async function mount(payload, opts) {
    serve(payload, opts);
    const view = render(<TokenVaultSection />);
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull());
    return view;
}

describe('TokenVaultSection — loading and the first request', () => {
    beforeEach(() => { cleanup(); vi.clearAllMocks(); i18n.value = { ...i18n.value, t: stableT }; });

    it('asks for the first page with limit=100 and offset=0 and no search term', async () => {
        await mount({ entries: [], total: 0 });
        expect(String(gets()[0][0])).toBe('/api/privacy/token-vault?limit=100&offset=0');
    });

    it('fires the same first page TWICE on mount (wart: the mount effect and the debounce both run)', async () => {
        // The 300ms debounce exists so typing does not hammer a rate-limited
        // endpoint — but it also fires once for the initial empty search, on
        // top of the mount effect. Two identical GETs per visit.
        await mount({ entries: [], total: 0 });
        await waitFor(() => expect(gets()).toHaveLength(2), { timeout: 2000 });
        expect(String(gets()[1][0])).toBe('/api/privacy/token-vault?limit=100&offset=0');
    });

    it('shows the catalogue loading label while the first call is in flight', async () => {
        let release;
        authFetch.mockImplementation(() => new Promise(res => { release = () => res(jsonRes({ entries: [], total: 0 })); }));
        render(<TokenVaultSection />);
        expect(screen.getByText('Loading...')).toBeInTheDocument();
        expect(screen.queryByRole('table')).toBeNull();
        release();
        await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull());
    });

    it('re-fetches whenever the translator changes identity (wart: load() is keyed on t)', async () => {
        // Pinned deliberately: this coupling is why the hook's own
        // provider-less fallback (a new t per render) would loop forever here.
        const { rerender } = await mount({ entries: [], total: 0 });
        await waitFor(() => expect(gets()).toHaveLength(2), { timeout: 2000 });

        i18n.value = { ...i18n.value, t: (k, f, p) => stableT(k, f, p) };
        rerender(<TokenVaultSection />);

        await waitFor(() => expect(gets().length).toBeGreaterThan(2));
    });
});

describe('TokenVaultSection — what the list shows', () => {
    beforeEach(() => { cleanup(); vi.clearAllMocks(); i18n.value = { ...i18n.value, t: stableT }; });

    it('renders the real personal value in plain text next to its placeholder', async () => {
        await mount({ entries: [ENTRY], total: 1 });

        expect(screen.getByText('[PERSON_1]')).toBeInTheDocument();
        // By design (see the file header): the vault is unreadable if masked.
        expect(screen.getByText('Jan Jansen')).toBeInTheDocument();
        expect(screen.getByText('12×')).toBeInTheDocument();
        expect(screen.getByText('1 stored')).toBeInTheDocument();
    });

    it('renders the four data column headers plus a screen-reader-only actions column', async () => {
        await mount({ entries: [ENTRY], total: 1 });
        const headers = screen.getAllByRole('columnheader').map(h => h.textContent);
        expect(headers).toEqual(['Placeholder', 'Stands for', 'Used', 'Last used', 'Actions']);
    });

    it('hides the value and offers deletion when the server cannot open the row', async () => {
        await mount({
            entries: [{ ...ENTRY, unreadable: true, value: 'should never be rendered' }],
            total: 1,
        });
        expect(screen.getByText('Cannot be opened — you can delete it')).toBeInTheDocument();
        expect(screen.queryByText('should never be rendered')).toBeNull();
        expect(screen.getByRole('button', { name: 'Forget this: [PERSON_1]' })).toBeInTheDocument();
    });

    it('shows an em dash for a never-used entry and a bare × for a missing count (wart)', async () => {
        await mount({
            entries: [{ id: 'e2', token: '[ORG_1]', value: 'Acme BV' }],
            total: 1,
        });
        const row = screen.getByText('Acme BV').closest('tr');
        expect(within(row).getByText('—')).toBeInTheDocument();
        // useCount undefined renders the multiplier with nothing in front of it.
        expect(within(row).getByText('×')).toBeInTheDocument();
    });

    it('shows the empty state with a hint when nothing is stored', async () => {
        await mount({ entries: [], total: 0 });
        expect(screen.getByText('Nothing stored yet.')).toBeInTheDocument();
        expect(screen.getByText(/Entries appear here once Privacy Shield hides/)).toBeInTheDocument();
        expect(screen.queryByRole('table')).toBeNull();
    });

    it('labels the refresh control in Dutch on an English screen (wart: common.refresh is mistranslated)', async () => {
        // en-defaults maps common.refresh to "Vernieuwen"; the component's own
        // 'Refresh' fallback never wins because the key exists.
        await mount({ entries: [], total: 0 });
        expect(screen.getByRole('button', { name: 'Vernieuwen' })).toBeInTheDocument();
    });

    it('re-requests the current offset when refresh is pressed', async () => {
        await mount({ entries: [ENTRY], total: 1 });
        await waitFor(() => expect(gets()).toHaveLength(2), { timeout: 2000 });
        fireEvent.click(screen.getByRole('button', { name: 'Vernieuwen' }));
        await waitFor(() => expect(gets()).toHaveLength(3));
        expect(lastGetUrl()).toBe('/api/privacy/token-vault?limit=100&offset=0');
    });
});

describe('TokenVaultSection — search', () => {
    beforeEach(() => { cleanup(); vi.clearAllMocks(); i18n.value = { ...i18n.value, t: stableT }; });

    it('sends the typed term as a search parameter after the debounce', async () => {
        await mount({ entries: [ENTRY], total: 1 });
        fireEvent.change(screen.getByLabelText('Search a value or placeholder…'), { target: { value: 'jan' } });

        await waitFor(
            () => expect(lastGetUrl()).toBe('/api/privacy/token-vault?limit=100&offset=0&search=jan'),
            { timeout: 2000 },
        );
    });

    it('drops the hint and changes the wording when a search returns nothing', async () => {
        await mount({ entries: [ENTRY], total: 1 });
        serve({ entries: [], total: 0 });
        fireEvent.change(screen.getByLabelText('Search a value or placeholder…'), { target: { value: 'zzz' } });

        expect(await screen.findByText('Nothing matches that search.', {}, { timeout: 2000 })).toBeInTheDocument();
        expect(screen.queryByText(/Entries appear here once Privacy Shield hides/)).toBeNull();
    });
});

describe('TokenVaultSection — failed loads', () => {
    beforeEach(() => { cleanup(); vi.clearAllMocks(); i18n.value = { ...i18n.value, t: stableT }; });

    it('SECURITY: a failed first load reads as an empty vault, error banner and all', async () => {
        authFetch.mockResolvedValue(jsonRes({ error: 'boom' }, 500));
        render(<TokenVaultSection />);

        expect(await screen.findByText('Could not load your vault. Please try again.')).toBeInTheDocument();
        // The three things a user reads next to that banner all say "empty".
        expect(screen.getByText('Nothing stored yet.')).toBeInTheDocument();
        expect(screen.getByText('0 stored')).toBeInTheDocument();
        expect(screen.queryByText('Forget everything in this vault')).toBeNull();
    });

    it('treats a thrown request exactly like a non-OK response', async () => {
        authFetch.mockRejectedValue(new Error('offline'));
        render(<TokenVaultSection />);
        expect(await screen.findByText('Could not load your vault. Please try again.')).toBeInTheDocument();
        expect(screen.getByText('Nothing stored yet.')).toBeInTheDocument();
    });

    it('keeps the previously loaded rows on screen when a RELOAD fails', async () => {
        await mount({ entries: [ENTRY], total: 1 });
        authFetch.mockResolvedValue(jsonRes({}, 500));
        fireEvent.click(screen.getByRole('button', { name: 'Vernieuwen' }));

        expect(await screen.findByText('Could not load your vault. Please try again.')).toBeInTheDocument();
        expect(screen.getByText('Jan Jansen')).toBeInTheDocument();
        expect(screen.getByText('1 stored')).toBeInTheDocument();
    });
});

describe('TokenVaultSection — forgetting one entry', () => {
    beforeEach(() => { cleanup(); vi.clearAllMocks(); i18n.value = { ...i18n.value, t: stableT }; });

    it('puts the real value in the app\'s own dialog and sends nothing when it is declined', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm');
        await mount({ entries: [ENTRY], total: 1 });

        fireEvent.click(screen.getByRole('button', { name: 'Forget this: [PERSON_1]' }));

        const dialog = await screen.findByRole('dialog', { name: 'Forget "Jan Jansen"?' });
        expect(within(dialog).getByText('Any saved message that still shows [PERSON_1] will keep showing the placeholder — this cannot be undone.')).toBeInTheDocument();
        expect(confirmSpy).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(deletes()).toHaveLength(0);
        expect(screen.getByText('Jan Jansen')).toBeInTheDocument();
        confirmSpy.mockRestore();
    });

    it('falls back to the placeholder in the dialog when the value cannot be opened', async () => {
        await mount({ entries: [{ ...ENTRY, unreadable: true, value: null }], total: 1 });

        fireEvent.click(screen.getByRole('button', { name: 'Forget this: [PERSON_1]' }));
        expect(await screen.findByRole('dialog', { name: 'Forget "[PERSON_1]"?' })).toBeInTheDocument();
    });

    it('deletes by id and drops the row and the counter without re-reading the list', async () => {
        await mount({ entries: [ENTRY], total: 3 });
        await waitFor(() => expect(gets()).toHaveLength(2), { timeout: 2000 });

        fireEvent.click(screen.getByRole('button', { name: 'Forget this: [PERSON_1]' }));
        fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

        await waitFor(() => expect(screen.queryByText('Jan Jansen')).toBeNull());
        expect(deletes()[0][0]).toBe('/api/privacy/token-vault/e1');
        expect(screen.getByText('2 stored')).toBeInTheDocument();
        // Removal is local only — no refresh GET follows.
        expect(gets()).toHaveLength(2);
    });

    it('WART: a rejected delete is completely silent — the row stays, nothing is said', async () => {
        await mount({ entries: [ENTRY], total: 1 }, { deleteRes: jsonRes({ error: 'nope' }, 403) });

        fireEvent.click(screen.getByRole('button', { name: 'Forget this: [PERSON_1]' }));
        fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

        await waitFor(() => expect(deletes()).toHaveLength(1));
        expect(screen.getByText('Jan Jansen')).toBeInTheDocument();
        expect(screen.getByText('1 stored')).toBeInTheDocument();
        expect(screen.queryByText('Could not load your vault. Please try again.')).toBeNull();
    });
});

describe('TokenVaultSection — forgetting everything', () => {
    beforeEach(() => { cleanup(); vi.clearAllMocks(); i18n.value = { ...i18n.value, t: stableT }; });

    it('hides the destructive action entirely while the vault is empty', async () => {
        await mount({ entries: [], total: 0 });
        expect(screen.queryByText('Forget everything in this vault')).toBeNull();
    });

    it('asks for a second confirmation in the page and sends nothing on cancel', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        await mount({ entries: [ENTRY], total: 1 });

        fireEvent.click(screen.getByText('Forget everything in this vault'));
        expect(screen.getByText(/Forget all stored values\?/)).toBeInTheDocument();
        // The in-page step replaces the browser dialog: window.confirm is not used here.
        expect(confirmSpy).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByText(/Forget all stored values\?/)).toBeNull();
        expect(deletes()).toHaveLength(0);
        confirmSpy.mockRestore();
    });

    it('deletes the whole collection and reloads the list on confirm', async () => {
        await mount({ entries: [ENTRY], total: 1 });
        await waitFor(() => expect(gets()).toHaveLength(2), { timeout: 2000 });

        fireEvent.click(screen.getByText('Forget everything in this vault'));
        serve({ entries: [], total: 0 });
        fireEvent.click(screen.getByRole('button', { name: 'Yes, forget everything' }));

        await waitFor(() => expect(deletes()[0][0]).toBe('/api/privacy/token-vault'));
        await waitFor(() => expect(screen.getByText('Nothing stored yet.')).toBeInTheDocument());
        expect(screen.getByText('0 stored')).toBeInTheDocument();
        expect(screen.queryByText('Forget everything in this vault')).toBeNull();
    });

    it('WART: a rejected clear-all is silent too — the warning just stays open', async () => {
        await mount({ entries: [ENTRY], total: 1 }, { deleteRes: jsonRes({ error: 'nope' }, 500) });

        fireEvent.click(screen.getByText('Forget everything in this vault'));
        fireEvent.click(screen.getByRole('button', { name: 'Yes, forget everything' }));

        await waitFor(() => expect(deletes()).toHaveLength(1));
        expect(screen.getByText(/Forget all stored values\?/)).toBeInTheDocument();
        expect(screen.getByText('Jan Jansen')).toBeInTheDocument();
        expect(screen.queryByText('Could not load your vault. Please try again.')).toBeNull();
    });
});

describe('TokenVaultSection — paging', () => {
    beforeEach(() => { cleanup(); vi.clearAllMocks(); i18n.value = { ...i18n.value, t: stableT }; });

    it('offers "Show more" whenever the loaded rows fall short of the total', async () => {
        await mount({ entries: [ENTRY], total: 5 });
        expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
    });

    it('hides "Show more" once the loaded rows account for the total', async () => {
        await mount({ entries: [ENTRY], total: 1 });
        expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });

    it('WART: "Show more" jumps a full page and REPLACES the rows instead of appending', async () => {
        // Only one row was returned, yet the next request starts at offset 100,
        // and the arriving page overwrites the visible list.
        await mount({ entries: [ENTRY], total: 5 });
        await waitFor(() => expect(gets()).toHaveLength(2), { timeout: 2000 });

        serve({ entries: [{ ...ENTRY, id: 'e9', token: '[PERSON_9]', value: 'Piet Peters' }], total: 5 });
        fireEvent.click(screen.getByRole('button', { name: 'Show more' }));

        expect(await screen.findByText('Piet Peters')).toBeInTheDocument();
        expect(screen.queryByText('Jan Jansen')).toBeNull();
        expect(lastGetUrl()).toBe('/api/privacy/token-vault?limit=100&offset=100');
        // offset 100 + 1 row is no longer < 5, so the button disappears as well.
        expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });
});
