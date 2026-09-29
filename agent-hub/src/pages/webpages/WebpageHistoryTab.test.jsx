import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

/**
 * De Geschiedenis-tab.
 *
 * Elke test hieronder verdedigt dezelfde regel, die dit scherm gevaarlijker
 * maakt dan de meeste: EEN GESCHIEDENIS WORDT GELOOFD. Wie er "You" leest,
 * denkt dat hij het zelf deed; wie er "±0" leest, denkt dat er niets
 * veranderde; wie er "v0" leest, denkt dat er een versie 0 was. Geen van drieën
 * mag uit een ONTBREKENDE waarde ontstaan:
 *
 *   - `actor: null` (nooit vastgelegd) én `actor.name: null` (account weg)
 *     lezen allebei als "Unknown". Nooit als de kijker, nooit als niets.
 *   - `lineDelta: null` tekent geen getal. `0` tekent er wél een — dat is een
 *     meting die zegt dat er evenveel regels overbleven.
 *   - `seq: null` tekent geen nummer.
 *
 * Daarnaast: TERUGZETTEN VRAAGT EERST. De kale confirm() met zijn
 * "localhost says"-balk is weg; er komt een dialoog in de eigen chrome, en
 * annuleren betekent dat er niets gebeurt. En het terugzetten zelf blijft bij
 * de editorpagina (`onRestore`) — deze tab kent het pad naar de save-baseline
 * niet en hoort dat ook niet te kennen.
 *
 * `WebpageEditor` is gemockt: Monaco laadt lui en heeft in jsdom niets te
 * zoeken; wat hier telt is DAT de weergave alleen-lezen is en welke bytes hij
 * krijgt.
 */

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

vi.mock('./WebpageEditor', () => ({
    default: ({ value, language, readOnly }) => (
        <div data-testid="version-editor" data-language={language} data-readonly={String(!!readOnly)}>{value}</div>
    ),
}));

import WebpageHistoryTab, { formatLineDelta } from './WebpageHistoryTab';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function row(over = {}) {
    return {
        id: 'v-a', summary: 'Edited in code', contentLength: 2048,
        createdAt: new Date().toISOString(), source: 'manual',
        seq: 12, actor: { id: 'alice', name: 'Alice Owner', isYou: true },
        lineDelta: 4, isPublished: false,
        ...over,
    };
}

/** Antwoord op GET /:id/versions. */
function list(versions, extra = {}) {
    return ok({ versions, hasMore: false, published: null, ...extra });
}

function renderTab(props = {}) {
    return render(<WebpageHistoryTab webpageId="wp1" onRestore={vi.fn()} {...props} />);
}

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockResolvedValue(list([]));
});

const urls = () => authFetch.mock.calls.map(([u]) => String(u));

// ── De rij ────────────────────────────────────────────────────────────

describe('what a row is allowed to say', () => {
    it('shows the number, the summary, where it came from and how much changed', async () => {
        authFetch.mockResolvedValue(list([row({ source: 'ai', summary: 'AI edited index.html' })]));
        renderTab();
        const r = await screen.findByTestId('version-row');
        expect(within(r).getByTestId('version-seq')).toHaveTextContent('v12');
        expect(r).toHaveTextContent('AI edited index.html');
        expect(within(r).getByTestId('version-source')).toHaveTextContent('AI');
        expect(within(r).getByTestId('version-line-delta')).toHaveTextContent('+4');
        expect(r).toHaveTextContent('2.0KB');
    });

    it('names the person who made it', async () => {
        authFetch.mockResolvedValue(list([row({ actor: { id: 'bob', name: 'Bob B', isYou: false } })]));
        renderTab();
        expect(await screen.findByTestId('version-actor')).toHaveTextContent('Bob B');
    });

    it('BIJT: a row with no actor says Unknown — never "You"', async () => {
        authFetch.mockResolvedValue(list([row({ actor: null })]));
        renderTab();
        const actor = await screen.findByTestId('version-actor');
        expect(actor).toHaveTextContent('Unknown');
        expect(actor).not.toHaveTextContent('You');
    });

    it('BIJT: an actor whose account cannot be read says Unknown, not an empty gap', async () => {
        authFetch.mockResolvedValue(list([row({ actor: { id: 'ghost', name: null, isYou: false } })]));
        renderTab();
        expect(await screen.findByTestId('version-actor')).toHaveTextContent('Unknown');
    });

    it('says "You" for your own row, even when the account carries no display name', async () => {
        authFetch.mockResolvedValue(list([row({ actor: { id: 'alice', name: null, isYou: true } })]));
        renderTab();
        expect(await screen.findByTestId('version-actor')).toHaveTextContent('You');
    });

    it('BIJT: an unmeasured line change draws nothing — not ±0', async () => {
        authFetch.mockResolvedValue(list([row({ lineDelta: null })]));
        renderTab();
        await screen.findByTestId('version-row');
        expect(screen.queryByTestId('version-line-delta')).not.toBeInTheDocument();
    });

    it('a measured nil change DOES draw, because that is a real answer', async () => {
        authFetch.mockResolvedValue(list([row({ lineDelta: 0 })]));
        renderTab();
        expect(await screen.findByTestId('version-line-delta')).toHaveTextContent('±0');
    });

    it('BIJT: a row from before the seq column draws no number — there is no v0', async () => {
        authFetch.mockResolvedValue(list([row({ seq: null })]));
        renderTab();
        await screen.findByTestId('version-row');
        expect(screen.queryByTestId('version-seq')).not.toBeInTheDocument();
    });

    it('formatLineDelta signs both directions and refuses anything that is not a number', () => {
        expect(formatLineDelta(12)).toBe('+12');
        expect(formatLineDelta(-7)).toBe('−7');
        expect(formatLineDelta(0)).toBe('±0');
        for (const bad of [null, undefined, NaN, Infinity, '4']) expect(formatLineDelta(bad)).toBeNull();
    });
});

