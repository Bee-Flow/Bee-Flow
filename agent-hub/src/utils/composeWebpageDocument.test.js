import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BF_ELEMENTS } from './bfElements';
import { CLIENT_HANDLING, clientCoverageGaps, localNameOf, buildBfElementsScript } from './bfElementsRuntime';
import composeWebpageDocument from './composeWebpageDocument';

/**
 * Every injected shim (auth, DB, bridges, selection bridge) is emitted from a
 * template literal, where `\/` silently cooks to `/`. That once turned the
 * beeflowApp shim's `.replace(/^\/+/, "")` into `.replace(/^/+/, "")` — an
 * unterminated regex literal that killed the whole bridges <script> block with
 * "SyntaxError: Invalid regular expression: missing /", leaving beeflowAI /
 * beeflowApp / beeflowAutomations / beeflowIntegrations undefined in the
 * preview. These tests parse every emitted inline script so any future
 * de-escaping regression fails loudly.
 */

function composeFullDoc() {
    return composeWebpageDocument(
        {
            html: '<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>',
            css: 'body { margin: 0; }',
            js: 'console.log("hi");',
        },
        {
            selectionBridge: true,
            dbToken: 'tok_test',
            dbApiBase: 'https://api.example.test/',
            dbWebpageId: 'wp_123',
        }
    );
}

function extractInlineScripts(doc) {
    const bodies = [];
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(doc)) !== null) {
        const attrs = m[1] || '';
        // Only classic/module JS — skip anything explicitly non-JS (importmap etc.)
        if (/type\s*=/i.test(attrs) && !/type\s*=\s*["']?(text\/javascript|module)/i.test(attrs)) continue;
        if (m[2].trim()) bodies.push(m[2]);
    }
    return bodies;
}

describe('composeWebpageDocument injected scripts', () => {
    it('emits every inline script as syntactically valid JavaScript', () => {
        const doc = composeFullDoc();
        const scripts = extractInlineScripts(doc);
        // auth + db + bridges + user js + selection bridge
        expect(scripts.length).toBeGreaterThanOrEqual(5);
        for (const body of scripts) {
            expect(() => new Function(body)).not.toThrow();
        }
    });

    it('keeps the escaped slash in the beeflowApp route regex', () => {
        const doc = composeFullDoc();
        expect(doc).toContain('replace(/^\\/+/, "")');
        expect(doc).not.toContain('replace(/^/+/, "")');
    });

    // ── W3: window.beeflowTables ─────────────────────────────────────
    it('exposes beeflowTables with query/insert/update on the tables route', () => {
        const doc = composeFullDoc();
        expect(doc).toContain('window.beeflowTables');
        expect(doc).toContain('"/tables/" + encodeURIComponent(datatableId) + "/query"');
        expect(doc).toContain('"/tables/" + encodeURIComponent(datatableId) + "/insert"');
        expect(doc).toContain('"/tables/" + encodeURIComponent(datatableId) + "/update"');
    });

    it('never emits beeflowTables without a token — the shims are gated as one', () => {
        const doc = composeWebpageDocument(
            { html: '<html><body></body></html>', css: '', js: '' },
            { dbToken: null, dbApiBase: 'https://api.example.test', dbWebpageId: 'wp_123' }
        );
        expect(doc).not.toContain('window.beeflowTables');
    });

    it('sends expectedUpdatedAt on update — a write without it must not be expressible', () => {
        const doc = composeFullDoc();
        // The shim passes on the fourth parameter; leave it out and the server
        // refuses. What must NOT stand here is a default that invents it.
        expect(doc).toContain('expectedUpdatedAt: expectedUpdatedAt');
        expect(doc).not.toMatch(/expectedUpdatedAt:\s*(expectedUpdatedAt\s*\|\||Date|new Date|"")/);
    });
});

// ─────────────────────────────────────────────────────────────────────
// W4 — the Bee Flow elements in the client composer.
//
// This is the path for the PREVIEW and for a LOGGED-IN reader: there JavaScript
// runs, so here all elements really work. The tests below run the emitted block in
// the test's own jsdom, with imitated bridges, and look at what lands in the DOM.
// That is deliberately not a text comparison on the emitted source: that can be
// right while nothing happens.
//
// The emphasis lies on FAILING. An element that cannot read its source must SHOW
// that, and the reasons must stay apart: "you may not see this", "is not there
// (any more)", "could not read", "empty" and "there is no bridge here" are five
// different things that call for different behaviour from the reader.
// ─────────────────────────────────────────────────────────────────────

/** Every element name as a whole word — `bf-stat-value` is a CSS class, not a tag. */
const TAG_WORD = new RegExp(`(?<![-\\w])(?:${BF_ELEMENTS.map(e => e.tag).join('|')})(?![-\\w])`, 'g');

const tagOf = (local) => (BF_ELEMENTS.find(e => localNameOf(e.tag) === local) || {}).tag;

let runtimeLoaded = false;

/**
 * Run the emitted element block once in the test's jsdom.
 * The block only reads the bridges at the moment it renders an element, so loading
 * it once and setting up different bridges per test is enough — and it avoids a
 * pile of MutationObservers.
 */
function loadRuntime() {
    if (runtimeLoaded) return;
    const doc = composeFullDoc();
    const body = extractInlineScripts(doc).find(b => b.includes('beeflowBf'));
    expect(body, 'het elementblok wordt uitgezonden').toBeTruthy();
    new Function(body)();
    runtimeLoaded = true;
}

const flush = async () => {
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
};

/** Zet markup neer, laat het blok erover lopen, wacht de beloftes af. */
async function mount(html) {
    loadRuntime();
    document.body.innerHTML = html;
    window.beeflowBf.refresh();
    await flush();
}

const stateOf = (el) => {
    const box = el.querySelector('[data-bf-state]');
    return box ? box.getAttribute('data-bf-state') : null;
};
const first = (sel) => document.body.querySelector(sel);

/** Een fout zoals de brug hem gooit: een Error met een HTTP-status erop. */
function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    delete window.beeflowTables;
    delete window.beeflowAutomations;
    delete window.beeflowAI;
    document.body.innerHTML = '';
});

