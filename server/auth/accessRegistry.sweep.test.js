'use strict';

/**
 * Elke route is verantwoord — afgedwongen, app-breed. (U4)
 *
 * De opvolger van de /auth-drifttest voor de rest van het oppervlak. De twee
 * tests verdelen het werk:
 *
 *   accessRegistry.drift.test.js  laadt de ECHTE app in een wegwerp-kindproces
 *       (routeWalk.cli.js) en verifieert de triagedPrefixes diepgaand —
 *       machinale gate-tags, chain-equivalentie, probe⟷declaratie.
 *   deze test  leest index.js en elk bereikbaar routebestand als TEKST
 *       (auth/routeSurfaceSweep.js — nooit een require van de app: dat start
 *       schedulers) en eist app-breed VERANTWOORDING: elke route heeft een
 *       gate op mount, router of route, een gate-vormige check in de handler,
 *       een declaratie in accessRegistry, of een expliciete vrijstelling
 *       hieronder met een controleerbare reden. Routes onder triagedPrefixes
 *       slaat de sweep over — die dekt de drifttest al, en dieper.
 *
 * Een nieuwe route die nergens in past is een RODE TEST met een aanwijzing,
 * geen stil open endpoint. Dat dit mechanisme echt bijt bewijzen de
 * synthetische fixtures onderaan: een fixture-app met een ongegate,
 * niet-geregistreerde route levert aantoonbaar rood op — zonder
 * canary-bestanden in de echte boom.
 *
 * WAT DIT BEWIJST: verantwoording, geen toereikendheid. "requireAuth in de
 * keten" zegt niet dat de JUISTE caller binnenkomt — dat blijft het werk van
 * de per-route authz-tests en van de drifttest naarmate triagedPrefixes
 * groeit. En net als migrateDb.registration.test.js is dit bewust statisch:
 * verantwoording is een tekstueel feit.
 *
 * Run: cd server && node --test --test-force-exit auth/accessRegistry.sweep.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('./accessRegistry');
const { parseSurface, sweepSurface } = require('./routeSurfaceSweep');

const SERVER = path.resolve(__dirname, '..');

/**
 * Bewust zonder keten-gate bereikbaar — elk met de reden. Een entry is een
 * claim die een reviewer kan controleren, geen ontsnappingsluik zonder
 * verhaal; een entry met `bewijs` wordt hieronder ook machinaal gecontroleerd
 * (bestand bestaat én bevat de marker nog — het ABSORBED-patroon uit
 * boot/bootMigrations.test.js).
 *
 * Sleutels: 'METHOD /pad' (één route, zelfde vorm als accessRegistry),
 * 'file:<pad>' (heel bestand), 'mount:/prefix' (hele mount, ook dynamische).
 */
