// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    changedAppIds, chooserInitialSelection, commitSelection, foldSharedApps, isAppEnabled, selectionDelta,
} from './toolChooserModel';
import { grantedActionsOf } from './toolGrants';

/**
 * De gefaseerde selectie van de kiezer.
 *
 * `toolGrants.test.js` pint de REGEL (uitvinken schrijft, weglaten geeft
 * terug). Wat hier gepind wordt is de kiezer eromheen: dat een uitgezette app
 * niet met alle vinkjes aan opengaat, dat openen-en-sluiten niets schrijft, en
 * dat één klik allebei de poorten bedient.
 */

const APPS = [
    {
        id: 'gmail', label: 'Gmail', available: true, actionsKnown: true,
        actions: [
            { name: 'gmail_search', effect: 'reads' },
            { name: 'gmail_compose', effect: 'sends' },
            { name: 'gmail_create_draft', effect: 'writes' },
        ],
    },
    {
        id: 'google-drive', label: 'Drive', available: true, actionsKnown: true,
        actions: [
            { name: 'drive_search', effect: 'reads' },
            { name: 'drive_upload_file', effect: 'writes' },
        ],
    },
    { id: 'broken', label: 'Broken', available: true, actionsKnown: false, actions: [] },
];

describe('de beginstand: twee poorten, niet één', () => {
    it('opent een UITGEZETTE app met nul vinkjes, ook al zegt de grants-map "alles"', () => {
        // Zonder deze regel zou elke app uit de catalogus vol aangevinkt
        // opengaan — een ontbrekende tools-entry betekent immers "alles" — en
        // zou de eerste opslag de agent tools geven die niemand koos.
        const sel = chooserInitialSelection({
            toolsConfig: null, enabledIntegrations: ['gmail'], apps: APPS,
        });
        expect([...sel.get('gmail')].sort()).toEqual(['gmail_compose', 'gmail_create_draft', 'gmail_search']);
        expect([...sel.get('google-drive')]).toEqual([]);
    });

    it('klapt een aangezette app zonder entry uit naar al zijn acties', () => {
        const sel = chooserInitialSelection({
            toolsConfig: {}, enabledIntegrations: ['google-drive'], apps: APPS,
        });
        expect([...sel.get('google-drive')].sort()).toEqual(['drive_search', 'drive_upload_file']);
    });

    it('houdt een app met ONBEKENDE acties op `null` — niet op "niets"', () => {
        const sel = chooserInitialSelection({ toolsConfig: null, enabledIntegrations: ['broken'], apps: APPS });
        expect(sel.get('broken')).toBe(null);
    });

    it('legacy `null` betekent "alles wat beschikbaar is staat aan"', () => {
        expect(isAppEnabled(null, 'gmail')).toBe(true);
        const sel = chooserInitialSelection({ toolsConfig: { gmail: { actions: ['gmail_search'] } }, enabledIntegrations: null, apps: APPS });
        expect([...sel.get('gmail')]).toEqual(['gmail_search']);
    });
});

describe('wat er verandert', () => {
    const initial = chooserInitialSelection({
        toolsConfig: { gmail: { actions: ['gmail_search'] } },
        enabledIntegrations: ['gmail'],
        apps: APPS,
    });

    it('openen en sluiten zonder iets aan te raken verandert NIETS', () => {
        expect(changedAppIds(initial, new Map(initial))).toEqual([]);
        expect(selectionDelta(initial, new Map(initial))).toEqual({ added: 0, removed: 0, dirty: false });
    });

    it('telt erbij en eraf apart — een saldo verzwijgt de helft', () => {
        const next = new Map(initial);
        next.set('gmail', new Set(['gmail_compose']));            // search eraf, compose erbij
        next.set('google-drive', new Set(['drive_search']));      // erbij
        expect(selectionDelta(initial, next)).toEqual({ added: 2, removed: 1, dirty: true });
        expect(changedAppIds(initial, next).sort()).toEqual(['gmail', 'google-drive']);
    });

    it('een app met onbekende acties telt nooit mee', () => {
        const next = new Map(initial);
        next.set('broken', new Set(['whatever']));
        expect(changedAppIds(initial, next)).toEqual([]);
        expect(selectionDelta(initial, next).dirty).toBe(false);
    });
});