describe('W4 — het elementblok komt uit de registry, niet uit dit bestand', () => {
    it('noemt elk element uit het vocabulaire in de uitgezonden pagina', () => {
        const doc = composeFullDoc();
        expect(BF_ELEMENTS.length).toBeGreaterThan(3);
        for (const def of BF_ELEMENTS) {
            expect(doc, `de pagina kent ${def.tag} niet`).toContain(def.tag);
        }
    });

    it('schrijft in de bron van de renderer geen enkele elementnaam op', () => {
        // The same rule as server/core/webpages/bfElements.drift.test.js for the
        // two composers: everything that is written here by hand is a second list
        // that can fall behind the registry.
        // Path from the project root: vitest runs from agent-hub/ (see the test
        // instructions), and the sanity assert below makes a wrong path RED
        // instead of silently green.
        const src = fs.readFileSync(path.resolve('src/utils/bfElementsRuntime.ts'), 'utf8');
        expect(src.length, 'sanity: de bron is gelezen').toBeGreaterThan(500);
        expect(src.match(TAG_WORD) || []).toEqual([]);
    });

    it('bedient het vocabulaire volledig — beide richtingen', () => {
        // BITES: put a sixth element in the registry and this test turns red
        // before a reader sees an empty spot.
        expect(clientCoverageGaps()).toEqual({ missing: [], stray: [], unimplemented: [] });
        // Third direction: the renderer must ALSO really exist. Without this
        // direction a key in CLIENT_HANDLING could promise 'live' while no
        // function existed for it — the bridge then lied to the page.
        expect(clientCoverageGaps(buildBfElementsScript()).unimplemented).toEqual([]);
        expect(Object.keys(CLIENT_HANDLING).length).toBe(BF_ELEMENTS.length);
    });

    it('stuurt alleen mee wat de browser nodig heeft, niet de interne verantwoording', () => {
        // The registry carries a Dutch `why` per place for DEVELOPERS.
        // That should not end up in a reader's page; the projection
        // leaves it behind. Without this test, "just put the whole registry
        // in" is an easy, silent deterioration.
        const doc = composeFullDoc();
        for (const def of BF_ELEMENTS) {
            for (const surface of Object.values(def.surfaces || {})) {
                if (!surface || !surface.why) continue;
                expect(doc, `de verantwoording van ${def.tag} lekt de pagina in`).not.toContain(surface.why);
            }
        }
    });

    it('wordt OOK uitgezonden zonder token — anders zwijgt een element juist als er niets is', () => {
        const doc = composeWebpageDocument(
            { html: '<html><head></head><body></body></html>', css: '', js: '' },
            { dbToken: null, dbApiBase: null, dbWebpageId: null }
        );
        expect(doc).toContain('window.beeflowBf');
        // …and it still does not define any bridge: that gate stays closed.
        expect(doc).not.toContain('window.beeflowTables');
    });

    it('antwoordt met dezelfde vorm als de publieke brug', async () => {
        loadRuntime();
        for (const def of BF_ELEMENTS) {
            expect(window.beeflowBf.state(def.tag)).toBe(def.surfaces.clientComposer.state);
            expect(window.beeflowBf.state(def.tag.toUpperCase())).toBe(def.surfaces.clientComposer.state);
        }
        expect(window.beeflowBf.state('bf-nope')).toBe('unknown');
        expect(window.beeflowBf.reason('bf-nope')).toMatch(/Unknown Bee Flow element/);
    });
});

