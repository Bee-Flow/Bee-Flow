import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * De strip + de legenda van de Code-tab.
 *
 * `api()` is gemockt; de fixture spiegelt de `elements`-sectie van
 * GET /api/webpages/:id/bindings (server: core/webpages/webpageBindings.js).
 *
 * Wat hier vastligt is wat dit scherm mag BEWEREN. De harde regel: een pagina
 * waarvan de markeringen niet konden worden berekend mag er niet uitzien als
 * een pagina zonder koppelingen. Die twee zinnen moeten dus verschillend zijn,
 * en beide standen worden hieronder apart getoetst.
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/pages/webpages/WebpageCodeStrip.test.jsx
 */

const api = vi.fn();
vi.mock('./webpagesApi', () => ({
    api: (...args) => api(...args),
    default: (...args) => api(...args),
}));

const { default: WebpageCodeStrip, fileDecorations, useBfMarks } = await import('./WebpageCodeStrip');

const MARK = {
    source: 'index.html', slot: 'html', line: 3, tag: 'bf-table',
    known: true, family: 'datatable', targetId: 'tbl_1', fallback: null, missing: [], reason: null,
};

function elements(over = {}) {
    return {
        elements: {
            scanned: true,
            marks: [MARK],
            counts: { total: 1, known: 1, unknown: 0 },
            unknownTags: [],
            truncated: 0,
            ...over,
        },
    };
}

/** De strip zoals de IDE hem mount: één lezing, doorgegeven aan de legenda. */
function Harness({ enabled = true, ...props }) {
    const marksState = useBfMarks('wp1', { enabled });
    return (
        <WebpageCodeStrip
            framework="vanilla"
            html={'<h1>x</h1>\n<p>y</p>\n<bf-table source="tbl_1"></bf-table>'}
            css="body{}"
            js=""
            marksState={marksState}
            {...props}
        />
    );
}

beforeEach(() => { api.mockReset(); });

describe('de bestandenstrip', () => {
    it('toont een vak per bestand met de bytes erbij', async () => {
        api.mockResolvedValue(elements());
        render(<Harness />);

        expect(await screen.findByText('index.html')).toBeInTheDocument();
        expect(screen.getByText('style.css')).toBeInTheDocument();
        expect(screen.getByText('script.js')).toBeInTheDocument();
        // De bytes van style.css ("body{}") en van het lege script.js.
        expect(screen.getByText('6 B')).toBeInTheDocument();
        expect(screen.getByText('0 B')).toBeInTheDocument();
        expect(screen.getByText(/3 files/)).toBeInTheDocument();
    });

    it('BIJT — een react-mui-pagina toont zijn eigen bestanden, niet drie lege vakjes', async () => {
        api.mockResolvedValue(elements({ marks: [] }));
        render(
            <Harness
                framework="react-mui"
                html="" css="" js=""
                extraFiles={[{ path: 'src/App.jsx', size: 900, isText: true }]}
            />,
        );

        expect(await screen.findByText('src/App.jsx')).toBeInTheDocument();
        expect(screen.queryByText('style.css')).not.toBeInTheDocument();
        expect(screen.queryByText('script.js')).not.toBeInTheDocument();
    });

    it('verzwijgt een extra bestand naast de drie slots niet', async () => {
        api.mockResolvedValue(elements({ marks: [] }));
        render(<Harness extraFiles={[{ path: 'modules/state.js', size: 40, isText: true }]} />);

        expect(await screen.findByText('modules/state.js')).toBeInTheDocument();
        expect(screen.getByText(/4 files/)).toBeInTheDocument();
    });
});

