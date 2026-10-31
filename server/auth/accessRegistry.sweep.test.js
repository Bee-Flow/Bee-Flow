'use strict';

/**
 * Every route is accounted for: enforced, app-wide. (U4)
 *
 * The successor of the /auth drift test for the rest of the surface. The two tests split the work:
 *
 *   accessRegistry.drift.test.js  loads the REAL app in a throwaway child process
 *       (routeWalk.cli.js) and verifies the triagedPrefixes in depth:
 *       machine gate tags, chain equivalence, probe <-> declaration.
 *   this test  reads index.js and every reachable route file as TEXT
 *       (testUtils/routeSurfaceSweep.js; never a require of the app, which
 *       starts schedulers) and demands app-wide ACCOUNTABILITY: every route has a
 *       gate on the mount, router or route, a gate-shaped check in the handler,
 *       a declaration in accessRegistry, or an explicit exemption
 *       below with a verifiable reason. The sweep skips routes under
 *       triagedPrefixes; the drift test already covers those, and deeper.
 *
 * A new route that fits nowhere is a RED TEST with a hint, not a silently
 * open endpoint. That this mechanism really bites is proven by the synthetic
 * fixtures at the bottom: a fixture app with an ungated, unregistered route
 * demonstrably goes red, without canary files in the real tree.
 *
 * WHAT THIS PROVES: accountability, not sufficiency. "requireAuth in the
 * chain" does not say the RIGHT caller gets in; that stays the job of
 * the per-route authz tests and of the drift test as triagedPrefixes
 * grows. And like migrateDb.registration.test.js this is deliberately static:
 * accountability is a textual fact.
 *
 * Run: cd server && node --test --test-force-exit auth/accessRegistry.sweep.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('./accessRegistry');
const { parseSurface, sweepSurface } = require('../testUtils/routeSurfaceSweep');

const SERVER = path.resolve(__dirname, '..');

// The deliberately open routes live in auth/openRoutes.js so routes.contract.test.js
// reads the same list; this test keeps the name it always used.
const { OPEN_ROUTES: BEWUST_OPEN } = require('./openRoutes');

/**
 * Gaps that exist today and are explicitly PINNED here instead of staying
 * silent. This test deliberately changes no behaviour: a route that should be
 * gated but is not stays as it is and is listed here, visibly,
 * with severity. The way out: add a gate (a separate, deliberate change) and
 * remove the entry; the redundancy test below forces that removal as soon as
 * the gate is really there, so this list can only shrink towards the
 * truth.
 */
const GEPIND_ONGEGATE = new Map([
    // /versions/* (4 routes) closed 2026-09-05: router.use(requireAuth) +
    // canModifyAgent per route (the routes/agents/publishVersion.js idiom);
    // proven by routes/versions.authz.test.js, declared in accessRegistry.js.
    // /api/documents/* (3 routes) closed 2026-09-05: router.use(requireAuth)
    // (same idiom; classification: forgotten gate, not a guest path; no
    // anonymous caller exists, the mobile "Generated" tab sends the session cookie).
    // Proven by routes/documents.authz.test.js, declared in accessRegistry.js.
    // REMAINING POINT (deliberate, documented in the header of routes/documents.js):
    // /list stays shared between logged-in users; the tmp folder carries no
    // ownership, so scoping per user is impossible without an invented ledger.
    // file:routes/memory.js classified 2026-09-05 (dossier 4a) as a deliberate
    // guest path; since the memory overhaul closed with router.use(requireAuth)
    // (see the note at BEWUST_OPEN above).
]);

const redenVan = (v) => (typeof v === 'string' ? v : v.reden);

// ── De echte sweep ───────────────────────────────────────────────────────────
const readSource = (rel) => {
    try {
        const p = path.join(SERVER, rel);
        return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
    } catch (_) { return null; }
};
const isTriaged = (p) => registry.triagedPrefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));

const exempt = new Map([...BEWUST_OPEN, ...GEPIND_ONGEGATE].map(([k, v]) => [k, redenVan(v)]));
const surface = parseSurface(readSource, 'index.js', { skipPrefix: isTriaged });
const result = sweepSurface(surface, registry, exempt);

