// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { READ } from './canUseFacts';
import { applyAppSelection, automationRows, initialSelection, keepRequiresGrantApps, paramPillsOf, setAppActAs, setAppActions, setAppConfirm, toolRows } from './toolGrants';
import { ACT_AS, ACT_AS_KIND, CONFIRM, claimantsOf, effectiveActionsOf, grantedActionsOf, sendsFor } from './toolGrants.helpers';

/**
 * The GRANTS CONTRACT, on the writing side.
 *
 * `server/core/agentRuntime/toolPolicy.test.js` already pins the READING side: a missing entry gives the whole
 * app, `{actions: []}` gives nothing. What until now stood nowhere is the side that this stage builds: the PICKER
 * must write an unticked app as `{actions: []}` and must never omit the key. Those two halves belong together.
 * On their own, one is a rule that nobody applies and the other a habit that nobody enforces.
 */

const APPS = [
    {
        id: 'gmail',
        label: 'Gmail',
        available: true,
        actionsKnown: true,
        provider: 'google',
        actions: [
            { name: 'gmail_search', label: 'gmail search', effect: 'reads' },
            { name: 'gmail_compose', label: 'gmail compose', effect: 'sends' },
            { name: 'gmail_create_draft', label: 'gmail create draft', effect: 'writes' },
        ],
    },
    {
        id: 'google-drive',
        label: 'Google Drive',
        available: true,
        actionsKnown: true,
        provider: 'google',
        actions: [
            { name: 'drive_search', label: 'drive search', effect: 'reads' },
            { name: 'drive_upload_file', label: 'drive upload file', effect: 'writes' },
        ],
    },
    {
        id: 'agent-search',
        label: 'Web search',
        available: true,
        actionsKnown: true,
        provider: null,
        actions: [{ name: 'web_search', label: 'web search', effect: 'reads' }],
    },
];

