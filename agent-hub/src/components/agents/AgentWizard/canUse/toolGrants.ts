/**
 * toolGrants — het GRANTS-CONTRACT van de Tools-kaart, puur (A2 stap 3).
 *
 * Hier staat de ene regel waar deze hele stage om draait, en hij staat hier
 * omdat hij nergens anders mag staan: de kaart en de kiezer schrijven allebei
 * aan `config.tools`, en een tweede plek waar dat gebeurt is een tweede plek
 * waar hij vergeten kan worden.
 *
 * ── DE REGEL ────────────────────────────────────────────────────────
 * Een app die de map NIET noemt houdt zijn VOLLEDIGE toolbelt.
 *
 * Dat is bewust — het is de "geen migratie"-regel van
 * `server/core/agentRuntime/toolPolicy.js`: elke agent van vóór de kiezer
 * houdt zijn tools zonder datamigratie. Het gevolg is precies andersom dan je
 * zou verwachten:
 *
 *   een app UITVINKEN  ⇒  `{ actions: [] }` WEGSCHRIJVEN
 *   de sleutel weglaten ⇒  de HELE app teruggeven
 *
 * Dus: de map mag NOOIT gebouwd worden uit alleen de aangevinkte apps. Wie
 * `Object.fromEntries(selected.map(...))` schrijft, geeft elke uitgevinkte app
 * in stilte alles terug. Dezelfde val sloeg al toe op de automations-sectie: "alle
 * automations uitvinken" leverde ÁLLE automatiseringen op, omdat de lege sectie werd
 * weggegooid en daarna las als "nooit gekozen". Zie
 * `.claude/handoff/A1B-RECHTENLAAG-REVIEW.md`, bevinding 1.
 *
 * ── DE ANDERE HELFT VAN DEZELFDE VAL ────────────────────────────────
 * De beginselectie van de kiezer moet een ONTBREKENDE entry uitklappen naar
 * álle acties van die app. Doe je dat niet, dan staat een agent van vóór de
 * kiezer open met nul vinkjes terwijl hij in werkelijkheid alles mag — en de
 * eerste keer opslaan neemt hem alles af, zonder dat iemand iets uitvinkte.
 * `initialSelection` doet dat; `applyAppSelection` is er de tegenhanger van.
 *
 * ── WAT HIER NIET IN ZIT ────────────────────────────────────────────
 * Zinnen. Dit zijn feiten en mutaties; de tekst staat in `ToolsCard.jsx`, waar
 * ook de letterlijke `t()`-sleutels staan die de i18n-guard leest.
 */

import { isAgentCallable } from '../../../admin/Studio/SkillsStudio/skillModel';
import { READ } from './canUseFacts';
import type { ToolApp } from './toolCatalogTypes';
import type { CallableAutomation } from '../../../admin/Studio/SkillsStudio/skillModel.types';
import type { AutomationLike, ToolsConfig, ToolsConfigIn, ClaimantsIndex, SelectionMap, LendingNoticeOfArgs, ToolRowArgs, ToolRowsArgs, AutomationRowsArgs } from './toolGrants.types';
export type { AutomationLike, ToolsConfig, SelectionMap } from './toolGrants.types';

export const RESERVED_TOOL_KEYS = Object.freeze(['automations', 'datatables']);

/** Sleutels die een gewoon object niet veilig kan dragen (spiegel van toolPolicy.js). */
const UNSAFE_OBJECT_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

export const CONFIRM = Object.freeze({ DIRECT: 'direct', ASK: 'ask' });
export const ACT_AS = Object.freeze({ VIEWER: 'viewer', OWNER: 'owner' });

/**
 * In wiens naam een app draait, als VRAAG en niet als antwoord.
 *
 *   USER      de app leent een gebruikersverbinding (Gmail, Drive, YouTrack).
 *             Alleen hier heeft "in wiens naam" betekenis, en alleen hier
 *             wordt `actAs` opgeslagen;
 *   PLATFORM  de app heeft geen gebruikersverbinding — websearch, ingebouwde
 *             tools, platformdiensten. Statisch "Als: Bee Flow", geen keuze,
 *             en GEEN `actAs` in de config: een opgeslagen keuze die niets
 *             stuurt is precies wat toolPolicy.js verbiedt;
 *   UNKNOWN   we konden het niet vragen. Dat is geen PLATFORM — dat zou een
 *             app die wél credentials leent als "Bee Flow" tekenen.
 */