describe('W4 — een tabel bij een ingelogde lezer', () => {
    it('haalt de rijen op als de bezoeker en zet ze in een gewone tabel', async () => {
        const seen = [];
        window.beeflowTables = {
            query: (id, opts) => {
                seen.push([id, opts]);
                return Promise.resolve({ rows: [{ name: 'Ada', n: 1 }], columns: ['name', 'n'], hasMore: false });
            },
        };
        await mount(`<${tagOf('table')} source="tbl_1"></${tagOf('table')}>`);
        expect(seen).toHaveLength(1);
        expect(seen[0][0]).toBe('tbl_1');
        expect(first('table.bf-grid')).toBeTruthy();
        expect(first('table.bf-grid').textContent).toContain('Ada');
        // Success is the ABSENCE of a state — neither on the notice nor on
        // the element itself is anything then shown.
        expect(stateOf(first(tagOf('table')))).toBe(null);
        expect(first(tagOf('table')).getAttribute('data-bf-state')).toBe(null);
    });

    it('leest de oudere schrijfwijze van het bron-attribuut ook', async () => {
        const seen = [];
        window.beeflowTables = {
            query: (id) => { seen.push(id); return Promise.resolve({ rows: [{ a: 1 }], columns: ['a'] }); },
        };
        // `datatable` is the alias of `source` in the registry; that translation
        // should come from the vocabulary, not from a second list.
        await mount(`<${tagOf('table')} datatable="tbl_alias"></${tagOf('table')}>`);
        expect(seen).toEqual(['tbl_alias']);
    });

    it('houdt de limiet binnen de bovengrens van de registry', async () => {
        const seen = [];
        window.beeflowTables = {
            query: (id, opts) => { seen.push(opts); return Promise.resolve({ rows: [{ a: 1 }], columns: ['a'] }); },
        };
        const max = BF_ELEMENTS.find(e => e.tag === tagOf('table')).attributes.find(a => a.max).max;
        await mount(`<${tagOf('table')} source="t" limit="99999"></${tagOf('table')}>`);
        expect(seen[0].limit).toBe(max);
    });

    it('onderscheidt "mag je niet zien", "is er niet", "kon niet lezen" en "leeg"', async () => {
        const cases = [
            ['forbidden', () => Promise.reject(httpError(403, 'no grade'))],
            ['gone', () => Promise.reject(httpError(404, 'This page is not linked to that table'))],
            ['failed', () => Promise.reject(new Error('socket hang up'))],
            ['empty', () => Promise.resolve({ rows: [], columns: ['a'] })],
        ];
        const seen = [];
        for (const [expected, impl] of cases) {
            window.beeflowTables = { query: impl };
            await mount(`<${tagOf('table')} source="t"></${tagOf('table')}>`);
            const el = first(tagOf('table'));
            expect(stateOf(el), `${expected}: er hoort een melding te staan`).toBe(expected);
            expect(el.getAttribute('data-bf-state'), `${expected}: ook op het element zelf`).toBe(expected);
            expect(el.textContent.trim().length, `${expected}: de melding is niet leeg`).toBeGreaterThan(0);
            seen.push(stateOf(el));
        }
        // The four states must REALLY differ; one shared "something went
        // wrong" is exactly what this step must eradicate.
        expect(new Set(seen).size).toBe(4);
    });

    it('zegt het als er hier helemaal geen brug is', async () => {
        await mount(`<${tagOf('table')} source="t"></${tagOf('table')}>`);
        expect(stateOf(first(tagOf('table')))).toBe('unavailable');
    });

    it('meldt een ontbrekend verplicht attribuut in plaats van niets te doen', async () => {
        window.beeflowTables = { query: () => Promise.reject(new Error('should not be called')) };
        await mount(`<${tagOf('table')}></${tagOf('table')}>`);
        const el = first(tagOf('table'));
        expect(stateOf(el)).toBe('invalid');
        expect(el.textContent).toContain('source');
    });

    it('vertelt het als de uitslag is afgekapt', async () => {
        window.beeflowTables = {
            query: () => Promise.resolve({ rows: [{ a: 1 }], columns: ['a'], hasMore: true }),
        };
        await mount(`<${tagOf('table')} source="t"></${tagOf('table')}>`);
        expect(first('[data-bf-state="partial"]')).toBeTruthy();
    });
});