// ── De gepubliceerde versie ───────────────────────────────────────────

describe('which version the audience reads', () => {
    it('shows the pinned version as a chip, taken from the server answer', async () => {
        authFetch.mockResolvedValue(list([row({ id: 'v-pub', isPublished: true })], {
            published: { versionId: 'v-pub', seq: 12 },
        }));
        renderTab();
        expect(await screen.findByTestId('published-chip')).toHaveTextContent('Published: v12');
        expect(within(await screen.findByTestId('version-row')).getByTestId('version-live')).toBeInTheDocument();
    });

    it('says nothing when nothing is pinned', async () => {
        authFetch.mockResolvedValue(list([row()]));
        renderTab();
        await screen.findByTestId('version-row');
        expect(screen.queryByTestId('published-chip')).not.toBeInTheDocument();
        expect(screen.queryByTestId('version-live')).not.toBeInTheDocument();
    });

    it('a pinned version that fell outside this page still gets a chip, without a fake number', async () => {
        authFetch.mockResolvedValue(list([row()], { published: { versionId: 'v-old', seq: null } }));
        renderTab();
        const chip = await screen.findByTestId('published-chip');
        expect(chip).toHaveTextContent('Published: an earlier version');
        expect(chip).not.toHaveTextContent('v0');
    });
});

// ── Terugzetten ───────────────────────────────────────────────────────

describe('restoring', () => {
    it('BIJT: asks first — clicking Restore does not restore anything yet', async () => {
        const onRestore = vi.fn();
        authFetch.mockResolvedValue(list([row()]));
        renderTab({ onRestore });
        fireEvent.click(await screen.findByText('Restore'));
        expect(await screen.findByRole('dialog')).toHaveTextContent('Restore v12?');
        expect(onRestore).not.toHaveBeenCalled();
    });

    it('BIJT: cancelling leaves the page exactly as it was', async () => {
        const onRestore = vi.fn();
        authFetch.mockResolvedValue(list([row()]));
        renderTab({ onRestore });
        fireEvent.click(await screen.findByText('Restore'));
        fireEvent.click(within(await screen.findByRole('dialog')).getByText('Cancel'));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(onRestore).not.toHaveBeenCalled();
    });

    it('hands the restore to the page and then reloads the list', async () => {
        const onRestore = vi.fn().mockResolvedValue(undefined);
        authFetch.mockResolvedValue(list([row({ id: 'v-a' })]));
        renderTab({ onRestore });
        fireEvent.click(await screen.findByText('Restore'));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getAllByText('Restore').at(-1));
        await waitFor(() => expect(onRestore).toHaveBeenCalledWith('v-a'));
        // Terugzetten voegt zelf een rij toe; de lijst mag niet blijven staan
        // zoals hij was.
        await waitFor(() => expect(urls().filter(u => u.endsWith('/wp1/versions')).length).toBe(2));
    });

    it('a restore that fails is shown, not swallowed into a list that looks unchanged', async () => {
        const onRestore = vi.fn().mockRejectedValue(new Error('Failed to restore version'));
        authFetch.mockResolvedValue(list([row()]));
        renderTab({ onRestore });
        fireEvent.click(await screen.findByText('Restore'));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getAllByText('Restore').at(-1));
        expect(await screen.findByRole('alert')).toHaveTextContent('Failed to restore version');
    });

    it('offers no Restore button at all when the page cannot carry it out', async () => {
        authFetch.mockResolvedValue(list([row()]));
        render(<WebpageHistoryTab webpageId="wp1" />);
        await screen.findByTestId('version-row');
        expect(screen.queryByText('Restore')).not.toBeInTheDocument();
        expect(screen.getByText('View')).toBeInTheDocument();
    });
});