describe('het grants-contract: uitvinken schrijft, weglaten geeft terug', () => {
    it('schrijft een uitgevinkte app als {actions: []} en laat de sleutel NOOIT weg', () => {
        // De eigenaar opent de kiezer op een agent die alles van Gmail mag, en
        // vinkt alles uit.
        const before = null;
        const selection = new Map([['gmail', new Set()]]);
        const after = applyAppSelection(before, { shownApps: [APPS[0]], selection });

        expect(Object.prototype.hasOwnProperty.call(after, 'gmail')).toBe(true);
        expect(after.gmail.actions).toEqual([]);
        // The rule in the form in which it goes wrong: this is NOT the same as an empty map. An empty map means
        // "nobody said anything", and toolPolicy.js reads that as the whole app.
        expect(after).not.toEqual({});
        expect(grantedActionsOf(after, 'gmail')).toEqual([]);
    });

    it('geeft de hele app terug zodra de sleutel ontbreekt — de val die dit contract afdekt', () => {
        // Exactly what a naive picker writes: only the ticked apps.
        const naive = {};
        expect(grantedActionsOf(naive, 'gmail')).toBe('*');
        // ...tegenover wat hij moet schrijven.
        const correct = applyAppSelection(null, { shownApps: [APPS[0]], selection: new Map([['gmail', new Set()]]) });
        expect(grantedActionsOf(correct, 'gmail')).toEqual([]);
    });

    it('schrijft ELKE getoonde app weg, ook de app waar niets van aanstaat', () => {
        const selection = new Map([
            ['gmail', new Set(['gmail_search'])],
            ['google-drive', new Set()],          // uitgevinkt
            ['agent-search', new Set(['web_search'])],
        ]);
        const out = applyAppSelection(null, { shownApps: APPS, selection });

        expect(out.gmail.actions).toEqual(['gmail_search']);
        expect(out['google-drive'].actions).toEqual([]);
        // Everything on becomes `'*'`, not the written-out list. Then the app inherits an action that comes in with
        // the next release.
        expect(out['agent-search'].actions).toBe('*');
    });

    it('laat een app die de kiezer NIET toonde met rust — over die app zei niemand iets', () => {
        const before = { youtrack: { actions: ['youtrack_create_issue'] }, datatables: { t1: { scope: 'own' } } };
        const out = applyAppSelection(before, { shownApps: [APPS[0]], selection: new Map([['gmail', new Set()]]) });

        expect(out.youtrack).toEqual({ actions: ['youtrack_create_issue'] });
        expect(out.datatables).toEqual({ t1: { scope: 'own' } });
        expect(out.gmail.actions).toEqual([]);
    });

    it('laat een app waarvan de acties onbekend zijn met rust — je kunt niet wegschrijven wat je niet kent', () => {
        const broken = { id: 'broken-app', label: 'Broken', actionsKnown: false, actions: [] };
        const before = { 'broken-app': { actions: ['broken_do'] } };
        const out = applyAppSelection(before, { shownApps: [broken], selection: new Map([['broken-app', new Set()]]) });

        expect(out['broken-app']).toEqual({ actions: ['broken_do'] });
    });

    it('klapt een ONTBREKENDE entry uit naar alle acties — anders neemt de eerste opslag alles af', () => {
        // An agent from before the picker: no `tools` map, so everything may.
        const sel = initialSelection(null, APPS);
        expect([...sel.get('gmail')]).toEqual(['gmail_search', 'gmail_compose', 'gmail_create_draft']);

        // En het bewijs dat de twee helften op elkaar passen: openen en meteen
        // opslaan zonder iets aan te raken mag NIETS afnemen.
        const out = applyAppSelection(null, { shownApps: APPS, selection: sel });
        for (const app of APPS) expect(grantedActionsOf(out, app.id)).toBe('*');
    });

    it('een lege selectie op een agent die al iets gekozen had blijft leeg', () => {
        const before = { gmail: { actions: ['gmail_search'] } };
        const sel = initialSelection(before, APPS);
        expect([...sel.get('gmail')]).toEqual(['gmail_search']);
        expect([...sel.get('google-drive')]).toEqual(['drive_search', 'drive_upload_file']);

        const out = applyAppSelection(before, { shownApps: APPS, selection: sel });
        expect(out.gmail.actions).toEqual(['gmail_search']);
        expect(out['google-drive'].actions).toBe('*');
    });

    it('een app waarvan de acties onbekend zijn levert `null`, niet een lege selectie', () => {
        const broken = { id: 'broken-app', actionsKnown: false, actions: [] };
        const sel = initialSelection(null, [broken]);
        expect(sel.get('broken-app')).toBe(null);
    });
});