describe('W4 — een enkel getal uit een tabel', () => {
    const stat = () => tagOf('stat');

    it('telt de rijen als er niets anders gevraagd is', async () => {
        window.beeflowTables = {
            query: () => Promise.resolve({ rows: [{ a: 1 }, { a: 2 }, { a: 3 }], columns: ['a'] }),
        };
        await mount(`<${stat()} source="t" label="Orders"></${stat()}>`);
        expect(first('.bf-stat-value').textContent).toBe('3');
        expect(first('.bf-stat-label').textContent).toBe('Orders');
    });

    it('telt op over een kolom, en rondt niet stilletjes een verkeerd getal af', async () => {
        window.beeflowTables = {
            query: () => Promise.resolve({ rows: [{ a: 1.5 }, { a: 2 }, { a: 'x' }], columns: ['a'] }),
        };
        await mount(`<${stat()} source="t" agg="sum" column="a"></${stat()}>`);
        expect(first('.bf-stat-value').textContent).toBe('3.5');
    });

    it('eist een kolom zodra er iets anders dan tellen gevraagd wordt', async () => {
        window.beeflowTables = { query: () => Promise.reject(new Error('should not be called')) };
        await mount(`<${stat()} source="t" agg="avg"></${stat()}>`);
        const el = first(stat());
        expect(stateOf(el)).toBe('invalid');
        expect(el.textContent).toContain('column');
    });

    it('weigert een rekenwijze die het vocabulaire niet kent', async () => {
        window.beeflowTables = { query: () => Promise.reject(new Error('should not be called')) };
        await mount(`<${stat()} source="t" agg="median" column="a"></${stat()}>`);
        expect(stateOf(first(stat()))).toBe('invalid');
        expect(first(stat()).textContent).toContain('median');
    });

    it('zegt "dat mag je niet zien" als de kolom niet gebonden is — geen nul', async () => {
        window.beeflowTables = {
            query: () => Promise.resolve({ rows: [{ a: 1 }], columns: ['a'] }),
        };
        await mount(`<${stat()} source="t" agg="sum" column="salaris"></${stat()}>`);
        const el = first(stat());
        expect(stateOf(el)).toBe('forbidden');
        expect(el.textContent).not.toContain('0');
    });

    it('zegt het als een getal over een afgekapte uitslag gaat', async () => {
        window.beeflowTables = {
            query: () => Promise.resolve({ rows: [{ a: 1 }], columns: ['a'], hasMore: true }),
        };
        await mount(`<${stat()} source="t"></${stat()}>`);
        expect(first('.bf-stat-value').textContent).toBe('1');
        expect(first('[data-bf-state="partial"]')).toBeTruthy();
    });
});