describe('de legenda', () => {
    it('zegt wat de markering betekent, met de families die er echt zijn', async () => {
        api.mockResolvedValue(elements());
        render(<Harness />);

        expect(await screen.findByText('Highlighted = Studio link')).toBeInTheDocument();
        expect(screen.getByText(/Data table · 1/)).toBeInTheDocument();
        // Een familie die niet voorkomt, staat er ook niet — de legenda is een
        // uitleg van wat er staat, geen woordenlijst.
        expect(screen.queryByText(/Automation ·/)).not.toBeInTheDocument();
    });

    it('zolang de lezing loopt, staat er "aan het uitzoeken"', () => {
        api.mockReturnValue(new Promise(() => {}));
        render(<Harness />);

        expect(screen.getByText(/Working out the Studio links/)).toBeInTheDocument();
        expect(screen.queryByText(/could not be worked out/)).not.toBeInTheDocument();
    });

    it('BIJT — een mislukte lezing zegt dat de markering niet kon worden berekend', async () => {
        api.mockRejectedValue(new Error('API 500'));
        render(<Harness />);

        expect(await screen.findByText(/could not be worked out/)).toBeInTheDocument();
        // En NIET de zin die hoort bij een pagina die gewoon geen koppelingen
        // heeft: dat is precies het verschil dat deze legenda beschermt.
        expect(screen.queryByText(/Nothing in this code links to Studio/)).not.toBeInTheDocument();
    });

    it('BIJT — onleesbare bestanden op de server geven diezelfde melding, niet stilte', async () => {
        api.mockResolvedValue(elements({ scanned: false, marks: [], counts: { total: 0, known: 0, unknown: 0 } }));
        render(<Harness />);

        expect(await screen.findByText(/could not be worked out/)).toBeInTheDocument();
    });

    it('een gelezen pagina zonder koppelingen zegt dat er geen zijn', async () => {
        api.mockResolvedValue(elements({ marks: [], counts: { total: 0, known: 0, unknown: 0 } }));
        render(<Harness />);

        expect(await screen.findByText(/Nothing in this code links to Studio/)).toBeInTheDocument();
        expect(screen.queryByText(/could not be worked out/)).not.toBeInTheDocument();
    });

    it('een onbekend element krijgt zijn eigen kleur en naam', async () => {
        api.mockResolvedValue(elements({
            marks: [{ ...MARK, tag: 'bf-widget', known: false, family: null, targetId: null, missing: null, reason: 'unknown-bf-element' }],
            counts: { total: 1, known: 0, unknown: 1 },
            unknownTags: ['bf-widget'],
        }));
        render(<Harness />);

        expect(await screen.findByText(/Not recognised · 1/)).toBeInTheDocument();
    });

    it('zegt erbij dat de markering van de laatst opgeslagen versie komt', async () => {
        api.mockResolvedValue(elements());
        render(<Harness dirtyFiles={{ html: true }} />);

        expect(await screen.findByText(/from the last saved version/)).toBeInTheDocument();
    });

    it('een lezer krijgt de eigenaar-only-zin, niet "er zijn geen koppelingen"', async () => {
        api.mockResolvedValue(elements());
        render(<Harness readOnly />);

        expect(await screen.findByText(/Only the page owner/)).toBeInTheDocument();
        expect(screen.queryByText(/Nothing in this code links to Studio/)).not.toBeInTheDocument();
    });

    it('meldt wat er niet meer bij kon', async () => {
        api.mockResolvedValue(elements({ truncated: 12 }));
        render(<Harness />);

        expect(await screen.findByText(/12 more are not highlighted/)).toBeInTheDocument();
    });
});

describe('useBfMarks', () => {
    it('haalt de markeringen op bij /bindings — dezelfde parser als de rest van W4', async () => {
        api.mockResolvedValue(elements());
        render(<Harness />);
        await waitFor(() => expect(api).toHaveBeenCalledWith('/wp1/bindings'));
    });

    it('BIJT — de ALLEREERSTE render staat al op "aan het lezen", niet op "niets gevonden"', () => {
        // Via de hook zelf, want de DOM kan dit niet bewijzen: `render()` laat
        // de effecten meteen lopen, dus in een test is de laadstand er altijd
        // al. In de browser is dat niet zo — daar schildert React vóór het
        // effect, en die ene frame zou de legenda anders laten beweren dat de
        // markering niet kon worden berekend terwijl er nog niet is gekeken.
        api.mockReturnValue(new Promise(() => {}));
        const seen = [];
        function Probe() {
            const state = useBfMarks('wp1', { enabled: true });
            if (seen.length === 0) seen.push(state);
            return null;
        }
        render(<Probe />);

        expect(seen[0].loading).toBe(true);
        expect(seen[0].available).toBe(false);
    });

    it('BIJT — uitgeschakeld blijft niet hangen op "aan het uitzoeken"', () => {
        // De Code-tab is dicht: niets ophalen. Maar "niet ophalen" mag geen
        // eeuwige laadstand worden — dan zou de strip bij het openen van een
        // pagina zonder id blijven draaien.
        render(<Harness enabled={false} />);

        expect(api).not.toHaveBeenCalled();
        expect(screen.queryByText(/Working out the Studio links/)).not.toBeInTheDocument();
    });
});