const BEWUST_OPEN = new Map([
    // ── Health & API-naamkaartje ─────────────────────────────────────────
    ['GET /api/health', 'gezondheidsprobe — bewust anoniem, alleen status/buildstempel (index.js)'],
    ['GET /api', 'API-naamkaartje ({ name, status }) — geen data, geen sessie nodig'],
    ['GET /api/guard/health', 'statusprobe van de PII-guard-service, zelfde klasse als /api/health — meldt configured/available, geen gebruikersdata'],
    ['GET /api/health/schema', 'schema-gezondheidsprobe, per header "Ongeauthenticeerd, net als /api/health" (routes/healthSchema.js)'],
    ['file:routes/wellKnown.js', '/.well-known discovery-documenten (Azure publisher-domain, security.txt) — per definitie publiek'],

    // ── Anonieme telemetrie ──────────────────────────────────────────────
    ['POST /api/client-errors', 'anonieme client-fouttelemetrie mét rate limiter in de router — fouten vuren ook vóór/zonder sessie'],
    ['POST /api/web-vitals', {
        reden: 'Core Web Vitals-beacons; header zegt het zelf: TTFB/FCP vuren vóór de sessie bestaat. Sinds 2026-09-05 met dezelfde per-IP rate limiter als client-errors (60/min: één page load = tot vijf metric-beacons).',
        bewijs: { file: 'routes/webVitals.js', marker: 'beaconLimiter' },
    }],
    ['POST /api/csp-report', 'CSP-violation-reports van de browser — de browser stuurt ze zonder credentials; 32kb-limiet in de router'],

    // ── Marketing- en publiekssite ───────────────────────────────────────
    ['GET /api/public/github-stats', 'anoniem marketing-endpoint (github-stats-blok op de publieke site), zegt het al in zijn mountnaam'],
    ['GET /api/cms/site', 'gepubliceerde CMS-site-payload voor de marketingpagina — de rest van /api/cms zit achter router.use(\'/admin\'|\'/sites\', requireAdmin)'],
    ['GET /api/cms/<dynamisch>', 'de asset-regexroute (cms.js: router.get(/^\\/asset\\/(.+)$/)) — assets van gepubliceerde marketingpagina\'s'],
    ['file:routes/publicRender.js', 'server-rendered marketingpaginas, robots.txt, sitemap.xml, llms.txt — het bestaansrecht van dit bestand is anonieme crawlers (zie index.js, mount zonder pad)'],
    ['GET /api/billing/public-plans', 'publieke prijstabel voor de marketing-/signup-flow; de rest van /api/billing is requireAuth per route'],
    ['GET /api/release-notes/public', 'serveert alleen PUBLISHED entries; machinaal geschreven copy passeert eerst een mens via /admin/:id/publish (index.js-commentaar)'],
    ['GET /api/branding/public', 'publieke branding (naam/logo/kleuren) voor login- en marketingpagina — nodig vóór er een sessie is'],
    ['GET /api/branding/wallpaper/:filename', 'wallpaper-asset behorend bij de publieke branding hierboven'],
    ['GET /api/languages/public/locales', 'i18n: beschikbare talen voor login-/marketingpagina — vóór er een sessie is'],
    ['GET /api/languages/public/strings/:locale', 'i18n: vertaalstrings voor dezelfde pre-sessie-schermen'],
    ['GET /ai/model-costs', 'modelkostentabel; de header van routes/ai/config/modelCosts.js noemt hem expliciet "public read" — config/updates ernaast zijn requireAuth/admin'],

    // ── Webhooks & machine-authenticatie (credential zit in het verzoek) ─
    ['POST /api/stripe/webhook', {
        reden: 'Stripe-webhook — authenticatie is de Stripe-handtekening over de raw body (mount vóór bodyParser, index.js), geen sessie.',
        bewijs: { file: 'routes/stripe/webhook.js', marker: 'constructWebhookEvent' },
    }],
    ['mount:/api/mod', {
        reden: 'dynamische dispatcher voor remote modules — routers ontstaan bij module-activatie en zijn statisch onzichtbaar; het pakketkanaal is getekend/geverifieerd en dispatchRouter 404-verbergt inactieve modules.',
        bewijs: { file: 'modules/packageLoader.js', marker: 'dispatchRouter' },
    }],
    ['file:auth/connectorJwt.js', 'geen router maar app-brede middleware (pathless app.use in index.js) die connector-JWT\'s naar een sessie vertaalt — registreert zelf geen routes'],
    ['POST /api/automation/events/msgraph', 'MS Graph change-notification-webhook: het verplichte validationToken-handshake is per contract anoniem, en elke notificatie wordt tegen de per-subscription clientState gevalideerd (mismatch → drop) — routes/automation/events.js'],
    ['POST /api/automation/events/gmail', {
        reden: 'Gmail Pub/Sub-push; het SECURITY-commentaar ter plekke documenteert de staat: nog niet cryptografisch geauthenticeerd (OIDC-verificatie moet nog landen) maar fail-closed — userId is altijd null en dispatchEvent weigert null-userId gmail-events, dus floodbaar (rate-limited) maar niet triggerbaar. Herbeoordeel deze entry zodra OIDC + emailAddress→userId landen.',
        bewijs: { file: 'routes/automation/events.js', marker: 'NOT cryptographically authenticated' },
    }],

    // ── OAuth-callbacks: de identity provider is de authenticator ────────
    ['GET /api/integrations/google/callback', 'OAuth-callback — redirect van de IdP, noodzakelijk bereikbaar vóór er een sessie is; state/code-validatie in de handler'],
    ['GET /api/integrations/microsoft/callback', 'OAuth-callback, als google/callback'],
    ['GET /api/integrations/linkedin/callback', 'OAuth-callback, als google/callback'],
    ['GET /api/integrations/withings/callback', 'OAuth-callback, als google/callback'],

    // ── Zelf-gescoped op sessie-inhoud (geen gate nodig om te weigeren) ──
    ['GET /api/integrations/gmail/messages', {
        reden: 'leest uitsluitend via de OAuth-tokens ín de sessie (createGoogleApiClient(req.session)) — zonder sessie is het antwoord 401 NOT_CONNECTED; er is niets om van een ander te lezen.',
        bewijs: { file: 'routes/integrations/gmail.js', marker: 'createGoogleApiClient' },
    }],
    ['GET /api/integrations/gmail/messages/:messageId', 'als GET /api/integrations/gmail/messages — sessie-token-gescoped'],
    ['GET /api/integrations/gdrive/files', 'als gmail/messages: Drive-client komt uit req.session-tokens, anoniem → 401 NOT_CONNECTED (routes/integrations/googleDrive.js)'],
    ['GET /api/integrations/gdrive/export/:fileId', 'als GET /api/integrations/gdrive/files — sessie-token-gescoped'],
    ['GET /api/support/threads/mine', {
        reden: 'de eigen supporttickets van de ingelogde gebruiker. Geen keten-gate omdat /api/support ook anonieme marketing-intake draagt, maar de handler weigert zelf: geen userId → 401, en de query is gescoped op requesterUserId — er is niets van een ander te lezen. De handler-probe ziet dit patroon niet omdat getUserId(req) buiten haar werkwoordenlijst valt en er geen req.session in de body staat; dat is een gat in de PROBE, niet in de route.',
        bewijs: { file: 'routes/support/threads.js', marker: 'requesterUserId: userId' },
    }],

    // ── Token-als-credential: publiek gedeelde inhoud ────────────────────
    ['GET /api/public-app/:token', 'publieke intake van een Studio-app: het URL-token is de credential en ontsluit alleen de whitelist van schermen in de app-definitie (appStudio/publicAccess.js); bezoekers zijn per ontwerp anonieme derden'],
    ['GET /verify/:token', 'certificaatverificatie voor LinkedIn-shares — token-gated (alleen bewust publiek gezette certs resolven), per-IP rate limited (routes/verifyCertificate.js)'],
    ['GET /verify/:token/image.png', 'og:image bij GET /verify/:token — zelfde token-credential'],
    ['GET /verify/:token/certificate.pdf', 'PDF-download bij GET /verify/:token — zelfde token-credential'],
    ['GET /share/_brand/icon.svg', 'statisch brand-icoon op de publieke share-pagina\'s — de inhoudsroutes van /share zijn share-token-gated in routes/publicViewer.js'],
    ['GET /w/_brand/icon.svg', 'zelfde statische brand-icoon, tweede mount: routes/publicViewer.js hangt sinds W3 stap 4 óók op /w/<slug> (het adres van de pagina in plaats van dat van de share) — één router, één poort, dus dezelfde reden'],

    // ── GDPR: inname moet bereikbaar zijn (Art. 12) ──────────────────────
    ['POST /api/dsr/requests', {
        reden: 'DSR-inname: een betrokkene zonder account moet een verzoek kunnen indienen (GDPR Art. 12); per-IP publicSubmitLimiter in de router, admin-kant zit achter requirePermission.',
        bewijs: { file: 'routes/dsr.js', marker: 'publicSubmitLimiter' },
    }],
    ['GET /api/dsr/requests/:id/public', 'status-URL uit de ontvangstbevestiging van POST /api/dsr/requests — het request-id is de (onraadbare) credential van de indiener'],
    // file:routes/support.js stond hier tot de parser de register-helper leerde
    // lezen. De reden van die blanket-entry was letterlijk "registreert zijn
    // routes via register*(router)-helpers in routes/support/* en is dus
    // statisch onzichtbaar" — precies de premisse die routeSurfaceSweep.js nu
    // weerlegt. De 42 routes achter /api/support worden sindsdien stuk voor
    // stuk gewogen: 41 dragen een gate-vormige check in hun handler
    // (admin_support-staf, eigenaarschap, of het anonieme toegangstoken van
    // POST /threads), en de ene die overbleef staat hieronder met naam en
    // toenaam. Eén blanket-vrijstelling minder, één precieze erbij.

    // ── Gast-chatoppervlak (bewust ontwerp: rijen gescoped op guest-id) ──
    ['GET /agents/:id/embed', 'publieke agent-embed met embedLimiter en 404-vervaging voor ongepubliceerde agents (routes/agents/chat.js:158)'],
    ['GET /agents/:id/history', 'gast-chat: history gescoped op getEffectiveUserId (guest-cookie-id voor anoniem) — je leest alleen je eigen gastgesprek'],
    ['DELETE /agents/:id/history', 'als GET /agents/:id/history — wist alleen het eigen (gast)gesprek'],
    ['file:routes/agents/conversations.js', {
        reden: 'gast-conversaties: elke store-call is gescoped op getEffectiveUserId; agent-leesbaarheid loopt waar relevant via canReadAgent (routes/agents/crud.js:158).',
        bewijs: { file: 'routes/agents/conversations.js', marker: 'getEffectiveUserId' },
    }],
    ['GET /agents/conversations/all', 'gast-conversatieoverzicht — zelfde getEffectiveUserId-scoping als routes/agents/conversations.js'],
    ['GET /agents', 'agentlijst gescoped op de effectieve gebruiker: gepubliceerde + eigen agents (routes/agents/crud.js:28); mutaties ernaast dragen requirePermission'],
    ['file:routes/agents/meta.js', 'component- en modelcatalogus voor de (gast)chat-UI — metadata, geen gebruikersdata'],
    // file:routes/memory.js stond hier van 2026-09-05 (dossier 4a) tot de
    // memory-overhaul: bewust gastpad, omdat de gastchat-runtime memories
    // onder het gast-cookie-id schreef. Die premisse is weg — de extractor
    // schrijft niets meer voor een guest_*-id (agents/memory/extractor.guest.test.js)
    // en de eerder geschreven rijen zijn gewist (migrations/memory-guest-purge-2026-08.js).
    // De router draagt nu router.use(requireAuth); de sweep ziet die gate
    // zelf. Bewezen door routes/memory.guards.test.js + routes/memory.authz.test.js.
]);