describe('W4 — een knop die een automatisering start', () => {
    const button = () => tagOf('button');

    it('start de automatisering en meldt dat hij klaar is', async () => {
        const calls = [];
        window.beeflowAutomations = {
            run: (id, inputs, opts) => { calls.push([id, inputs, opts]); return Promise.resolve({ runId: 'r1', status: 'success' }); },
        };
        await mount(`<${button()} run="auto_1">Verstuur</${button()}>`);
        const btn = first('button.bf-btn');
        expect(btn.textContent).toBe('Verstuur');
        btn.click();
        await flush();
        expect(calls[0][0]).toBe('auto_1');
        expect(calls[0][2]).toEqual({ wait: true });
        expect(stateOf(first(button()))).toBe('done');
    });

    it('meldt een MISLUKTE run als mislukt, ook al antwoordde de route met 200', async () => {
        // The route returns 200 with the error in the body. Whoever only looks at the
        // HTTP status would write "succeeded" here over something that broke.
        window.beeflowAutomations = {
            run: () => Promise.resolve({ runId: 'r1', status: 'error', error: 'step 2 exploded' }),
        };
        await mount(`<${button()} run="auto_1">Go</${button()}>`);
        first('button.bf-btn').click();
        await flush();
        const el = first(button());
        expect(stateOf(el)).toBe('failed');
        expect(el.textContent).toContain('step 2 exploded');
    });

    it('meldt een run die nog niet klaar is als nog-niet-klaar', async () => {
        window.beeflowAutomations = {
            run: () => Promise.resolve({ runId: 'r1', status: 'awaiting_approval' }),
        };
        await mount(`<${button()} run="auto_1">Go</${button()}>`);
        first('button.bf-btn').click();
        await flush();
        expect(stateOf(first(button()))).toBe('pending');
        expect(first(button()).textContent).toContain('awaiting_approval');
    });

    it('bevestigt met twee klikken, niet met window.confirm', async () => {
        // De preview draait in een iframe met sandbox="allow-scripts allow-forms".
        // Zonder allow-modals negeert de browser confirm() STIL: een knop die
        // daarop leunt doet nooit iets, en niemand ziet waarom.
        const confirmSpy = vi.fn(() => true);
        const original = window.confirm;
        window.confirm = confirmSpy;
        const calls = [];
        window.beeflowAutomations = {
            run: (id) => { calls.push(id); return Promise.resolve({ status: 'success' }); },
        };
        await mount(`<${button()} run="auto_1" confirm="yes">Go</${button()}>`);
        const btn = first('button.bf-btn');
        btn.click();
        await flush();
        expect(calls, 'de eerste klik voert nog niets uit').toEqual([]);
        expect(btn.textContent).toMatch(/confirm/i);
        btn.click();
        await flush();
        expect(calls).toEqual(['auto_1']);
        expect(confirmSpy).not.toHaveBeenCalled();
        window.confirm = original;
    });

    it('staat er zichtbaar uitgeschakeld bij als er geen brug is', async () => {
        await mount(`<${button()} run="auto_1">Go</${button()}>`);
        expect(first('button.bf-btn').disabled).toBe(true);
        expect(stateOf(first(button()))).toBe('unavailable');
    });

    it('meldt een geweigerde automatisering als "mag niet", niet als "kapot"', async () => {
        window.beeflowAutomations = { run: () => Promise.reject(httpError(403, 'Automation not granted to this webpage')) };
        await mount(`<${button()} run="auto_1">Go</${button()}>`);
        first('button.bf-btn').click();
        await flush();
        expect(stateOf(first(button()))).toBe('forbidden');
    });
});

describe('W4 — een formulier als trigger van een automation', () => {
    const form = () => tagOf('form');

    it('stuurt de velden van de auteur mee en laat die velden staan', async () => {
        const calls = [];
        window.beeflowAutomations = {
            run: (id, inputs) => { calls.push([id, inputs]); return Promise.resolve({ status: 'success' }); },
        };
        await mount(
            `<${form()} automation="auto_2" submit-label="Aanmelden">`
            + '<input name="email" value="a@b.nl">'
            + '<textarea name="note">hoi</textarea>'
            + '<input type="checkbox" name="ok" checked>'
            + `</${form()}>`
        );
        expect(first('input[name="email"]'), 'de velden van de auteur blijven staan').toBeTruthy();
        const btn = first('button.bf-btn');
        expect(btn.textContent).toBe('Aanmelden');
        btn.click();
        await flush();
        expect(calls[0][0]).toBe('auto_2');
        expect(calls[0][1]).toEqual({ email: 'a@b.nl', note: 'hoi', ok: true });
        expect(stateOf(first(form()))).toBe('done');
    });

    it('meldt een ontbrekende automatisering in plaats van een dode knop', async () => {
        window.beeflowAutomations = { run: () => Promise.resolve({ status: 'success' }) };
        await mount(`<${form()}><input name="a"></${form()}>`);
        const el = first(form());
        expect(stateOf(el)).toBe('invalid');
        expect(el.textContent).toContain('automation');
        expect(first('button.bf-btn')).toBeNull();
    });

    it('zegt het als er geen brug is en verstuurt niets', async () => {
        await mount(`<${form()} automation="auto_2"><input name="a"></${form()}>`);
        expect(first('button.bf-btn').disabled).toBe(true);
        expect(stateOf(first(form()))).toBe('unavailable');
    });
});