test('de parser ziet de echte app — geen stille verschrompeling', () => {
    // Vloeren tegen parserrot (het migrateDb-patroon: verdacht kleine ladder).
    // Vandaag: ~1367 routes uit ~276 bestanden.
    //
    // De vorige vloer stond op 900/150 bij ~1155 routes — zó ruim dat de
    // map-splitsing van routes/{webpages,datatables,playbooks}.js 91 routes uit
    // dit oppervlak kon laten verdwijnen zonder één rode test. Die marge was
    // het gat. De vloer staat nu op ~95% van vandaag: het wegvallen van één
    // routegroep is meteen rood, en wie legitiem routes verwijdert verlaagt de
    // vloer BEWUST, in dezelfde commit, met de reden erbij.
    assert.ok(result.stats.routes >= 1300, `verdacht klein oppervlak (${result.stats.routes} routes) — is de parser of index.js kapot, of is er een routegroep stilletjes onleesbaar geworden?`);
    assert.ok(result.stats.files >= 260, `verdacht weinig routebestanden (${result.stats.files})`);
    assert.ok(result.stats.skippedMounts >= 1, 'geen enkele triaged mount overgeslagen — is triagedPrefixes leeg? Dan dekt de drifttest niets meer en klopt de taakverdeling niet');
});

test('elke route is verantwoord: gegate, gedeclareerd of expliciet vrijgesteld', () => {
    const lijst = result.unaccounted.map((u) => `  ${u.id}  (${u.file})`).join('\n');
    assert.deepStrictEqual(result.unaccounted.map((u) => u.id), [],
        'deze routes zijn nergens verantwoord — geen gate op mount/router/route, geen\n' +
        'gate-vormige check in de handler, geen declaratie, geen vrijstelling:\n' +
        `${lijst}\n` +
        'Verantwoord ze op één van deze manieren:\n' +
        '  1. zet de gate op de mount (server/index.js) of als router.use(...) in het\n' +
        '     routebestand — dan ziet deze sweep hem vanzelf;\n' +
        '  2. gate in de handlerbody? Declareer de route dan in auth/accessRegistry.js\n' +
        '     (enforcement handler/scoped, met note) — of maak er een tagGate-middleware van;\n' +
        '  3. bewust zonder keten-gate (publiek, token-credential, zelf-gescoped)? Zet hem\n' +
        '     met een controleerbare reden in BEWUST_OPEN in deze test;\n' +
        '  4. een gat dat je nu niet dicht? Pin hem in GEPIND_ONGEGATE mét ernst — nooit stil.');
});

test('elke statisch onleesbare mount is verantwoord', () => {
    const lijst = result.unaccountedOpaque.map((o) => `  ${o.prefix || '(zonder pad)'}  (${o.file})`).join('\n');
    assert.deepStrictEqual(result.unaccountedOpaque, [],
        'deze mounts verwijzen naar bestanden zonder statisch leesbare routes (dynamische\n' +
        'registratie, register-helpers of middleware):\n' +
        `${lijst}\n` +
        'Zet er een mount:-/file:-vrijstelling voor in BEWUST_OPEN met de reden waarom de\n' +
        'routes erachter toch verantwoord zijn — of maak de registratie statisch leesbaar.');
});

test('elke vrijstelling wijst nog naar iets dat bestaat', () => {
    // The anti-rot mechanism for the lists themselves (migrateDb pattern):
    // a key that no longer touches any route or mount is a dead claim.
    assert.deepStrictEqual(result.staleExempt, [],
        'deze vrijstellingen raken geen enkele bestaande route of mount meer — de route is\n' +
        'verdwenen of hernoemd. Verwijder de entry, of corrigeer de sleutel.');
});

test('een gepind gat dat gedicht is, verlaat de lijst', () => {
    // As soon as a route from GEPIND_ONGEGATE becomes structurally gated, the entry
    // is redundant and MUST go; that way the debt list shrinks towards the truth
    // and "what is still open here" remains an honest answer.
    const dichtgezet = result.redundantExempt.filter((k) => GEPIND_ONGEGATE.has(k));
    assert.deepStrictEqual(dichtgezet, [],
        'deze GEPIND_ONGEGATE-entries dekken alleen nog routes die inmiddels gegate zijn —\n' +
        'mooi werk, maar verwijder de entry (en de bijbehorende bevinding) nu ook.');
});