describe('fileDecorations', () => {
    const t = (key, fallback, params) => {
        let value = typeof fallback === 'string' ? fallback : key;
        const p = typeof fallback === 'string' ? params : fallback;
        if (p) for (const [k, v] of Object.entries(p)) value = value.replace(`{${k}}`, String(v));
        return value;
    };

    it('BIJT — markeringen van een ander bestand lekken niet in deze editor', () => {
        const marks = [
            MARK,
            { ...MARK, slot: null, source: 'src/App.jsx', line: 99 },
        ];
        const forHtml = fileDecorations({ marks, fileKey: 'html', t });
        expect(forHtml).toHaveLength(1);
        expect(forHtml[0].range.startLineNumber).toBe(3);

        const forExtra = fileDecorations({ marks, fileKey: 'extra:src/App.jsx', t });
        expect(forExtra).toHaveLength(1);
        expect(forExtra[0].range.startLineNumber).toBe(99);
    });

    it('schrijft waar het element aan hangt in het label', () => {
        const [deco] = fileDecorations({ marks: [MARK], fileKey: 'html', t });
        expect(deco.options.after.content).toContain('bf-table → tbl_1');
    });

    it('een element zonder koppeling zegt dat, in plaats van een leeg pijltje', () => {
        const [deco] = fileDecorations({
            marks: [{ ...MARK, targetId: null, missing: ['source'] }],
            fileKey: 'html',
            t,
        });
        expect(deco.options.after.content).toContain('Not linked yet');
        expect(deco.options.hoverMessage.value).toContain('needs source');
    });

    it('zonder open bestand valt er niets te tekenen', () => {
        expect(fileDecorations({ marks: [MARK], fileKey: null, t })).toEqual([]);
    });
});

/* ── sluitronde: wat het publiceren met deze koppelingen doet ──────────── */

describe('WebpageCodeStrip — niet elke koppeling overleeft het publiceren', () => {
    const BUTTON = {
        source: 'index.html', slot: 'html', line: 5, tag: 'bf-button',
        known: true, family: 'automation', targetId: 'auto_1', fallback: null, missing: [], reason: null,
    };

    it('telt in de legenda hoeveel er bij publiceren stoppen', async () => {
        // Drie van de vijf elementen zijn op een gepubliceerde pagina inert (daar
        // draait geen JS). Dit scherm is het enige dat de koppelingen laat zien,
        // dus het hoort ook dat verschil te laten zien in plaats van alles als
        // een gelijkwaardige "Studio link" te tekenen.
        api.mockResolvedValue(elements({ marks: [MARK, BUTTON], counts: { total: 2, known: 2, unknown: 0 } }));
        render(<Harness />);
        const note = await screen.findByTestId('legend-inert-on-publish');
        expect(note).toHaveTextContent('1');
        expect(note).toHaveTextContent(/stop working once the page is published/i);
    });

    it('zegt er niets over als alles het publiceren overleeft', async () => {
        api.mockResolvedValue(elements());
        render(<Harness />);
        await screen.findByText(/Studio link/);
        expect(screen.queryByTestId('legend-inert-on-publish')).not.toBeInTheDocument();
    });

    it('zet de zin van de lezer in de tooltip van een element dat straks dood is', async () => {
        // Een t()-stub die WEL invult, want de zin komt via {notice} binnen.
        const t = (k, f, vars) => String(f).replace(/\{(\w+)\}/g, (_, n) => (vars && vars[n] !== undefined ? vars[n] : ''));
        const decos = fileDecorations({ marks: [BUTTON], fileKey: 'html', t });
        const hover = decos[0].options.hoverMessage.value;
        expect(hover).toMatch(/Once published/);
        // Precies de zin uit de gespiegelde registry — dus dezelfde die de lezer
        // op /w/<slug> te zien krijgt, en niet een tweede formulering hier.
        const { BF_ELEMENTS } = await import('../../utils/bfElements');
        const notice = BF_ELEMENTS.find(e => e.tag === 'bf-button').surfaces.vanillaSnapshot.notice;
        expect(hover).toContain(notice);
    });

    it('elke familie die een markering kan dragen, heeft een NAAM (geen kale sleutel)', async () => {
        const { BF_FAMILIES } = await import('./bfDecorations');
        const { familyLabel } = await import('./WebpageCodeStrip');
        for (const family of BF_FAMILIES) {
            // Terugvallen op de kale sleutel is zichtbaar lelijk in plaats van
            // stil, maar het blijft een tweede, met de hand bijgehouden lijst —
            // deze test dwingt af dat een nieuwe familie er ook een naam krijgt.
            expect(familyLabel((k, f) => f, family), `${family} heeft geen naam`).not.toBe(family);
        }
    });
});