describe('toepassen: één schrijfbeurt, allebei de poorten', () => {
    const apps = APPS;

    it('zet een app AAN en schrijft zijn acties weg', () => {
        const initial = chooserInitialSelection({ toolsConfig: null, enabledIntegrations: [], apps });
        const selection = new Map(initial);
        selection.set('gmail', new Set(['gmail_search']));

        const out = commitSelection({ toolsConfig: null, enabledIntegrations: [], apps, initial, selection });
        expect(out.enabledIntegrations).toEqual(['gmail']);
        expect(out.tools.gmail.actions).toEqual(['gmail_search']);
        expect(out.enabledChanged).toBe(true);
    });

    it('alles uitvinken zet de app UIT én schrijft de weigering op', () => {
        // Allebei versmallen. De weigering blijft staan als iemand later alleen
        // de app-lijst weer aanzet — dan is er nog steeds niets gekozen.
        const initial = chooserInitialSelection({ toolsConfig: null, enabledIntegrations: ['gmail'], apps });
        const selection = new Map(initial);
        selection.set('gmail', new Set());

        const out = commitSelection({ toolsConfig: null, enabledIntegrations: ['gmail'], apps, initial, selection });
        expect(out.enabledIntegrations).toEqual([]);
        expect(out.tools.gmail.actions).toEqual([]);
        expect(grantedActionsOf(out.tools, 'gmail')).toEqual([]);
    });

    it('schrijft NIETS voor een app waar de eigenaar niets aan deed', () => {
        // Anders zet openen-en-toepassen de agent in het bevestigingsregime
        // (`hasCuratedGrants`) zonder dat iemand een keuze maakte.
        const initial = chooserInitialSelection({ toolsConfig: null, enabledIntegrations: ['gmail', 'google-drive'], apps });
        const selection = new Map(initial);
        selection.set('gmail', new Set(['gmail_search']));

        const out = commitSelection({ toolsConfig: null, enabledIntegrations: ['gmail', 'google-drive'], apps, initial, selection });
        expect(Object.keys(out.tools)).toEqual(['gmail']);
        expect(grantedActionsOf(out.tools, 'google-drive')).toBe('*');
    });

    it('schrijft "*" als alles aanstaat, zodat een nieuwe actie meegaat', () => {
        const initial = chooserInitialSelection({ toolsConfig: { gmail: { actions: ['gmail_search'] } }, enabledIntegrations: ['gmail'], apps });
        const selection = new Map(initial);
        selection.set('gmail', new Set(['gmail_search', 'gmail_compose', 'gmail_create_draft']));

        const out = commitSelection({ toolsConfig: { gmail: { actions: ['gmail_search'] } }, enabledIntegrations: ['gmail'], apps, initial, selection });
        expect(out.tools.gmail.actions).toBe('*');
    });

    it('laat het opgeslagen confirm/actAs van een app staan', () => {
        const before = { gmail: { actions: ['gmail_search'], confirm: 'ask', actAs: 'owner' } };
        const initial = chooserInitialSelection({ toolsConfig: before, enabledIntegrations: ['gmail'], apps });
        const selection = new Map(initial);
        selection.set('gmail', new Set(['gmail_create_draft']));

        const out = commitSelection({ toolsConfig: before, enabledIntegrations: ['gmail'], apps, initial, selection });
        expect(out.tools.gmail).toEqual({ actions: ['gmail_create_draft'], confirm: 'ask', actAs: 'owner' });
    });

    it('raakt de app-lijst NIET aan als hij legacy `null` is — dat zou een migratie zijn', () => {
        const initial = chooserInitialSelection({ toolsConfig: null, enabledIntegrations: null, apps });
        const selection = new Map(initial);
        selection.set('gmail', new Set());

        const out = commitSelection({ toolsConfig: null, enabledIntegrations: null, apps, initial, selection });
        expect(out.enabledIntegrations).toBe(null);
        expect(out.enabledChanged).toBe(false);
        // De weigering doet zijn werk alsnog, op actie-niveau.
        expect(grantedActionsOf(out.tools, 'gmail')).toEqual([]);
    });

    it('laat de gereserveerde secties met rust', () => {
        const before = { automations: { r1: { confirm: 'ask' } }, datatables: { tables: {} } };
        const initial = chooserInitialSelection({ toolsConfig: before, enabledIntegrations: ['gmail'], apps });
        const selection = new Map(initial);
        selection.set('gmail', new Set(['gmail_search']));

        const out = commitSelection({ toolsConfig: before, enabledIntegrations: ['gmail'], apps, initial, selection });
        expect(out.tools.automations).toEqual({ r1: { confirm: 'ask' } });
        expect(out.tools.datatables).toEqual({ tables: {} });
    });
});