test('geen sleutel staat in beide lijsten', () => {
    const dubbel = [...GEPIND_ONGEGATE.keys()].filter((k) => BEWUST_OPEN.has(k));
    assert.deepStrictEqual(dubbel, [], 'bewust open én een gepind gat is een tegenspraak — kies er één');
});

test('elke bewijs-claim klopt nog', () => {
    for (const [key, v] of [...BEWUST_OPEN, ...GEPIND_ONGEGATE]) {
        if (typeof v === 'string') continue;
        const { file, marker } = v.bewijs;
        const p = path.join(SERVER, file);
        assert.ok(fs.existsSync(p), `${key}: bewijs wijst naar een verdwenen bestand: ${file}`);
        assert.ok(fs.readFileSync(p, 'utf8').includes(marker),
            `${key}: ${file} bevat "${marker}" niet meer — de claim is vals, herbeoordeel de entry`);
    }
});

test('elke reden is een verhaal, geen invuloefening', () => {
    for (const [key, v] of [...BEWUST_OPEN, ...GEPIND_ONGEGATE]) {
        assert.ok(redenVan(v).length >= 30, `${key}: reden te dun om te controleren — schrijf op waaróm dit verantwoord is`);
    }
});

// ═══ Synthetic fixtures: proof that this test bites ═════════════════════════
// The same parser and the same pure sweep, fed with an in-memory mini app.
// If the red case here ever turns green, the sweep has lost its teeth.
describe('synthetisch: het mechanisme zelf', () => {
    const FIXTURE = {
        'index.js': `
            const express = require('express');
            const { requireAuth: requireAuthedUser } = require('./auth');
            const app = express();
            app.use(express.json());
            app.use('/api/dingen', require('./routes/dingen'));
            app.use('/api/beveiligd', requireAuthedUser, require('./routes/beveiligd'));
            app.use('/api/leeg', require('./routes/leeg'));
            app.listen(3000);
        `,
        'routes/dingen.js': `
            const router = require('express').Router();
            router.get('/', async (req, res) => { res.json(await alles()); });
            module.exports = router;
        `,
        'routes/beveiligd.js': `
            const express = require('express');
            const router = express.Router();
            router.get('/', (req, res) => res.json({ ok: true }));
            module.exports = router;
        `,
        'routes/leeg.js': `
            module.exports = function alleenMiddleware(req, res, next) { next(); };
        `,
    };
    const leesFixture = (p) => (Object.prototype.hasOwnProperty.call(FIXTURE, p) ? FIXTURE[p] : null);
    const leegRegistry = { triagedPrefixes: [], routes: {}, untriaged: [] };
    const veeg = (reg, vrij) => sweepSurface(parseSurface(leesFixture, 'index.js'), reg, vrij || new Map());

    test('een ongegate, niet-geregistreerde route levert rood op', () => {
        const r = veeg(leegRegistry);
        assert.deepEqual(r.unaccounted.map((u) => u.id), ['GET /api/dingen'],
            'de sweep hoort precies de ongegate fixture-route als onverantwoord te melden');
    });

    test('een gate op de mount verantwoordt de route vanzelf', () => {
        const r = veeg(leegRegistry);
        assert.ok(!r.unaccounted.some((u) => u.id === 'GET /api/beveiligd'),
            'de requireAuthedUser-mount hoort GET /api/beveiligd te verantwoorden');
    });

    test('een router.use-gate in het bestand verantwoordt wat erna komt — niet wat ervoor kwam', () => {
        const files = {
            ...FIXTURE,
            'routes/dingen.js': `
                const { requireAuth } = require('../auth/permissions');
                const router = require('express').Router();
                router.get('/open', (req, res) => res.json({}));
                router.use(requireAuth);
                router.get('/', async (req, res) => { res.json(await alles()); });
                module.exports = router;
            `,
        };
        const r = sweepSurface(parseSurface((p) => files[p] ?? null, 'index.js'), leegRegistry, new Map());
        const ids = r.unaccounted.map((u) => u.id);
        assert.ok(!ids.includes('GET /api/dingen'), 'route ná router.use(requireAuth) is verantwoord');
        assert.ok(ids.includes('GET /api/dingen/open'), 'route VÓÓR router.use(requireAuth) blijft onverantwoord — volgorde telt (het cowork-patroon)');
    });

    test('een gate-vormige check in de handler verantwoordt de route', () => {
        const files = {
            ...FIXTURE,
            'routes/dingen.js': `
                const router = require('express').Router();
                router.get('/', async (req, res) => {
                    if (!(await canReadDing(ding, userId, req))) return res.status(403).json({});
                    res.json(ding);
                });
                module.exports = router;
            `,
        };
        const r = sweepSurface(parseSurface((p) => files[p] ?? null, 'index.js'), leegRegistry, new Map());
        assert.ok(!r.unaccounted.some((u) => u.id === 'GET /api/dingen'));
    });

    test('haken in een regex-literal in de handler breken de argumentextractie niet', () => {
        // Zonder try-blok eromheen liet `[^\\]]` de balancer vroegtijdig sluiten
        // en zag de probe een lege handler.
        const files = {
            ...FIXTURE,
            'routes/dingen.js': `
                const router = require('express').Router();
                router.post('/', async (req, res) => {
                    if (!(await canReadDing(ding, userId, req))) return res.status(403).json({});
                    const raw = String(req.body.text || '');
                    const cleaned = raw.replace(/\\[ESCALATE(?::\\s*[^\\]]+)?\\]/i, '');
                    res.json({ cleaned });
                });
                module.exports = router;
            `,
        };
        const r = sweepSurface(parseSurface((p) => files[p] ?? null, 'index.js'), leegRegistry, new Map());
        assert.ok(!r.unaccounted.some((u) => u.id === 'POST /api/dingen'), JSON.stringify(r.unaccounted));
    });

    test('een declaratie in accessRegistry verantwoordt de route', () => {
        const met = { triagedPrefixes: [], untriaged: [], routes: { 'GET /api/dingen': { enforcement: 'scoped' } } };
        const r = veeg(met);
        assert.ok(!r.unaccounted.some((u) => u.id === 'GET /api/dingen'));
    });

    test('een vrijstelling verantwoordt de route; een dode vrijstelling wordt gemeld', () => {
        const r = veeg(leegRegistry, new Map([
            ['GET /api/dingen', 'synthetisch: bewust open in deze fixture'],
            ['GET /api/bestaat-niet', 'synthetisch: dode sleutel'],
        ]));
        assert.deepEqual(r.unaccounted, []);
        assert.deepEqual(r.staleExempt, ['GET /api/bestaat-niet']);
    });

    test('een dichtgezet gepind gat wordt als overbodig gemeld', () => {
        const files = {
            ...FIXTURE,
            'routes/dingen.js': `
                const { requireAuth } = require('../auth/permissions');
                const router = require('express').Router();
                router.use(requireAuth);
                router.get('/', async (req, res) => { res.json(await alles()); });
                module.exports = router;
            `,
        };
        const r = sweepSurface(parseSurface((p) => files[p] ?? null, 'index.js'), leegRegistry,
            new Map([['GET /api/dingen', 'gepind gat — inmiddels gedicht']]));
        assert.deepEqual(r.redundantExempt, ['GET /api/dingen']);
    });

    test('een bestand zonder statisch leesbare routes vraagt een vrijstelling', () => {
        const zonder = veeg(leegRegistry);
        assert.deepEqual(zonder.unaccountedOpaque.map((o) => o.prefix), ['/api/leeg']);
        const met = veeg(leegRegistry, new Map([['mount:/api/leeg', 'synthetisch: middleware-mount zonder routes']]));
        assert.deepEqual(met.unaccountedOpaque, []);
    });

    // ── The router split over a folder ───────────────────────────────────────
    // A router split into a folder does not mount its groups with
    // router.use(...) but lets each group register itself. When
    // routes/{webpages,datatables,playbooks}.js were split like this, 91 routes
    // silently vanished from this surface while 'every route is
    // accounted for' stayed happily green: a gate that failed OPEN. These
    // fixtures pin the shape down, including the one thing that can really
    // break: the ORDER.
    const GESPLITST = {
        'index.js': `
            const express = require('express');
            const app = express();
            app.use('/api/gesplitst', require('./routes/gesplitst'));
        `,
        'routes/gesplitst/index.js': `
            const express = require('express');
            const { requireAuth } = require('../../auth/permissions');
            const laat = require('./laat');
            const router = express.Router();
            require('./vroeg').register(router, {});
            router.use(requireAuth);
            laat.register(router, {});
            module.exports = router;
        `,
        'routes/gesplitst/vroeg.js': `
            function register(router) { router.get('/vroeg', (req, res) => res.json({})); }
            module.exports = { register };
        `,
        'routes/gesplitst/laat.js': `
            function register(router) { router.get('/laat', (req, res) => res.json({})); }
            module.exports = { register };
        `,
    };
    const veegGesplitst = () => {
        const opp = parseSurface((p) => GESPLITST[p] ?? null, 'index.js');
        return { opp, res: sweepSurface(opp, leegRegistry, new Map()) };
    };

    test('een over een map gesplitste router levert zijn routes alsnog aan', () => {
        const { opp } = veegGesplitst();
        assert.deepEqual(opp.routes.map((r) => `${r.method} ${r.path}`).sort(),
            ['GET /api/gesplitst/laat', 'GET /api/gesplitst/vroeg'],
            'require(\'./x\').register(router) is een submount op \'/\' — zonder dat zijn de routes van elke groepsmodule onzichtbaar');
        assert.deepEqual(opp.opaque, [], 'een gesplitste router is geen onleesbare mount meer');
    });

    test('elke route van een gesplitste router wijst zijn eigen bestand aan', () => {
        const { opp } = veegGesplitst();
        const perRoute = Object.fromEntries(opp.routes.map((r) => [`${r.method} ${r.path}`, r.file]));
        assert.deepEqual(perRoute, {
            'GET /api/gesplitst/vroeg': 'routes/gesplitst/vroeg.js',
            'GET /api/gesplitst/laat': 'routes/gesplitst/laat.js',
        }, 'attributie per bestand is het hele punt: een file:-vrijstelling of een bevinding moet het JUISTE bestand noemen');
    });

    test('de gate-volgorde overleeft de splitsing — vóór de gate blijft vóór de gate', () => {
        const { res } = veegGesplitst();
        const ids = res.unaccounted.map((u) => u.id);
        assert.ok(!ids.includes('GET /api/gesplitst/laat'),
            'een groep die NA router.use(requireAuth) registreert, erft die gate — net als bij runtime');
        assert.ok(ids.includes('GET /api/gesplitst/vroeg'),
            'een groep die VÓÓR de gate registreert erft hem NIET; anders zou de splitsing routes gratis gate-bewijs geven');
    });

    test('de lokale-binding-vorm telt ook (het routes/support.js-idioom)', () => {
        const { opp } = veegGesplitst();
        assert.ok(opp.routes.some((r) => r.file === 'routes/gesplitst/laat.js'),
            '`laat.register(router)` via een const-binding hoort net zo goed gelezen te worden als de inline require');
    });

    test('een helper die GEEN router meekrijgt is geen submount', () => {
        const files = {
            ...GESPLITST,
            'routes/gesplitst/index.js': `
                const express = require('express');
                const router = express.Router();
                const opties = require('./opties').bouw({ a: 1 });
                require('./vroeg').register(router, opties);
                module.exports = router;
            `,
            'routes/gesplitst/opties.js': `
                function bouw(o) { return o; }
                module.exports = { bouw };
            `,
        };
        const opp = parseSurface((p) => files[p] ?? null, 'index.js');
        assert.deepEqual(opp.files.includes('routes/gesplitst/opties.js'), false,
            'alleen een aanroep met een router-variabele als eerste argument is een registratie — anders slokt de parser elke functieaanroep op');
        assert.deepEqual(opp.routes.map((r) => r.path), ['/api/gesplitst/vroeg']);
    });

    test('triagedPrefixes cedeert aan de drifttest — de sweep dubbelt daar niet', () => {
        const r = sweepSurface(
            parseSurface(leesFixture, 'index.js', { skipPrefix: (p) => p.startsWith('/api/dingen') }),
            leegRegistry, new Map());
        assert.deepEqual(r.unaccounted, []);
    });
});