describe('losse schrijvers', () => {
    it('setAppActions bewaart een lege lijst en verwijdert de sleutel niet', () => {
        const out = setAppActions({ gmail: { actions: '*', confirm: 'ask' } }, 'gmail', []);
        expect(out.gmail).toEqual({ actions: [], confirm: 'ask' });
    });

    it('setAppActions raakt de gereserveerde secties niet aan', () => {
        const before = { automations: { a1: {} }, datatables: { t1: { scope: 'all', columns: '*' } } };
        const out = setAppActions(before, 'gmail', ['gmail_search']);
        expect(out.automations).toEqual({ a1: {} });
        expect(out.datatables).toEqual({ t1: { scope: 'all', columns: '*' } });
    });

    it('setAppActions weigert een gereserveerde sleutel als app-id', () => {
        const before = { automations: { a1: {} } };
        expect(setAppActions(before, 'automations', [])).toEqual(before);
        expect(setAppActions(before, '__proto__', [])).toEqual(before);
    });

    it('setAppConfirm neemt geen acties af — een app zonder entry houdt zijn hele toolbelt', () => {
        const out = setAppConfirm(null, 'gmail', CONFIRM.ASK);
        // The actions go along EXPLICITLY. Without that, `{confirm}` would be an entry without an action list, and for
        // an app that the picker could never show that is the difference between nothing and everything. See the test below.
        expect(out.gmail).toEqual({ actions: '*', confirm: 'ask' });
        expect(grantedActionsOf(out, 'gmail')).toBe('*');
    });

    it('setAppConfirm/setAppActAs verbreden een `requiresGrant`-app niet van NIETS naar ALLES', () => {
        // The finding: two NARROWING gestures on the card ("Confirm first", "As: the person asking") laid down an entry
        // without an action list, and the runtime read that as "the owner named this app". That gave a full headless
        // browser on an agent that had been curated to gmail_search only.
        const curated = { gmail: { actions: ['gmail_search'] } };
        const opts = { requiresGrant: true };

        const na = setAppConfirm(curated, 'browser-fetch', CONFIRM.ASK, opts);
        expect(na['browser-fetch']).toEqual({ actions: [], confirm: 'ask' });
        expect(grantedActionsOf(na, 'browser-fetch', opts)).toEqual([]);

        const alsAls = setAppActAs(curated, 'browser-fetch', ACT_AS.VIEWER, opts);
        expect(alsAls['browser-fetch']).toEqual({ actions: [], actAs: 'viewer' });

        // And on an agent that NOBODY curated, "everything" stays really everything: the entry records what the row showed
        // at that moment.
        const vers = setAppConfirm(null, 'browser-fetch', CONFIRM.ASK, opts);
        expect(vers['browser-fetch']).toEqual({ actions: '*', confirm: 'ask' });
    });

    it('setAppActAs met null HAALT de keuze weg in plaats van "viewer" op te slaan', () => {
        const before = { gmail: { actions: '*', actAs: 'owner' } };
        expect(setAppActAs(before, 'gmail', null).gmail).toEqual({ actions: '*' });
        expect(setAppActAs(before, 'gmail', ACT_AS.VIEWER).gmail).toEqual({ actions: '*', actAs: 'viewer' });
    });
});

describe('grantedActionsOf spiegelt de lezer op de server', () => {
    it('ontbrekend en "*" zijn allebei de hele app', () => {
        expect(grantedActionsOf(null, 'gmail')).toBe('*');
        expect(grantedActionsOf({}, 'gmail')).toBe('*');
        expect(grantedActionsOf({ gmail: {} }, 'gmail')).toBe('*');
        expect(grantedActionsOf({ gmail: { actions: '*' } }, 'gmail')).toBe('*');
    });

    // ── Apps that the picker could never show (A2-1) ────────────────
    // `browse_web` and the other INLINE registered tools were in no list that the picker reads. For such apps,
    // silence is not a choice: nobody ever got to see them, so "the owner left it alone" cannot be true. The server
    // reads it that way (toolPolicy.isToolAllowed), and this side must mirror that. Otherwise the picker opens with
    // ticks on that the runtime refuses.
    it('een app die expliciet gegund moet worden is bij zwijgen NIETS, niet alles', () => {
        const curated = { gmail: { actions: ['gmail_search'] } };
        expect(grantedActionsOf(curated, 'browser-fetch', { requiresGrant: true })).toEqual([]);
        // Zonder die vlag blijft de geen-migratie-regel staan.
        expect(grantedActionsOf(curated, 'browser-fetch')).toBe('*');
    });

    it('...maar alleen bij een agent die IEMAND cureerde — anders kijkt de runtime niet eens mee', () => {
        for (const cfg of [null, {}, { gmail: 'nope' }, { automations: {} }]) {
            expect(grantedActionsOf(cfg, 'browser-fetch', { requiresGrant: true })).toBe('*');
        }
        expect(grantedActionsOf({ automations: { a1: {} } }, 'browser-fetch', { requiresGrant: true })).toEqual([]);
    });

    it('een genoemde entry beslist gewoon, ook voor zo een app', () => {
        const opts = { requiresGrant: true };
        expect(grantedActionsOf({ 'browser-fetch': { actions: '*' } }, 'browser-fetch', opts)).toBe('*');
        // An entry WITHOUT an action list is not a written-out choice. This used to be here as `'*'`, and that was the
        // mirror of precisely the fail-open that the card itself produced (`setAppConfirm` wrote such an entry).
        expect(grantedActionsOf({ 'browser-fetch': {} }, 'browser-fetch', opts)).toEqual([]);
        expect(grantedActionsOf({ 'browser-fetch': { confirm: 'ask' } }, 'browser-fetch', opts)).toEqual([]);
        // ...en bij een gewone app verandert er niets.
        expect(grantedActionsOf({ gmail: { confirm: 'ask' } }, 'gmail')).toBe('*');
        expect(grantedActionsOf({ 'browser-fetch': { actions: [] } }, 'browser-fetch', opts)).toEqual([]);
        expect(grantedActionsOf({ 'browser-fetch': { actions: ['browse_web'] } }, 'browser-fetch', opts))
            .toEqual(['browse_web']);
    });

    it('initialSelection opent zo een app met NUL vinkjes op een gecureerde agent', () => {
        const apps = [
            { id: 'gmail', actionsKnown: true, actions: [{ name: 'gmail_search' }] },
            { id: 'browser-fetch', actionsKnown: true, requiresGrant: true, actions: [{ name: 'browse_web' }] },
        ];
        const curated = initialSelection({ gmail: { actions: ['gmail_search'] } }, apps);
        expect([...curated.get('gmail')]).toEqual(['gmail_search']);
        expect([...curated.get('browser-fetch')]).toEqual([]);

        // And on an agent without curation it simply stays on. It may really do that today too.
        const legacy = initialSelection(null, apps);
        expect([...legacy.get('browser-fetch')]).toEqual(['browse_web']);
    });

    it('onleesbaar is GEEN verzoek om alles', () => {
        expect(grantedActionsOf({ gmail: { actions: 'gmail_search' } }, 'gmail')).toEqual([]);
        expect(grantedActionsOf({ gmail: { actions: 42 } }, 'gmail')).toEqual([]);
        // And an entry that is not an object itself: since this stage the server makes `{actions: []}` of that, so the
        // card may not make "everything" of it.
        expect(grantedActionsOf({ gmail: 'nope' }, 'gmail')).toEqual([]);
    });
});