describe('W4 — het gespreksblok', () => {
    const agent = () => tagOf('agent');

    it('praat via de bestaande agentische lus en schrijft het antwoord mee', async () => {
        const calls = [];
        window.beeflowAI = {
            ask: (prompt, opts) => {
                calls.push([prompt, opts]);
                opts.onToken('Hal');
                opts.onToken('lo');
                return Promise.resolve({ text: 'Hallo' });
            },
        };
        await mount(`<${agent()} placeholder="Vraag maar"></${agent()}>`);
        expect(first('.bf-agent-input').placeholder).toBe('Vraag maar');
        first('.bf-agent-input').value = 'hoi';
        first('button.bf-btn').click();
        await flush();
        expect(calls[0][0]).toBe('hoi');
        expect(first('.bf-agent-you').textContent).toBe('hoi');
        expect(first('.bf-agent-bot').textContent).toBe('Hallo');
    });

    it('laat de brug de agent van de pagina kiezen als er geen id staat', async () => {
        const calls = [];
        window.beeflowAI = { ask: (p, opts) => { calls.push(opts); return Promise.resolve({ text: 'ok' }); } };
        await mount(`<${agent()}></${agent()}>`);
        first('.bf-agent-input').value = 'x';
        first('button.bf-btn').click();
        await flush();
        expect(calls[0].agentId).toBeUndefined();
    });

    it('geeft een uitdrukkelijk gekozen agent wel door', async () => {
        const calls = [];
        window.beeflowAI = { ask: (p, opts) => { calls.push(opts); return Promise.resolve({ text: 'ok' }); } };
        await mount(`<${agent()} agent="ag_9"></${agent()}>`);
        first('.bf-agent-input').value = 'x';
        first('button.bf-btn').click();
        await flush();
        expect(calls[0].agentId).toBe('ag_9');
    });

    it('toont een leeg antwoord als leeg, en een fout als fout', async () => {
        window.beeflowAI = { ask: () => Promise.resolve({ text: '' }) };
        await mount(`<${agent()}></${agent()}>`);
        first('.bf-agent-input').value = 'x';
        first('button.bf-btn').click();
        await flush();
        expect(stateOf(first(agent()))).toBe('empty');

        window.beeflowAI = { ask: () => Promise.reject(httpError(403, 'AI bridge is disabled for this webpage')) };
        await mount(`<${agent()}></${agent()}>`);
        first('.bf-agent-input').value = 'x';
        first('button.bf-btn').click();
        await flush();
        expect(stateOf(first(agent()))).toBe('forbidden');
    });

    it('zegt het als de agentische lus hier niet bestaat', async () => {
        // The public bridge deliberately leaves `ask` out. A page that passes by there
        // must not get to show a dead input field.
        window.beeflowAI = { chat: () => Promise.resolve('x') };
        await mount(`<${agent()}></${agent()}>`);
        expect(stateOf(first(agent()))).toBe('unavailable');
        expect(first('.bf-agent-input').disabled).toBe(true);
    });
});

describe('W4 — wat er NIET stil mag verdwijnen', () => {
    it('maakt een onbekend element herkenbaar onbekend', async () => {
        await mount('<bf-widget action="x">Klik</bf-widget>');
        const el = first('bf-widget');
        expect(stateOf(el)).toBe('unknown');
        expect(el.textContent).toContain('bf-widget');
    });

    it('pakt ook op wat de pagina zelf later neerzet', async () => {
        window.beeflowTables = { query: () => Promise.resolve({ rows: [{ a: 1 }], columns: ['a'] }) };
        await mount('<div id="host"></div>');
        // No refresh(): this is precisely the case in which script.js builds its own
        // markup and there is nobody to have the block look again.
        document.getElementById('host').innerHTML = `<${tagOf('table')} source="t"></${tagOf('table')}>`;
        await flush();
        expect(first('table.bf-grid')).toBeTruthy();
    });

    it('werkt een element hoogstens één keer bij', async () => {
        let calls = 0;
        window.beeflowTables = { query: () => { calls++; return Promise.resolve({ rows: [{ a: 1 }], columns: ['a'] }); } };
        await mount(`<${tagOf('table')} source="t"></${tagOf('table')}>`);
        window.beeflowBf.refresh();
        window.beeflowBf.refresh();
        await flush();
        expect(calls).toBe(1);
    });
});