// ── Twee rijen over dezelfde module ─────────────────────────────────

const OUTLOOK = {
    id: 'outlook', label: 'Outlook', available: true, actionsKnown: true,
    actions: [
        { name: 'outlook_search', effect: 'reads' },
        { name: 'outlook_read', effect: 'reads' },
        { name: 'outlook_list_recent', effect: 'reads' },
        { name: 'outlook_compose', effect: 'sends' },
    ],
};
const OUTLOOK_RO = {
    id: 'outlook-readonly', label: 'Outlook (read-only)', available: false, actionsKnown: true,
    grantsVia: 'outlook',
    actions: [
        { name: 'outlook_search', effect: 'reads' },
        { name: 'outlook_read', effect: 'reads' },
        { name: 'outlook_list_recent', effect: 'reads' },
    ],
};

describe('één rij per grant-subject', () => {
    it('vouwt de read-only rij weg zolang de volledige rij aanstaat', () => {
        const shown = foldSharedApps([OUTLOOK, OUTLOOK_RO]);
        expect(shown.map(a => a.id)).toEqual(['outlook']);
    });

    it('...en andersom als de gebruiker alleen de smalle smaak heeft', () => {
        const shown = foldSharedApps([
            { ...OUTLOOK, available: false }, { ...OUTLOOK_RO, available: true },
        ]);
        expect(shown.map(a => a.id)).toEqual(['outlook-readonly']);
    });

    it('laat de rij staan als de eigenaar niet eens in de lijst zit', () => {
        expect(foldSharedApps([OUTLOOK_RO]).map(a => a.id)).toEqual(['outlook-readonly']);
    });

    it('één vinkje ERBIJ neemt er nergens twee AF', () => {
        // De bevinding: de kiezer toonde beide rijen, opende de read-only rij
        // met nul vinkjes (de app stond app-niveau uit) en schreef alleen díé
        // rij weg. Resultaat: één leesactie erbij, twee andere weg, en de
        // verzendactie behouden — op een rij die niemand aanraakte.
        const apps = foldSharedApps([OUTLOOK, OUTLOOK_RO]);
        const initial = chooserInitialSelection({
            toolsConfig: null, enabledIntegrations: ['outlook'], apps,
        });
        expect([...initial.get('outlook')]).toHaveLength(4);
        expect(initial.has('outlook-readonly')).toBe(false);

        // De eigenaar haalt één actie weg.
        const selection = new Map(initial);
        selection.set('outlook', new Set(['outlook_search', 'outlook_read', 'outlook_list_recent']));
        const { tools } = commitSelection({
            toolsConfig: null, enabledIntegrations: ['outlook'], apps, initial, selection,
        });
        expect(tools).toEqual({
            outlook: { actions: ['outlook_search', 'outlook_read', 'outlook_list_recent'] },
        });
    });

    it('houdt een niet-getoonde rij van dezelfde module in de pas, alleen op de GEDEELDE namen', () => {
        // Legacy-entry op de read-only rij die de kiezer nu niet toont. Zou hij
        // blijven staan zoals hij was, dan is het vinkje dat de eigenaar hier
        // zet dood: de runtime laat beide apps meebeslissen.
        const catalog = [OUTLOOK, OUTLOOK_RO];
        const apps = foldSharedApps(catalog);
        const before = { 'outlook-readonly': { actions: ['outlook_search'] } };
        const initial = chooserInitialSelection({
            toolsConfig: before, enabledIntegrations: ['outlook'], apps, catalog,
        });
        // De kiezer opent met de EFFECTIEVE stand: search + compose.
        expect([...initial.get('outlook')].sort()).toEqual(['outlook_compose', 'outlook_search']);

        const selection = new Map(initial);
        selection.set('outlook', new Set(['outlook_search', 'outlook_read', 'outlook_compose']));
        const { tools } = commitSelection({
            toolsConfig: before, enabledIntegrations: ['outlook'], apps, catalog, initial, selection,
        });
        expect(tools.outlook).toEqual({ actions: ['outlook_search', 'outlook_read', 'outlook_compose'] });
        expect(tools['outlook-readonly']).toEqual({ actions: ['outlook_search', 'outlook_read'] });
    });
});