describe('sendsFor: onbekend telt als versturen', () => {
    it('kent het antwoord wanneer de catalogus het geeft', () => {
        expect(sendsFor(['gmail_search'], APPS[0])).toBe(false);
        expect(sendsFor(['gmail_compose'], APPS[0])).toBe(true);
        expect(sendsFor('*', APPS[0])).toBe(true);
        expect(sendsFor('*', APPS[1])).toBe(false);
    });

    it('is `null` — niet `false` — zodra de catalogus ontbreekt of een effect mist', () => {
        expect(sendsFor('*', null)).toBe(null);
        expect(sendsFor('*', { actionsKnown: false, actions: [] })).toBe(null);
        expect(sendsFor('*', { actionsKnown: true, actions: [{ name: 'x' }] })).toBe(null);
    });
});

describe('toolRows', () => {
    const base = {
        toolsConfig: null,
        enabledIntegrations: ['gmail', 'google-drive', 'agent-search'],
        apps: APPS,
        catalogState: READ.OK,
        providersKnown: true,
        lentApps: new Set(),
        lendingEnabled: false,
    };

    it('telt "n van m acties" uit de config en de catalogus', () => {
        const rows = toolRows({ ...base, toolsConfig: { gmail: { actions: ['gmail_search'] } } });
        const gmail = rows.find(r => r.appId === 'gmail');
        expect(gmail.grantedCount).toBe(1);
        expect(gmail.totalActions).toBe(3);

        const drive = rows.find(r => r.appId === 'google-drive');
        expect(drive.granted).toBe('*');
        expect(drive.grantedCount).toBe(2);
    });

    it('vergrendelt op bevestigen zodra de app kan versturen — ook bij "*"', () => {
        const rows = toolRows({ ...base, toolsConfig: { gmail: { actions: '*', confirm: 'direct' } } });
        const gmail = rows.find(r => r.appId === 'gmail');
        expect(gmail.sends).toBe(true);
        expect(gmail.confirmLocked).toBe(true);
        expect(gmail.confirm).toBe(CONFIRM.ASK);
    });

    it('vergrendelt óók wanneer de catalogus ONBEKEND is — de smalle lezing', () => {
        const rows = toolRows({ ...base, apps: null, catalogState: READ.ERROR, providersKnown: false });
        for (const row of rows) {
            expect(row.sends).toBe(null);
            expect(row.confirmLocked).toBe(true);
            expect(row.confirm).toBe(CONFIRM.ASK);
            expect(row.totalActions).toBe(null);
        }
    });

    it('laat een leesbaar "direct" staan voor een app die niets verstuurt', () => {
        const rows = toolRows({ ...base, toolsConfig: { 'google-drive': { actions: '*', confirm: 'direct' } } });
        const drive = rows.find(r => r.appId === 'google-drive');
        expect(drive.confirmLocked).toBe(false);
        expect(drive.confirm).toBe(CONFIRM.DIRECT);
    });

    it('een app zonder gebruikersverbinding is PLATFORM en krijgt geen actAs', () => {
        const rows = toolRows(base);
        const web = rows.find(r => r.appId === 'agent-search');
        expect(web.actAsKind).toBe(ACT_AS_KIND.PLATFORM);
        expect(web.canActAsOwner).toBe(false);
    });

    it('een onbekende catalogus is niet PLATFORM — dat zou een lenende app als Bee Flow tekenen', () => {
        const rows = toolRows({ ...base, apps: null, catalogState: READ.ERROR, providersKnown: false });
        for (const row of rows) expect(row.actAsKind).toBe(ACT_AS_KIND.UNKNOWN);
    });

    it('biedt de eigenaar-optie alleen waar er echt geleend is, en nooit bij versturen', () => {
        const lent = new Set(['gmail', 'google-drive']);
        const rows = toolRows({ ...base, lentApps: lent, lendingEnabled: true });
        expect(rows.find(r => r.appId === 'gmail').canActAsOwner).toBe(false);   // verstuurt
        expect(rows.find(r => r.appId === 'google-drive').canActAsOwner).toBe(true);

        // Lend grants unreadable ⇒ no option. "I could not check" is not a yes.
        const blind = toolRows({ ...base, lentApps: null, lendingEnabled: true });
        expect(blind.find(r => r.appId === 'google-drive').canActAsOwner).toBe(false);

        // Lending off ⇒ no option, even with a grant in hand.
        const off = toolRows({ ...base, lentApps: lent, lendingEnabled: false });
        expect(off.find(r => r.appId === 'google-drive').canActAsOwner).toBe(false);
    });

    it('leest de leenlijst PER APP, niet per provider', () => {
        // Gmail and Drive share the same provider ('google'), and that is precisely why the row may not match on a
        // provider. The server answers yes/no per app (`GET /agents/:id/tool-lending`), so that the card makes no
        // translation of its own from providers to apps, which could deviate from the runtime's (toolPolicy.lentAppsFor).
        const rows = toolRows({ ...base, lentApps: new Set(['gmail']), lendingEnabled: true });
        expect(rows.find(r => r.appId === 'google-drive').canActAsOwner).toBe(false);
        expect(rows.find(r => r.appId === 'google-drive').ownerLendsUncurated).toBe(false);
    });

    it('zegt hardop dat een opgeslagen "owner" niet gehonoreerd wordt', () => {
        const rows = toolRows({
            ...base,
            toolsConfig: { 'google-drive': { actions: '*', actAs: 'owner' } },
            lentApps: new Set(), lendingEnabled: true,
        });
        const drive = rows.find(r => r.appId === 'google-drive');
        expect(drive.actAs).toBe(ACT_AS.VIEWER);
        expect(drive.ownerRefused).toBe(true);
    });

    // ── A2-2: the capsule and the runtime over the SAME state ───────
    // `A2_2_CURATED` appears literally in the same form in server/core/agentRuntime/toolPolicy.test.js. There it is
    // the input of `mayLendOwnerConnection`, and here it is the input of the row that the capsule draws. One state,
    // two sides, and they must say the same thing.
    const A2_2_CURATED = Object.freeze({
        // The owner has curated only Gmail. He never said anything about Drive, while his Google connection has in fact
        // been lent out.
        gmail: { actions: ['gmail_search'], actAs: 'viewer' },
    });

    it('meldt dat een app zonder opgeslagen keuze de geleende verbinding NIET meer gebruikt', () => {
        const rows = toolRows({
            ...base,
            toolsConfig: A2_2_CURATED,
            lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true,
        });
        const drive = rows.find(r => r.appId === 'google-drive');
        expect(drive.actAs).toBe(ACT_AS.VIEWER);
        expect(drive.ownerLendingUnset).toBe(true);
        expect(drive.ownerLendsUncurated).toBe(false);
        // And the notice belongs to "nothing stored", not to "cannot do it": Drive does not send anything, so the owner
        // can still choose it.
        expect(drive.canActAsOwner).toBe(true);

        // Gmail has a STORED choice. Nothing has changed there, so there is nothing to report.
        const gmail = rows.find(r => r.appId === 'gmail');
        expect(gmail.ownerLendingUnset).toBe(false);
        expect(gmail.ownerLendsUncurated).toBe(false);
    });

    it('meldt bij een agent die NIEMAND cureerde dat de verbinding wél geleend wordt', () => {
        // The opt-in boundary: as long as `hasCuratedGrants` is false, the runtime does not look at the map and lends as
        // it always did, also for an app that sends. The capsule says "as the person asking", so the row must make the
        // difference explicit instead of letting it stand.
        const rows = toolRows({
            ...base, toolsConfig: null,
            lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: true,
        });
        for (const id of ['gmail', 'google-drive']) {
            const row = rows.find(r => r.appId === id);
            expect(row.ownerLendsUncurated).toBe(true);
            expect(row.ownerLendingUnset).toBe(false);
        }
        // Een app zonder gebruikersverbinding leent niets en meldt niets.
        expect(rows.find(r => r.appId === 'agent-search').ownerLendsUncurated).toBe(false);
    });

    it('meldt niets waar er niets te lenen valt, en niets bij een onleesbare leenlijst', () => {
        const cases = [
            { lentApps: new Set(), lendingEnabled: true },      // geen grant
            { lentApps: new Set(['gmail', 'google-drive']), lendingEnabled: false }, // lenen uit
            { lentApps: null, lendingEnabled: true },           // niet na te gaan
        ];
        for (const extra of cases) {
            for (const toolsConfig of [null, A2_2_CURATED]) {
                const rows = toolRows({ ...base, toolsConfig, ...extra });
                const drive = rows.find(r => r.appId === 'google-drive');
                expect(drive.ownerLendsUncurated).toBe(false);
                expect(drive.ownerLendingUnset).toBe(false);
            }
        }
    });

    it('valt voor de NAAM terug op de statische lijst, niet op het kale id', () => {
        const rows = toolRows({
            ...base, apps: null, catalogState: READ.ERROR, providersKnown: false,
            labels: { gmail: 'Gmail', 'google-drive': 'Drive' },
        });
        expect(rows.map(r => r.label)).toEqual(['Gmail', 'Drive', 'agent-search']);
    });

    it('toont een grant op een uitgezette app — anders kun je hem niet weghalen', () => {
        const rows = toolRows({
            ...base,
            enabledIntegrations: ['gmail'],
            toolsConfig: { youtrack: { actions: [] } },
        });
        expect(rows.map(r => r.appId)).toEqual(['gmail', 'youtrack']);
    });

    it('rekent de gereserveerde secties niet als app', () => {
        const rows = toolRows({
            ...base,
            enabledIntegrations: [],
            toolsConfig: { automations: { a1: {} }, datatables: { t1: {} } },
        });
        expect(rows).toEqual([]);
    });
});