// ── Bekijken ──────────────────────────────────────────────────────────

describe('viewing a version', () => {
    const withVersion = (files) => {
        authFetch.mockImplementation(async (url) => (
            String(url).endsWith('/versions')
                ? list([row({ id: 'v-a' })])
                : ok({ version: { ...row({ id: 'v-a' }), ...files } })
        ));
    };

    it('opens the snapshot read-only, through the SAME route the list uses', async () => {
        withVersion({ html: '<h1>old</h1>', css: 'a{}', js: '' });
        renderTab();
        fireEvent.click(await screen.findByText('View'));
        const editor = await screen.findByTestId('version-editor');
        expect(editor).toHaveTextContent('<h1>old</h1>');
        expect(editor).toHaveAttribute('data-readonly', 'true');
        expect(editor).toHaveAttribute('data-language', 'html');
        expect(urls()).toContain('https://host.example/api/webpages/wp1/versions/v-a');
    });

    it('switches between the three slots and comes back to the list', async () => {
        withVersion({ html: '<h1>old</h1>', css: 'body{color:red}', js: '' });
        renderTab();
        fireEvent.click(await screen.findByText('View'));
        await screen.findByTestId('version-editor');
        fireEvent.click(screen.getByText('style.css'));
        const editor = screen.getByTestId('version-editor');
        expect(editor).toHaveTextContent('body{color:red}');
        expect(editor).toHaveAttribute('data-language', 'css');
        fireEvent.click(screen.getByText('Back to history'));
        expect(await screen.findByTestId('version-row')).toBeInTheDocument();
    });

    it('a snapshot that cannot be read says so instead of showing an empty file', async () => {
        authFetch.mockImplementation(async (url) => (
            String(url).endsWith('/versions')
                ? list([row({ id: 'v-a' })])
                : { ok: false, status: 404, json: async () => ({ error: 'Version not found' }) }
        ));
        renderTab();
        fireEvent.click(await screen.findByText('View'));
        expect(await screen.findByRole('alert')).toHaveTextContent('Version not found');
        expect(screen.queryByTestId('version-editor')).not.toBeInTheDocument();
    });
});

// ── De lijst zelf ─────────────────────────────────────────────────────

describe('the list', () => {
    it('reports how many versions it found, so the header badge does not guess', async () => {
        const onLoaded = vi.fn();
        authFetch.mockResolvedValue(list([row({ id: 'a' }), row({ id: 'b' })]));
        renderTab({ onLoaded });
        await waitFor(() => expect(onLoaded).toHaveBeenCalledWith(2));
    });

    it('says there is nothing yet instead of drawing an empty frame', async () => {
        authFetch.mockResolvedValue(list([]));
        renderTab();
        expect(await screen.findByText(/No versions yet/)).toBeInTheDocument();
    });

    it('loads the next page from the offset it already has', async () => {
        authFetch
            .mockResolvedValueOnce(ok({ versions: [row({ id: 'a' })], hasMore: true, published: null }))
            .mockResolvedValueOnce(ok({ versions: [row({ id: 'b' })], hasMore: false, published: null }));
        renderTab();
        fireEvent.click(await screen.findByText('Load more'));
        await waitFor(() => expect(screen.getAllByTestId('version-row')).toHaveLength(2));
        expect(urls().at(-1)).toContain('offset=1');
    });

    it('a failed load is shown rather than left as an empty history', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Failed to list versions' }) });
        renderTab();
        expect(await screen.findByRole('alert')).toHaveTextContent('Failed to list versions');
    });
});

/* ── sluitronde: wat dit scherm NIET mag beweren ─────────────────────── */