describe('de EERSTE curatie verandert de betekenis van zwijgen', () => {
    const BROWSER = {
        id: 'browser-fetch', label: 'Browse Web', available: true, actionsKnown: true,
        requiresGrant: true, actions: [{ name: 'browse_web', effect: 'writes' }],
    };
    const GMAIL = {
        id: 'gmail', label: 'Gmail', available: true, actionsKnown: true,
        actions: [{ name: 'gmail_search', effect: 'reads' }, { name: 'gmail_compose', effect: 'sends' }],
    };

    it('legt vast wat er stond voor een app die de kiezer nooit kon tonen', () => {
        // De kiezer opent browse_web AANGEVINKT (de agent is nog niet
        // gecureerd, dus hij mag alles), de eigenaar versmalt alleen Gmail —
        // en zonder deze regel verliest de agent zijn browser zonder dat
        // iemand hem uitvinkte, terwijl de knop zei "1 eraf".
        const apps = [GMAIL, BROWSER];
        const enabled = ['gmail', 'browser-fetch'];
        const initial = chooserInitialSelection({ toolsConfig: null, enabledIntegrations: enabled, apps });
        expect([...initial.get('browser-fetch')]).toEqual(['browse_web']);

        const selection = new Map(initial);
        selection.set('gmail', new Set(['gmail_search']));
        const { tools, changed } = commitSelection({
            toolsConfig: null, enabledIntegrations: enabled, apps, initial, selection,
        });
        expect(changed).toEqual(['gmail']);
        expect(tools.gmail).toEqual({ actions: ['gmail_search'] });
        expect(tools['browser-fetch']).toEqual({ actions: '*' });
    });

    it('en een browser die de eigenaar WEL uitvinkte blijft uitgevinkt', () => {
        const apps = [GMAIL, BROWSER];
        const enabled = ['gmail', 'browser-fetch'];
        const initial = chooserInitialSelection({ toolsConfig: null, enabledIntegrations: enabled, apps });
        const selection = new Map(initial);
        selection.set('browser-fetch', new Set());
        const { tools } = commitSelection({
            toolsConfig: null, enabledIntegrations: enabled, apps, initial, selection,
        });
        expect(tools['browser-fetch']).toEqual({ actions: [] });
    });

    it('raakt een al gecureerde agent niet aan', () => {
        const apps = [GMAIL, BROWSER];
        const before = { gmail: { actions: ['gmail_search'] } };
        const initial = chooserInitialSelection({
            toolsConfig: before, enabledIntegrations: ['gmail', 'browser-fetch'], apps,
        });
        // Al gecureerd ⇒ de browser opent met NUL vinkjes (de server serveert
        // hem ook niet), en er wordt niets voor hem geschreven.
        expect([...initial.get('browser-fetch')]).toEqual([]);
        const selection = new Map(initial);
        selection.set('gmail', new Set(['gmail_search', 'gmail_compose']));
        const { tools } = commitSelection({
            toolsConfig: before, enabledIntegrations: ['gmail', 'browser-fetch'], apps, initial, selection,
        });
        expect(tools['browser-fetch']).toBeUndefined();
    });
});