/**
 * Gaten die vandaag bestaan en hier expliciet GEPIND staan in plaats van stil
 * te blijven. Deze test wijzigt bewust géén gedrag: een route die gegate zou
 * moeten zijn maar het niet is, blijft zoals hij is en staat hier — zichtbaar,
 * met ernst. De weg eruit: gate toevoegen (aparte, bewuste wijziging) en de
 * entry verwijderen; de redundantie-test hieronder dwingt dat verwijderen af
 * zodra de gate er echt is, zodat deze lijst alleen kan krimpen naar de
 * waarheid toe.
 */
const GEPIND_ONGEGATE = new Map([
    // /versions/* (4 routes) gedicht 2026-09-05: router.use(requireAuth) +
    // canModifyAgent per route (het routes/agents/publishVersion.js-idioom);
    // bewezen door routes/versions.authz.test.js, gedeclareerd in accessRegistry.js.
    // /api/documents/* (3 routes) gedicht 2026-09-05: router.use(requireAuth)
    // (zelfde idioom; classificatie: vergeten gate, geen gastpad — geen enkele
    // anonieme caller bestaat, de mobiele "Generated"-tab stuurt de sessiecookie).
    // Bewezen door routes/documents.authz.test.js, gedeclareerd in accessRegistry.js.
    // RESTPUNT (bewust, gedocumenteerd in de header van routes/documents.js):
    // /list blijft gedeeld tussen ingelogde gebruikers — de tmp-map draagt geen
    // eigenaarschap, dus per-user scopen kan niet zonder een verzonnen ledger.
    // file:routes/memory.js geclassificeerd 2026-09-05 (dossier 4a) als bewust
    // gastpad; sinds de memory-overhaul gedicht met router.use(requireAuth)
    // (zie de toelichting bij BEWUST_OPEN hierboven).
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
    // Het anti-verrottingsmechanisme voor de lijsten zelf (migrateDb-patroon):
    // een sleutel die geen enkele route of mount meer raakt, is een dode claim.
    assert.deepStrictEqual(result.staleExempt, [],
        'deze vrijstellingen raken geen enkele bestaande route of mount meer — de route is\n' +
        'verdwenen of hernoemd. Verwijder de entry, of corrigeer de sleutel.');
});

test('een gepind gat dat gedicht is, verlaat de lijst', () => {
    // Zodra een route uit GEPIND_ONGEGATE structureel gegate raakt, is de entry
    // overbodig en MOET hij weg — zo krimpt de schuld-lijst naar de waarheid toe
    // en blijft "wat staat hier nog open" een eerlijk antwoord.
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

// ═══ Synthetische fixtures: bewijs dat deze test bijt ═══════════════════════
// Dezelfde parser en dezelfde pure sweep, gevoed met een in-memory mini-app.
// Als de rood-case hier ooit groen wordt, is de sweep zijn tanden kwijt.
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

    // ── De over een map gesplitste router ────────────────────────────────────
    // Een router die in een map is gesplitst, mount zijn groepen niet met
    // router.use(...) maar laat elke groep zichzelf registreren. Toen
    // routes/{webpages,datatables,playbooks}.js zo werden gesplitst, verdwenen
    // er 91 routes geruisloos uit dit oppervlak terwijl 'elke route is
    // verantwoord' vrolijk groen bleef — een poort die OPEN faalde. Deze
    // fixtures pinnen de vorm vast, inclusief het enige wat er echt aan kan
    // breken: de VOLGORDE.
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