describe('automations als tool', () => {
    const AUTOS = [
        {
            id: 'a1',
            title: 'Send the invoice',
            definition: {
                trigger: {
                    kind: 'agent_call',
                    parametersSchema: {
                        type: 'object',
                        required: ['invoiceId'],
                        properties: { customer: { type: 'string' }, invoiceId: { type: 'string' } },
                    },
                },
            },
        },
        { id: 'a2', title: 'Nightly cleanup', definition: { trigger: { kind: 'schedule' } } },
    ];

    it('haalt de parampillen uit parametersSchema, vereiste velden eerst', () => {
        expect(paramPillsOf(AUTOS[0])).toEqual([
            { name: 'invoiceId', required: true },
            { name: 'customer', required: false },
        ]);
        expect(paramPillsOf(AUTOS[1])).toEqual([]);
    });

    it('een confirm die niemand kan lezen is "ask", niet "geen bevestiging"', () => {
        const rows = automationRows({
            toolsConfig: { automations: { a1: { confirm: 'Ask' }, a2: {} } },
            automations: AUTOS,
        });
        expect(rows.find(r => r.id === 'a1').confirm).toBe(CONFIRM.ASK);
        expect(rows.find(r => r.id === 'a2').confirm).toBe(CONFIRM.DIRECT);
    });

    it('houdt een grant zonder automatisering staan in plaats van hem te verzwijgen', () => {
        const rows = automationRows({
            toolsConfig: { automations: { a1: { confirm: 'ask' } } },
            automations: null,
            state: READ.ERROR,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].readable).toBe(false);
        expect(rows[0].name).toBe(null);
    });

    it('markeert een automatisering die de agent niet meer kan aanroepen', () => {
        const rows = automationRows({ toolsConfig: { automations: { a2: {} } }, automations: AUTOS });
        expect(rows[0].callable).toBe(false);
    });

    it('markeert een grant zonder koppeling aan deze agent, en zwijgt als de koppelingen onleesbaar zijn', () => {
        const toolsConfig = { automations: { a1: {}, a3: {} } };
        const rows = automationRows({ toolsConfig, automations: AUTOS, linkedIds: ['a1'] });
        expect(rows.find(r => r.id === 'a1').linked).toBe(true);
        expect(rows.find(r => r.id === 'a3').linked).toBe(false);
        expect(automationRows({ toolsConfig, automations: AUTOS, linkedIds: [] }).every(r => r.linked === false)).toBe(true);
        expect(automationRows({ toolsConfig, automations: AUTOS }).every(r => r.linked === null)).toBe(true);
        expect(automationRows({ toolsConfig, automations: null, state: READ.ERROR, linkedIds: ['a1'] })[1].linked).toBe(false);
    });
});