describe('W4-sluitronde — wat van de auteur is, blijft van de auteur', () => {
    it('gooit de terugvaltekst van de auteur niet weg als het misgaat', async () => {
        // Both server places explicitly keep the author's children (inertBlock moves them,
        // bfDecorate leaves them alone). This place did the opposite: `clear()` removed
        // everything, so with a typo in an attribute the author's entire markup
        // disappeared from the preview.
        await mount(`<${tagOf('table')} source="t">This table loads shortly.</${tagOf('table')}>`);
        const el = first(tagOf('table'));
        expect(el.textContent).toContain('This table loads shortly');
        expect(el.getAttribute('data-bf-state')).toBe('unavailable');
    });

    it('houdt de velden van een formulier staan als een attribuut verkeerd heet', async () => {
        // One typo (`automatie` instead of `automation`) must not clear out the
        // author's entire form.
        const form = tagOf('form');
        await mount(`<${form} automatie="auto_2"><label>E-mail<input name="email"></label><textarea name="note"></textarea></${form}>`);
        const el = first(form);
        expect(el.querySelectorAll('input[name],textarea[name]')).toHaveLength(2);
        expect(el.getAttribute('data-bf-state')).toBe('invalid');
    });

    it('verbergt de terugvaltekst zodra het element het WEL doet', async () => {
        window.beeflowTables = {
            query: () => Promise.resolve({ rows: [{ a: 1 }], columns: ['a'] }),
        };
        await mount(`<${tagOf('table')} source="t">This table loads shortly.</${tagOf('table')}>`);
        const own = first(`${tagOf('table')} .bf-own`);
        expect(own).toBeTruthy();
        expect(own.hidden).toBe(true);
        expect(first('table.bf-grid')).toBeTruthy();
    });

    it('zet de stand op het ELEMENT, ook bij een knop, formulier of agentblok', async () => {
        // For those three, the notice hangs under a plain <div class="bf-status">.
        // If the mark sat only there, `bf-button[data-bf-state]` would never
        // match — precisely the hook that the public bridge DOES set.
        await mount(
            `<${tagOf('button')} run="a1">Go</${tagOf('button')}>`
            + `<${tagOf('form')} automation="a1"></${tagOf('form')}>`
            + `<${tagOf('agent')}></${tagOf('agent')}>`,
        );
        for (const local of ['button', 'form', 'agent']) {
            expect(first(`${tagOf(local)}[data-bf-state]`), `${local} draagt geen stand`).toBeTruthy();
            expect(first(tagOf(local)).getAttribute('data-bf-state')).toBe('unavailable');
        }
    });
});

describe('W4-sluitronde — hetzelfde getal in de preview als op de gepubliceerde pagina', () => {
    it('vraagt voor het getalelement de rijgrens uit de registry op', async () => {
        const seen = [];
        window.beeflowTables = {
            query: (id, opts) => { seen.push(opts); return Promise.resolve({ rows: [{ a: 1 }], columns: ['a'] }); },
        };
        const stat = BF_ELEMENTS.find(e => localNameOf(e.tag) === 'stat');
        expect(stat.reads.rowsMax, 'sanity: de registry noemt een rijgrens').toBeGreaterThan(0);
        await mount(`<${stat.tag} source="t" agg="sum" column="a"></${stat.tag}>`);
        // Without this limit the client asked for nothing and the server chose its own
        // default (50), while the published page reads 500.
        expect(seen[0]).toEqual({ limit: stat.reads.rowsMax });
    });
});

describe('W4-sluitronde — het blok bereikt ook een pagina zonder <head>', () => {
    it('zendt het elementblok uit als de HTML een fragment is', () => {
        // An AI-written index.html is not always a complete document. No assertion
        // touched that branch, so you could remove it without a single red test — and
        // then the fragment falls back to exactly the silence that W4 eradicates.
        const doc = composeWebpageDocument(
            { html: `<div id="app"><${tagOf('table')} source="t"></${tagOf('table')}></div>`, css: '', js: '' },
            { dbToken: 'tok', dbApiBase: 'https://api.example.test/', dbWebpageId: 'wp_1' },
        );
        expect(doc).toContain('<!DOCTYPE html>');
        expect(doc).toContain('window.beeflowBf');
        for (const def of BF_ELEMENTS) expect(doc).toContain(def.tag);
    });
});