describe('WebpageHistoryTab — de dekking van een momentopname', () => {
    it('legt een lege lijst niet uit als "je hebt nog niet genoeg bewerkt" als de functie hier niet werkt', async () => {
        // react-mui is het STANDAARD projecttype: de app woont er in extra
        // bestanden, en die zitten in geen enkele momentopname. De oude tekst
        // schoof de schuld naar de auteur voor iets dat daar principieel niet
        // gebeurt.
        authFetch.mockResolvedValue(list([], {
            coverage: { slots: ['html', 'css', 'js', 'db'], extraFiles: false, framework: 'react-mui', coversProject: false },
        }));
        renderTab();
        const empty = await screen.findByTestId('history-empty');
        expect(empty).toHaveTextContent(/only covers index\.html/i);
        expect(empty).not.toHaveTextContent(/every 5 minutes/i);
    });

    it('houdt de oude uitleg voor een project dat de drie bestanden WEL zijn', async () => {
        authFetch.mockResolvedValue(list([], {
            coverage: { slots: ['html', 'css', 'js', 'db'], extraFiles: false, framework: 'vanilla', coversProject: true },
        }));
        renderTab();
        expect(await screen.findByTestId('history-empty')).toHaveTextContent(/every 5 minutes/i);
        expect(screen.queryByTestId('history-coverage')).not.toBeInTheDocument();
    });

    it('zegt bij een gevulde lijst óók wat er buiten valt', async () => {
        authFetch.mockResolvedValue(list([row()], {
            coverage: { slots: ['html', 'css', 'js', 'db'], extraFiles: false, framework: 'react-mui', coversProject: false },
        }));
        renderTab();
        expect(await screen.findByTestId('history-coverage')).toHaveTextContent(/not part of a version/i);
    });

    it('belooft geen volledige terugkeer als er bestanden buiten de momentopname vallen', async () => {
        authFetch.mockResolvedValue(list([row()], {
            coverage: { slots: ['html', 'css', 'js', 'db'], extraFiles: false, framework: 'react-mui', coversProject: false },
        }));
        renderTab({ onRestore: vi.fn() });
        fireEvent.click(await screen.findByText('Restore'));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(/stays as it is now/i);
    });
});

describe('WebpageHistoryTab — een momentopname zonder bytes', () => {
    it('zegt dat hij niet te lezen is in plaats van een leeg bestand te tonen', async () => {
        // `readSlot` antwoordt met '' zowel voor "leeg" als voor "het object is
        // weg". Zonder het `readable`-veld kon de kijker die twee niet uit elkaar
        // houden — en Terugzetten op diezelfde rij schreef de leegte over de
        // levende pagina.
        authFetch.mockImplementation((url) => (String(url).includes('/versions/v-a')
            ? ok({ version: { ...row(), readable: false, html: '', css: '', js: '' } })
            : list([row()])));
        renderTab();
        fireEvent.click(await screen.findByText('View'));
        expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be read any more/i);
        expect(screen.queryByTestId('version-editor')).not.toBeInTheDocument();
    });
});

describe('WebpageHistoryTab — de teller van de ouder', () => {
    it('roept onLoaded niet aan vanuit een state-updater', async () => {
        // Een updater draait tijdens de render en hoort zuiver te zijn; `onLoaded`
        // is in de echte app een setState van de OUDER. React logt daar
        // "Cannot update a component while rendering a different component" — met
        // een kale vi.fn() als ouder valt dat niet op, dus hier staat een ECHTE
        // ouder omheen.
        const errors = [];
        const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.map(String).join(' ')); });
        try {
            authFetch.mockResolvedValueOnce(list([row({ id: 'v-a' })], { hasMore: true }));
            authFetch.mockResolvedValueOnce(list([row({ id: 'v-b', seq: 11 })]));
            function Parent() {
                const [count, setCount] = React.useState(0);
                return (
                    <>
                        <span data-testid="count">{count}</span>
                        <WebpageHistoryTab webpageId="wp1" onRestore={vi.fn()} onLoaded={setCount} />
                    </>
                );
            }
            render(<Parent />);
            fireEvent.click(await screen.findByText('Load more'));
            await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
            expect(errors.join('\n')).not.toMatch(/while rendering a different component/i);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('WebpageHistoryTab — een bron die deze lijst niet kent', () => {
    it('krijgt geen label van een ANDERE bron', async () => {
        authFetch.mockResolvedValue(list([row({ source: 'imported' })]));
        renderTab();
        const chip = await screen.findByTestId('version-source');
        expect(chip).toHaveTextContent('imported');
        expect(chip).not.toHaveTextContent('Manual');
    });
});