// ── Two rows about the same module ─────────────────────────────────
//
// `outlook` owns four names; `outlook-readonly` delivers three of them, on the same credentials. The runtime lets
// EVERY app that supplies a name take part in the decision (toolPolicy `_decidingApps`), so the strictest wins.
// The card counted per row only its own entry, and so reported MORE than actually runs.

const OUTLOOK_APPS = [
    {
        id: 'outlook', label: 'Outlook', available: true, actionsKnown: true, provider: 'microsoft',
        actions: [
            { name: 'outlook_search', effect: 'reads' },
            { name: 'outlook_read', effect: 'reads' },
            { name: 'outlook_list_recent', effect: 'reads' },
            { name: 'outlook_compose', effect: 'sends' },
        ],
    },
    {
        id: 'outlook-readonly', label: 'Outlook (read-only)', available: false, actionsKnown: true,
        provider: 'microsoft', grantsVia: 'outlook',
        actions: [
            { name: 'outlook_search', effect: 'reads' },
            { name: 'outlook_read', effect: 'reads' },
            { name: 'outlook_list_recent', effect: 'reads' },
        ],
    },
];

describe('gedeelde toolnamen: de kaart telt wat de RUNTIME serveert', () => {
    it('claimantsOf zegt wie welke naam levert', () => {
        const c = claimantsOf(OUTLOOK_APPS);
        expect(c.get('outlook_search')).toEqual(['outlook', 'outlook-readonly']);
        expect(c.get('outlook_compose')).toEqual(['outlook']);
    });

    it('de rij van de EIGENAAR wordt versmald door de entry op de andere rij', () => {
        // Measured behaviour of the server: with this map the runtime serves only `outlook_compose`. The card showed four
        // of them. That is over-reporting, and it is precisely the direction that this layer forbids.
        const cfg = { outlook: { actions: '*' }, 'outlook-readonly': { actions: [] } };
        const { names, narrowedBy } = effectiveActionsOf(cfg, OUTLOOK_APPS[0], { apps: OUTLOOK_APPS });
        expect(names).toEqual(['outlook_compose']);
        expect(narrowedBy).toEqual(['outlook-readonly']);

        const rows = toolRows({
            toolsConfig: cfg, enabledIntegrations: ['outlook'], apps: OUTLOOK_APPS,
            catalogState: READ.OK, providersKnown: true,
        });
        const outlook = rows.find(r => r.appId === 'outlook');
        expect(outlook.grantedCount).toBe(1);
        expect(outlook.grantedNames).toEqual(['outlook_compose']);
        expect(outlook.narrowedBy).toEqual(['outlook-readonly']);
    });

    it('een app die de map NIET noemt versmalt niets — anders zou zwijgen een weigering zijn', () => {
        const cfg = { 'outlook-readonly': { actions: ['outlook_search'] } };
        const { names } = effectiveActionsOf(cfg, OUTLOOK_APPS[0], { apps: OUTLOOK_APPS });
        // `outlook` has no entry (⇒ everything), but `outlook-readonly` does, and that one lets through only search of the
        // three it claims. `compose` it does not claim, so that one stays.
        expect(names).toEqual(['outlook_search', 'outlook_compose']);
    });

    it('zonder catalogus valt er niets te doorsnijden en blijft de eigen grant staan', () => {
        const cfg = { outlook: { actions: ['outlook_read'] } };
        const { names, narrowedBy } = effectiveActionsOf(cfg, OUTLOOK_APPS[0], { apps: [] });
        expect(names).toEqual(['outlook_read']);
        expect(narrowedBy).toEqual([]);
    });
});