export const ACT_AS_KIND = Object.freeze({ USER: 'user', PLATFORM: 'platform', UNKNOWN: 'unknown' });

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Alleen niet-lege strings, uniek, in volgorde. */
function uniqueStrings(list: unknown) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of Array.isArray(list) ? list : []) {
        if (typeof s !== 'string' || !s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

/** Is dit een app-sleutel (en niet een gereserveerde sectie of iets gevaarlijks)? */
export function isAppKey(key: unknown): key is string {
    return typeof key === 'string' && !!key
        && !RESERVED_TOOL_KEYS.includes(key)
        && !UNSAFE_OBJECT_KEYS.has(key);
}

/**
 * De gegunde acties van één app: `'*'` (alles) of een lijst.
 *
 * Exacte spiegel van `allowedToolsFor` in toolPolicy.js, inclusief de
 * versmalling die daar sinds A1c staat: een `actions` die niemand kan lezen is
 * GEEN verzoek om alles, dus die wordt `[]`. Een ONTBREKENDE entry blijft
 * `'*'` — dat is de "geen migratie"-regel en het is iets heel anders.
 *
 * `requiresGrant` (uit de catalogus, `app.requiresGrant`) is de uitzondering
 * die A2-1 toevoegde: bij een app die de kiezer NOOIT kon tonen betekent
 * zwijgen niets in plaats van alles. Zie het blok in de functie.
 */
export function grantedActionsOf(toolsConfig: ToolsConfigIn, appId: string | null | undefined, { requiresGrant = false } = {}) {
    if (!isPlainObject(toolsConfig) || !isAppKey(appId)) return '*';
    const entry = toolsConfig[appId];
    if (!isPlainObject(entry)) {
        // Geen entry ⇒ alles (de regel). Een entry die geen object IS ⇒ de
        // server maakt er `{actions: []}` van, dus dat is wat hier hoort te
        // staan; anders zou de kaart "alles" tonen voor een grant die de
        // runtime tot niets versmalt.
        if (entry !== undefined) return [];
        // ...BEHALVE bij een app die de kiezer nooit kon tonen (`requiresGrant`
        // uit de catalogus; `browse_web` en de andere inline geregistreerde
        // tools). Zwijgen is daar geen keuze — niemand kreeg die app ooit te
        // zien, dus "de eigenaar liet hem staan" kan niet waar zijn. De server
        // leest het zo (toolPolicy.isToolAllowed → appRequiresExplicitGrant),
        // en zonder deze spiegel opent de kiezer met vinkjes aan die de runtime
        // weigert. Alleen bij een GECUREERDE agent: zonder curatie kijkt de
        // rechtenlaag niet eens naar de map, en dan mag de app ook echt alles.
        return requiresGrant && hasCuratedGrants(toolsConfig) ? [] : '*';
    }
    const { actions } = entry;
    if (actions === '*') return '*';
    if (actions === undefined || actions === null) {
        // Een entry ZONDER actielijst. Bij een gewone app is dat nog steeds
        // "alles" (de geen-migratieregel), maar bij een app die de kiezer nooit
        // kon tonen niet: daar is alleen een UITGESCHREVEN keuze toestemming.
        // De kaart zet zulke entries zelf neer — `setAppConfirm` en
        // `setAppActAs` schrijven `{confirm}` respectievelijk `{actAs}` — dus
        // zonder deze spiegel zou de kaart vinkjes tonen die de runtime weigert
        // (server/core/agentRuntime/toolPolicy.js `_appAllowsTool`).
        return requiresGrant && hasCuratedGrants(toolsConfig) ? [] : '*';
    }
    if (!Array.isArray(actions)) return [];
    return uniqueStrings(actions);
}

// ── Twee rijen over dezelfde module ─────────────────────────────────

/**
 * Wie LEVERT welke toolnaam? `naam → [appId, …]`, uit de catalogus.
 *
 * Twee registry-entries kunnen dezelfde tools leveren op dezelfde credentials
 * (`outlook` en `outlook-readonly`), en de runtime laat dan ELKE claimende app
 * zijn grant uitspreken: de smalste wint (toolPolicy.js `_decidingApps`). De
 * kaart wist daar niets van en telde per rij alleen de eigen entry — dus
 * rapporteerde zij vier aangevinkte acties waar de runtime er één serveert.
 */
export function claimantsOf(apps: ToolApp[]) {
    const out: ClaimantsIndex = new Map();
    for (const app of Array.isArray(apps) ? apps : []) {
        if (!app || !isAppKey(app.id) || !Array.isArray(app.actions)) continue;
        for (const a of app.actions) {
            const name = a && a.name;
            if (typeof name !== 'string' || !name) continue;
            if (!out.has(name)) out.set(name, []);
            const ids = out.get(name);
            if (!ids?.includes(app.id)) ids?.push(app.id);
        }
    }
    return out;
}

/**
 * De acties van één app die de runtime ECHT honoreert.
 *
 * De eigen grant, doorsneden met die van elke andere app die dezelfde naam
 * levert — precies wat `isToolAllowed` doet. Zonder catalogus valt er niets te
 * doorsnijden en is het antwoord de eigen grant.
 *
 * @returns {{names: string[]|null, narrowedBy: string[]}} `names: null` = de
 *   acties van deze app zijn onbekend, en dan is er niets te tonen.
 */
export function effectiveActionsOf(toolsConfig: ToolsConfigIn, app: ToolApp | null, { apps = null, claimants = null }: { apps?: ToolApp[] | null; claimants?: ClaimantsIndex | null } = {}) {
    const known = !!app && app.actionsKnown !== false && Array.isArray(app.actions);
    const granted = grantedActionsOf(toolsConfig, app && app.id, {
        requiresGrant: !!(app && app.requiresGrant),
    });
    if (!known) return { names: granted === '*' ? null : granted, narrowedBy: [] };

    const own = uniqueStrings(app.actions?.map(a => a && a.name));
    const mine = granted === '*' ? own : own.filter(n => granted.includes(n));
    const index = claimants instanceof Map ? claimants : claimantsOf(apps || []);
    const byId = new Map((Array.isArray(apps) ? apps : []).map(a => [a && a.id, a]));

    const narrowedBy: string[] = [];
    const names = mine.filter((name) => {
        const ids = index.get(name);
        if (!Array.isArray(ids) || ids.length < 2) return true;
        for (const id of ids) {
            if (id === app.id) continue;
            const other = byId.get(id);
            const g = grantedActionsOf(toolsConfig, id, { requiresGrant: !!(other && other.requiresGrant) });
            if (g === '*' || g.includes(name)) continue;
            if (!narrowedBy.includes(id)) narrowedBy.push(id);
            return false;
        }
        return true;
    });
    return { names, narrowedBy };
}

/**
 * Heeft deze agent al een GECUREERDE map? Spiegel van `hasCuratedGrants` in
 * toolPolicy.js (r569).
 *
 * Dit is de opt-in-grens van het hele mechanisme: zolang het antwoord `false`
 * is, kijkt de runtime niet eens naar de map — geen bevestigingsregime, geen
 * `enforceNames`. De EERSTE entry zet dat om, en dat is een merkbare
 * gedragswijziging voor een agent die vandaag onbeheerd draait. De kiezer mag
 * die dus niet stil laten gebeuren; hij zegt het hardop vóór de eerste keer
 * opslaan.
 *
 * Junk telt niet mee (een entry die geen object is gunt niets), en een LEGE
 * gereserveerde sectie ook niet — precies zoals de server hem leest.
 */
export function hasCuratedGrants(toolsConfig: ToolsConfigIn) {
    if (!isPlainObject(toolsConfig)) return false;
    for (const [key, entry] of Object.entries(toolsConfig)) {
        if (UNSAFE_OBJECT_KEYS.has(key) || !isPlainObject(entry)) continue;
        if (!RESERVED_TOOL_KEYS.includes(key)) return true;
        if (Object.keys(entry).length > 0) return true;
    }
    return false;
}

/** Het opgeslagen `confirm` van een app, of `null` als er geen keuze staat. */
export function storedConfirmOf(toolsConfig: ToolsConfigIn, appId: string) {
    const entry = isPlainObject(toolsConfig) ? toolsConfig[appId] : null;
    if (!isPlainObject(entry)) return null;
    return entry.confirm === CONFIRM.DIRECT || entry.confirm === CONFIRM.ASK ? entry.confirm : null;
}

/** Het opgeslagen `actAs` van een app, of `null` als er geen keuze staat. */
export function storedActAsOf(toolsConfig: ToolsConfigIn, appId: string) {
    const entry = isPlainObject(toolsConfig) ? toolsConfig[appId] : null;
    if (!isPlainObject(entry)) return null;
    return entry.actAs === ACT_AS.OWNER || entry.actAs === ACT_AS.VIEWER ? entry.actAs : null;
}

/** Een kopie van de map, met de gereserveerde secties intact. */
function cloneTools(toolsConfig: ToolsConfigIn) {
    const out: ToolsConfig = {};
    if (!isPlainObject(toolsConfig)) return out;
    for (const [key, value] of Object.entries(toolsConfig)) {
        if (UNSAFE_OBJECT_KEYS.has(key)) continue;
        out[key] = value;
    }
    return out;
}

/**
 * Schrijf de acties van één app.
 *
 * `actions` is `'*'` (de hele app) of een lijst. EEN LEGE LIJST WORDT
 * OPGESLAGEN — dat is het hele contract. `delete out[appId]` hoort hier niet
 * te staan en mag hier nooit komen te staan: dat geeft de app terug.
 */
export function setAppActions(toolsConfig: ToolsConfigIn, appId: string, actions: string | (string | undefined)[]) {
    if (!isAppKey(appId)) return isPlainObject(toolsConfig) ? cloneTools(toolsConfig) : {};
    const out = cloneTools(toolsConfig);
    const prev: Record<string, unknown> = isPlainObject(out[appId]) ? out[appId] : {};
    const next: Record<string, unknown> = { ...prev };
    next.actions = actions === '*' ? '*' : uniqueStrings(actions);
    out[appId] = next;
    return out;
}

/**
 * Schrijf het bevestigingsbeleid van één app.
 *
 * De ACTIES blijven staan zoals ze waren — ook als er nog geen entry was, en
 * dan betekent een ontbrekende `actions` nog steeds "de hele app". Er wordt
 * hier dus niets afgenomen; er wordt een keuze bij gezet.
 */
export function setAppConfirm(toolsConfig: ToolsConfigIn, appId: string, confirm: string, { requiresGrant = false } = {}) {
    if (!isAppKey(appId) || (confirm !== CONFIRM.DIRECT && confirm !== CONFIRM.ASK)) {
        return cloneTools(toolsConfig);
    }
    const out = cloneTools(toolsConfig);
    out[appId] = { ..._entryKeepingActions(toolsConfig, appId, requiresGrant), confirm };
    return out;
}

/**
 * De entry van een app, met zijn HUIDIGE acties uitgeschreven.
 *
 * Een entry BIJZETTEN mag niet stilzwijgend acties toevoegen of afnemen, en dat
 * kon het wel: `{confirm}` of `{actAs}` neerzetten zonder `actions` maakte van
 * "de eigenaar zei niets over deze app" een entry, en bij een app die de kiezer
 * nooit kon tonen (`requiresGrant`) betekent dat het verschil tussen NIETS en
 * ALLES — twee versmallende gebaren op de kaart gaven zo een volledige headless
 * browser aan een gecureerde agent. Door de acties expliciet mee te schrijven
 * betekent de entry na afloop precies wat de rij ervoor toonde.
 */
function _entryKeepingActions(toolsConfig: ToolsConfigIn, appId: string, requiresGrant: boolean): Record<string, unknown> {
    const prev: Record<string, unknown> = isPlainObject(toolsConfig) && isPlainObject(toolsConfig[appId]) ? toolsConfig[appId] : {};
    if (prev.actions === '*' || Array.isArray(prev.actions)) return { ...prev };
    const granted = grantedActionsOf(toolsConfig, appId, { requiresGrant });
    return { ...prev, actions: granted === '*' ? '*' : [...granted] };
}

/**
 * Schrijf "in wiens naam" voor één app.
 *
 * `null` HAALT de keuze weg in plaats van er `viewer` van te maken. Dat is het
 * verschil tussen "de eigenaar koos de vrager" en "de eigenaar koos niets", en
 * `mayLendOwnerConnection` leest dat verschil: alleen een OPGESLAGEN `actAs`
 * beslist daar, een ontbrekende laat de standaard staan.
 */
export function setAppActAs(toolsConfig: ToolsConfigIn, appId: string, actAs: string | null, { requiresGrant = false } = {}) {
    if (!isAppKey(appId)) return cloneTools(toolsConfig);
    const out = cloneTools(toolsConfig);
    // Zelfde reden als bij `setAppConfirm`: een entry bijzetten mag de acties
    // niet veranderen, dus ze gaan expliciet mee.
    const next = _entryKeepingActions(toolsConfig, appId, requiresGrant);
    if (actAs === ACT_AS.OWNER || actAs === ACT_AS.VIEWER) next.actAs = actAs;
    else delete next.actAs;
    out[appId] = next;
    return out;
}

/**
 * De beginselectie van de kiezer: welke acties staan er vandaag AAN?
 *
 * Een app zonder entry krijgt AL ZIJN acties, want dat is wat hij vandaag mag.
 * Zonder deze uitklap zou de kiezer een agent van vóór A1b met nul vinkjes
 * openen en zou de eerste opslag hem alles afnemen — een "migratie" die
 * niemand vroeg en niemand ziet.
 *
 * Een app waarvan we de acties NIET kennen (de catalogus mist hem, of zijn
 * module laadde niet) levert `null`: dat is niet "geen acties", en de
 * aanroeper mag er dus ook geen selectie van maken.
 *
 * Een app met `requiresGrant` gaat op een GECUREERDE agent juist met nul
 * vinkjes open: daar is een ontbrekende entry geen "alles" maar een "niets"
 * (zie `grantedActionsOf`). Zonder die tweede helft zou de kiezer vinkjes
 * tonen die de runtime niet honoreert — en `commitSelection` schrijft alleen
 * wat VERANDERDE, dus die vinkjes zouden nooit een echte grant worden.
 *
 * @param {object|null} toolsConfig
 * @param {Array<{id: string, actions?: Array<{name: string}>, actionsKnown?: boolean,
 *                requiresGrant?: boolean}>} apps
 * @returns {Map<string, Set<string>|null>} per app-id de aangevinkte acties
 */
export function initialSelection(toolsConfig: ToolsConfigIn, apps: ToolApp[], { catalog = null }: { catalog?: ToolApp[] | null } = {}) {
    const out: SelectionMap = new Map();
    const list = Array.isArray(apps) ? apps : [];
    // De doorsnede wordt tegen de VOLLEDIGE catalogus gemaakt, ook als de
    // kiezer maar één rij per grant-subject toont: een app die hier niet in
    // beeld is kan de namen nog steeds versmallen, en dan opent de kiezer met
    // vinkjes die bij dispatch alsnog weigeren.
    const full = Array.isArray(catalog) && catalog.length ? catalog : list;
    const claimants = claimantsOf(full);
    for (const app of list) {
        if (!app || !isAppKey(app.id)) continue;
        if (app.actionsKnown === false) { out.set(app.id, null); continue; }
        // De EFFECTIEVE lezing: levert een tweede app dezelfde namen, dan telt
        // ook zijn grant mee (de runtime doet dat ook). Anders opent de kiezer
        // met vinkjes die bij dispatch alsnog weigeren.
        const { names } = effectiveActionsOf(toolsConfig, app, { apps: full, claimants });
        out.set(app.id, new Set(names || []));
    }
    return out;
}

/**
 * De kiezer commit: schrijf de selectie van ELKE getoonde app weg.
 *
 * `shownApps` is de lijst apps die de kiezer heeft LATEN ZIEN. Elke app daarin
 * krijgt een entry — óók de app waar niets van aanstaat, want juist die entry
 * is het uitvinken. Een app die de kiezer niet toonde (niet beschikbaar voor
 * deze gebruiker, of gefilterd weg) blijft ONAANGERAAKT: over die app heeft
 * niemand iets gezegd, en er een refusal voor schrijven zou een keuze
 * verzinnen.
 *
 * Een app waarvan de acties onbekend zijn (`actionsKnown === false`, of
 * `selection.get(id) === null`) blijft óók onaangeraakt: je kunt niet
 * wegschrijven wat er aanstaat als je niet weet wat er is.
 *
 * @param {object|null} toolsConfig
 * @param {{shownApps: Array<{id: string, actions?: Array<{name: string}>, actionsKnown?: boolean}>,
 *          selection: Map<string, Set<string>|Array<string>|null>}} p
 */
export function applyAppSelection(toolsConfig: ToolsConfigIn, { shownApps = [], selection = new Map() }: { shownApps?: ToolApp[]; selection?: SelectionMap | Record<string, Set<string> | null> | null } = {}, { catalog = null }: { catalog?: ToolApp[] | null } = {}) {
    let out = cloneTools(toolsConfig);
    const get = (id: string) => (selection instanceof Map ? selection.get(id) : (selection || {})[id]);
    const shown = Array.isArray(shownApps) ? shownApps : [];
    const shownIds = new Set(shown.map(a => a && a.id));
    for (const app of shown) {
        if (!app || !isAppKey(app.id)) continue;
        if (app.actionsKnown === false) continue;
        const picked = get(app.id);
        if (picked === null || picked === undefined) continue;
        const names = uniqueStrings((app.actions || []).map(a => a && a.name));
        const chosen = uniqueStrings([...picked]).filter(n => names.includes(n));
        // ALLES aangevinkt wordt `'*'` en niet de uitgeschreven lijst: dan
        // erft de app een actie die er volgende release bij komt, in plaats
        // van hem stil te missen. Dat is de bedoelde betekenis van `'*'`
        // (toolPolicy.js: "erven bij `'*'`, opt-in bij een lijst").
        const allOn = names.length > 0 && chosen.length === names.length;
        out = setAppActions(out, app.id, allOn ? '*' : chosen);
        out = _syncSharedSiblings(out, app, chosen, catalog, shownIds);
    }
    return out;
}

/**
 * Houd de entries van apps die DEZELFDE toolnamen leveren in de pas.
 *
 * De runtime laat elke claimende app meebeslissen, dus een aangevinkte naam die
 * een andere (niet getoonde) app weigert, is een dood vinkje — opslaanbaar en
 * stil zonder effect, precies wat deze laag verbiedt. Alleen de GEDEELDE namen
 * worden gelijkgetrokken: wat zo'n app exclusief levert, blijft staan zoals het
 * stond, en een app die de map niet noemt wordt niet genoemd (die versmalt
 * niets, en er een entry voor verzinnen zou een keuze verzinnen).
 */
function _syncSharedSiblings(out: ToolsConfig, app: ToolApp, chosen: string[], catalog: ToolApp[] | null, shownIds: Set<string>) {
    if (!Array.isArray(catalog) || !catalog.length) return out;
    const mine = uniqueStrings((app.actions || []).map(a => a && a.name));
    let next = out;
    for (const sib of catalog) {
        if (!sib || !isAppKey(sib.id) || sib.id === app.id) continue;
        if (shownIds && shownIds.has(sib.id)) continue;      // die spreekt voor zichzelf
        if (!isPlainObject(next[sib.id])) continue;          // niet genoemd = alles = versmalt niet
        if (sib.actionsKnown === false || !Array.isArray(sib.actions)) continue;
        const sibNames = uniqueStrings(sib.actions.map(a => a && a.name));
        const shared = sibNames.filter(n => mine.includes(n));
        if (!shared.length) continue;
        const prev = grantedActionsOf(next, sib.id, { requiresGrant: sib.requiresGrant === true });
        const keep = (prev === '*' ? sibNames : prev).filter(n => !shared.includes(n));
        const merged = uniqueStrings([...keep, ...chosen.filter(n => sibNames.includes(n))]);
        next = setAppActions(next, sib.id, merged.length === sibNames.length ? '*' : merged);
    }
    return next;
}

/**
 * De EERSTE curatie verandert de betekenis van ZWIJGEN — leg vast wat er stond.
 *
 * Zolang niemand de agent cureerde, houdt een app die de kiezer nooit kon tonen
 * (`requiresGrant`: de browser, de notebooks, de regex-regels) zijn hele
 * toolbelt; zodra er ÉÉN entry staat, krijgt hij niets meer. Dat is met opzet zo
 * (niemand kreeg die apps ooit te zien, dus zwijgen is geen keuze) — maar het
 * mag niet gebeuren als BIJVANGST van een klik op een andere rij. "Confirm
 * first" aanzetten op Gmail nam anders stilzwijgend de browser weg.
 *
 * Dus: gaat de map van niet-gecureerd naar gecureerd, dan krijgt elke
 * `requiresGrant`-app die nog geen entry heeft zijn HUIDIGE stand
 * uitgeschreven. Dat neemt niets af en voegt niets toe.
 *
 * `enabledIntegrations` telt mee omdat de app-niveau lijst de eerste poort is:
 * een app die daar UIT staat, staat uit — hem hier `'*'` geven zou een grant
 * opslaan die vanzelf echt wordt zodra iemand die lijst aanzet.
 */
export function keepRequiresGrantApps(before: ToolsConfigIn, after: ToolsConfigIn, { apps = null, enabledIntegrations = null }: { apps?: ToolApp[] | null; enabledIntegrations?: string[] | null } = {}) {
    if (!isPlainObject(after)) return after;
    if (hasCuratedGrants(before) || !hasCuratedGrants(after)) return after;
    let out = after;
    for (const app of Array.isArray(apps) ? apps : []) {
        if (!app || !isAppKey(app.id) || app.requiresGrant !== true) continue;
        if (Object.prototype.hasOwnProperty.call(out, app.id)) continue;
        const appOn = !Array.isArray(enabledIntegrations) || enabledIntegrations.includes(app.id);
        const granted = appOn ? grantedActionsOf(before, app.id, { requiresGrant: true }) : [];
        out = setAppActions(out, app.id, granted === '*' ? '*' : [...granted]);
    }
    return out;
}

// ── De rijen van de Tools-kaart ─────────────────────────────────────

/**
 * Verstuurt deze app iets, gegeven wat er gegund is?
 *
 * `true` / `false` / `null` — en `null` is niet "nee". Zonder catalogus weten
 * we niet wat een actie doet, en dan is de smalle lezing de enige eerlijke:
 * de kaart vergrendelt op "eerst bevestigen". Precies wat
 * `normaliseToolsConfig` doet als de attributie stuk is: onbekend telt als
 * "het verstuurt".
 */
export function sendsFor(granted: '*' | (string | undefined)[] | null, app: ToolApp | null) {
    if (!app || app.actionsKnown === false || !Array.isArray(app.actions)) return null;
    const relevant = granted === '*'
        ? app.actions
        : app.actions.filter(a => a && (granted as (string | undefined)[]).includes(a.name));
    if (relevant.some(a => a && a.effect === 'sends')) return true;
    // Een actie zonder effect-veld is een actie waarvan we het effect niet
    // weten. Eén daarvan maakt het antwoord onbekend voor de hele app.
    if (relevant.some(a => !a || typeof a.effect !== 'string' || !a.effect)) return null;
    return false;
}

function lendingNoticeOf({ actAsKind, appId, lentApps, lendingEnabled, curated, storedActAs }: LendingNoticeOfArgs) {
    const lendable = actAsKind === ACT_AS_KIND.USER && !!lendingEnabled
        && lentApps instanceof Set && lentApps.has(appId);
    if (curated !== true && curated !== false) return { ownerLendsUncurated: false, ownerLendingUnset: false };
    return {
        ownerLendsUncurated: lendable && !curated,
        ownerLendingUnset: lendable && curated && storedActAs === null,
    };
}

function toolRow({
    appId, label, toolsConfig, app, lentApps, lendingEnabled, curated = false,
    apps = null, claimants = null,
}: ToolRowArgs) {
    const granted = grantedActionsOf(toolsConfig, appId, { requiresGrant: !!(app && app.requiresGrant) });
    const known = !!app && app.actionsKnown !== false && Array.isArray(app.actions);
    const totalActions = known ? app.actions?.length : null;
    // Wat de RUNTIME serveert, niet wat deze ene entry zegt: levert een tweede
    // app dezelfde namen, dan moet die ook toestaan (toolPolicy `_decidingApps`).
    // Zonder die doorsnede telde de rij vier aangevinkte acties waar er één
    // draaide — over-rapporteren, precies de richting die deze laag verbiedt.
    const { names: effective, narrowedBy } = effectiveActionsOf(toolsConfig, app, { apps, claimants });
    const grantedNames = known ? effective : (granted === '*' ? null : granted);
    const grantedCount = known ? effective?.length : (granted === '*' ? totalActions : granted.length);

    const sends = sendsFor(known ? effective : granted, app);
    const storedConfirm = storedConfirmOf(toolsConfig, appId);
    // Vergrendeld zodra de app kán versturen — óók bij `'*'`. De opgeslagen
    // waarde mag daar `direct` zijn (normalisatie forceert alleen op een
    // LIJST), maar `confirmForTool` beslist bij dispatch op het effect en zegt
    // dan alsnog `ask`. Een schakelaar die "direct" toont waar de runtime
    // altijd vraagt, is een opgeslagen belofte die niemand nakomt.
    const confirmLocked = sends !== false;
    const confirm = confirmLocked ? CONFIRM.ASK : (storedConfirm || CONFIRM.DIRECT);

    const provider = app && typeof app.provider === 'string' && app.provider ? app.provider : null;
    let actAsKind: string = ACT_AS_KIND.UNKNOWN;
    if (app && app.providersKnown) actAsKind = provider ? ACT_AS_KIND.USER : ACT_AS_KIND.PLATFORM;

    const lentKnown = lentApps instanceof Set;
    const canActAsOwner = actAsKind === ACT_AS_KIND.USER
        && !!lendingEnabled
        && lentKnown
        && lentApps.has(appId)
        // Een geleende verbinding verstuurt nooit zonder de eigenaar erbij —
        // dezelfde weigering als in normaliseToolsConfig, en onbekend telt
        // daar óók als versturen.
        && sends === false;

    const storedActAs = storedActAsOf(toolsConfig, appId);
    const actAs = canActAsOwner && storedActAs === ACT_AS.OWNER ? ACT_AS.OWNER : ACT_AS.VIEWER;

    const { ownerLendsUncurated, ownerLendingUnset } = lendingNoticeOf({
        actAsKind, appId, lentApps, lendingEnabled, curated, storedActAs,
    });

    return {
        appId,
        label: label || (app && app.label) || appId,
        granted,
        grantedNames,
        grantedCount,
        totalActions,
        actionsKnown: known,
        available: app ? (app.available === undefined ? null : app.available) : null,
        // WAAROM hij kan ontbreken (catalogus: `availabilityKind`). "Deze
        // installatie heeft hem niet" is een ander feit dan "jij hebt hem niet
        // verbonden", en de kaart mag alleen de zin zeggen die waar is.
        // Onbekend blijft null: dan staat de algemene zin er, geen verzonnen.
        availabilityKind: app && typeof app.availabilityKind === 'string' && app.availabilityKind
            ? app.availabilityKind
            : null,
        // ALLE oorzaken waarom deze app kan ontbreken. `availabilityKind` is
        // alleen gevuld als er PRECIES ÉÉN is; bij meerdere zou het een feit
        // beweren dat niet uit de meting komt ("deze installatie heeft hem
        // niet" terwijl het over het account gaat). Zie routes/agents/toolCatalog.js.
        availabilityKinds: app && Array.isArray(app.availabilityKinds)
            ? app.availabilityKinds.filter(k => typeof k === 'string' && k)
            : [],
        sends,
        // Welke ANDERE app deze rij versmalt (dezelfde tools, een strengere
        // grant). Leeg als er niets doorsnijdt.
        narrowedBy,
        confirm,
        confirmLocked,
        actAsKind,
        actAs,
        canActAsOwner,
        // "De eigenaar koos owner, maar dat mag niet (meer)" — de rij zegt dat
        // hardop in plaats van stil `viewer` te tonen alsof dat de keuze was.
        ownerRefused: storedActAs === ACT_AS.OWNER && !canActAsOwner,
        ownerLendsUncurated,
        ownerLendingUnset,
    };
}

export function toolRows({
    toolsConfig = null,
    enabledIntegrations = [],
    apps = null,
    catalogState = READ.OK,
    providersKnown = false,
    labels = null,
    lentApps = null,
    lendingEnabled = false,
    runtimeCurated = undefined,
}: ToolRowsArgs = {}) {
    const labelOf = (id: string) => {
        if (labels instanceof Map) return labels.get(id) || null;
        if (labels && typeof labels === 'object' && typeof labels[id] === 'string') return labels[id];
        return null;
    };
    const byId = new Map<string, ToolApp>();
    if (catalogState === READ.OK && Array.isArray(apps)) {
        for (const app of apps) {
            if (app && isAppKey(app.id)) byId.set(app.id, { ...app });
        }
    }
    // `providersKnown` is een eigenschap van het ANTWOORD, niet van één app;
    // hij reist mee op elke rij zodat `toolRow` puur kan blijven.
    const known = catalogState === READ.OK && !!providersKnown;
    // Idem voor de curatie: een eigenschap van de AGENT, één keer berekend.
    //
    // De leen-meldingen doen een uitspraak over wat de RUNTIME doet, en die
    // leest `published_config` — niet de draft die hier in handen is. Eén vinkje
    // in de kiezer maakte de draft gecureerd en de kaart meldde meteen dat er
    // niet meer geleend werd, terwijl de gepubliceerde agent gewoon doorleende.
    // Daarom telt het antwoord van de server (`runtimeCurated` uit
    // GET /agents/:id/tool-lending); `null`/onbekend zegt niets, want een
    // geruststelling die niet klopt is erger dan geen zin.
    const curated = runtimeCurated === undefined ? hasCuratedGrants(toolsConfig) : runtimeCurated;
    // Wie levert welke toolnaam — één keer voor alle rijen.
    const claimants = claimantsOf(catalogState === READ.OK && Array.isArray(apps) ? apps : []);

    const ids: string[] = [];
    const push = (id: string) => { if (isAppKey(id) && !ids.includes(id)) ids.push(id); };
    if (Array.isArray(enabledIntegrations)) {
        for (const id of enabledIntegrations) push(id);
    } else if (byId.size > 0) {
        // Legacy `null`: alles wat beschikbaar is staat aan. "Beschikbaar" is
        // een vraag die alleen de catalogus beantwoordt, en een app waarvan
        // dat onbekend is (`available === null`) tellen we mee — weglaten zou
        // beweren dat de agent hem niet heeft.
        for (const [id, app] of byId) if (app.available !== false) push(id);
    }
    for (const key of Object.keys(isPlainObject(toolsConfig) ? toolsConfig : {})) push(key);

    const catalog = catalogState === READ.OK && Array.isArray(apps) ? apps : [];
    return ids.map(appId => toolRow({
        appId,
        label: byId.get(appId)?.label || labelOf(appId),
        toolsConfig,
        app: byId.has(appId) ? { ...(byId.get(appId) as ToolApp), providersKnown: known } : null,
        lentApps,
        lendingEnabled,
        curated,
        apps: catalog,
        claimants,
    }));
}

// ── Automations als tool ────────────────────────────────────────────

/** De gegunde automatiseringen uit `config.tools.automations`, in configvolgorde. */
export function automationGrantsOf(toolsConfig: ToolsConfigIn) {
    if (!isPlainObject(toolsConfig) || !isPlainObject(toolsConfig.automations)) return [];
    return Object.keys(toolsConfig.automations)
        .filter(id => !UNSAFE_OBJECT_KEYS.has(id))
        .map((id) => {
            const g = (toolsConfig.automations as Record<string, unknown>)[id];
            // Spiegel van normaliseToolsConfig: een confirm die niemand kan
            // lezen is NIET "geen bevestiging". Onleesbaar ⇒ `ask`.
            const confirm = isPlainObject(g) && (g.confirm === CONFIRM.DIRECT || g.confirm === CONFIRM.ASK)
                ? g.confirm
                : (isPlainObject(g) && g.confirm === undefined ? CONFIRM.DIRECT : CONFIRM.ASK);
            return { id, confirm };
        });
}

/**
 * De parameterpillen van een automatisering: de velden die de agent moet meegeven.
 *
 * Uit `trigger.parametersSchema` — hetzelfde schema waaruit
 * `automationToTool` de tool-signatuur rendert, dus wat hier op het scherm
 * staat is letterlijk wat het model moet invullen. Vereiste velden eerst.
 */
export function paramPillsOf(automation: AutomationLike | null | undefined) {
    const schema = automation?.definition?.trigger?.parametersSchema
        ?? automation?.trigger?.parametersSchema
        ?? null;
    if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return [];
    const required = new Set(uniqueStrings(schema.required));
    return Object.keys(schema.properties)
        .filter(name => !UNSAFE_OBJECT_KEYS.has(name))
        .map(name => ({ name, required: required.has(name) }))
        .sort((a, b) => Number(b.required) - Number(a.required));
}

export function automationRows({ toolsConfig, automations, state = READ.OK, linkedIds = null }: AutomationRowsArgs) {
    const linked = linkedIds ? new Set(linkedIds) : null;
    const grants = automationGrantsOf(toolsConfig);
    const index = state === READ.OK && Array.isArray(automations) ? new Map(
        automations.filter(a => a && typeof a.id === 'string').map(a => [a.id, a]),
    ) : null;
    return grants.map(({ id, confirm }) => {
        const automation = index ? index.get(id) : null;
        if (!automation) {
            return { id, name: null, confirm, params: [], callable: null, linked: linked ? linked.has(id) : null, readable: false };
        }
        return {
            id,
            name: typeof automation.title === 'string' && automation.title
                ? automation.title
                : (typeof automation.name === 'string' && automation.name ? automation.name : null),
            confirm,
            params: paramPillsOf(automation),
            callable: isAgentCallable(automation),
            linked: linked ? linked.has(id) : null,
            readable: true,
        };
    });
}