describe('de eerste curatie mag geen bijvangst maken', () => {
    const CATALOG = [
        { id: 'gmail', actionsKnown: true, actions: [{ name: 'gmail_search' }, { name: 'gmail_compose' }] },
        { id: 'browser-fetch', requiresGrant: true, actionsKnown: true, actions: [{ name: 'browse_web' }] },
    ];

    it('legt de stand van een `requiresGrant`-app vast zodra de map gecureerd raakt', () => {
        // "Confirm first" on the Gmail row makes the map curated. Without this rule the agent would thereby silently lose
        // its browser.
        const before = null;
        const after = setAppConfirm(before, 'gmail', CONFIRM.ASK);
        const kept = keepRequiresGrantApps(before, after, { apps: CATALOG, enabledIntegrations: ['gmail', 'browser-fetch'] });
        expect(kept['browser-fetch']).toEqual({ actions: '*' });
        expect(grantedActionsOf(kept, 'browser-fetch', { requiresGrant: true })).toBe('*');
    });

    it('...en respecteert daarbij de app-niveau lijst: uit is uit', () => {
        const kept = keepRequiresGrantApps(null, setAppConfirm(null, 'gmail', CONFIRM.ASK), {
            apps: CATALOG, enabledIntegrations: ['gmail'],
        });
        expect(kept['browser-fetch']).toEqual({ actions: [] });
    });

    it('raakt een al gecureerde map niet aan, en verzint niets bij een lege wijziging', () => {
        const curated = { gmail: { actions: ['gmail_search'] } };
        const after = setAppConfirm(curated, 'gmail', CONFIRM.ASK);
        expect(keepRequiresGrantApps(curated, after, { apps: CATALOG })['browser-fetch']).toBeUndefined();
        // From nothing to nothing: no curation, so also no recording.
        expect(keepRequiresGrantApps(null, {}, { apps: CATALOG })).toEqual({});
    });

    it('laat een app die de eigenaar zelf koos met rust', () => {
        const before = null;
        const after = setAppActions(before, 'browser-fetch', []);
        const kept = keepRequiresGrantApps(before, after, { apps: CATALOG });
        expect(kept['browser-fetch']).toEqual({ actions: [] }, 'uitvinken blijft uitvinken');
    });
});
