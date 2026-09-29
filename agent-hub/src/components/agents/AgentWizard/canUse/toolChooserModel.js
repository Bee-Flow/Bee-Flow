/**
 * toolChooserModel — de gefaseerde selectie van de tool-kiezer, puur (A2 stap 4).
 *
 * `toolGrants.js` bezit de REGEL (uitvinken schrijft `{actions: []}`, de sleutel
 * weglaten geeft de app terug). Dit bestand bezit wat de KIEZER daar bovenop
 * nodig heeft: hoe de vinkjes eruitzien als je hem opent, wat er verandert
 * terwijl je klikt, en wat er bij "toepassen" precies wordt weggeschreven.
 *
 * ── TWEE POORTEN, NIET ÉÉN ──────────────────────────────────────────
 * Een agent mag een tool pas als hij dóór twee poorten komt:
 *
 *   `config.enabledIntegrations`  staat deze APP aan?      (app-niveau)
 *   `config.tools[app].actions`   welke ACTIES ervan?      (actie-niveau)
 *
 * De kiezer toont één vinkje per actie, dus hij moet ze allebei bedienen.
 * Anders kan hij liegen in beide richtingen: een uitgezette app zou met álle
 * vinkjes aan opengaan (want zonder tools-entry betekent "alles"), en een
 * aangevinkte actie op een uitgezette app zou niets doen.
 *
 *   openen   een app die UIT staat opent met nul vinkjes, ongeacht zijn grants;
 *   ≥1 vink  de app gaat AAN en zijn acties worden weggeschreven;
 *   0 vinken de app gaat UIT én krijgt `{actions: []}` — allebei weigeren, want
 *            allebei versmallen, en de tweede blijft staan als iemand later
 *            alleen de app-lijst aanzet.
 *
 * `enabledIntegrations === null` is de LEGACY-betekenis "alles wat beschikbaar
 * is staat aan". Die lijst materialiseren zou een migratie zijn die niemand
 * vroeg — dus dan blijft de app-poort onaangeraakt en doet alleen de
 * actie-poort zijn werk. Weigeren doet die net zo goed.
 *
 * ── ALLEEN WAT VERANDERDE WORDT GESCHREVEN ──────────────────────────
 * `applyAppSelection` schrijft ELKE app die je hem geeft — daar is hij voor.
 * Wat de kiezer hem geeft, zijn de apps waarvan de selectie ECHT anders is dan
 * bij het openen. Een app waar de eigenaar niets aan deed, blijft dus
 * ongenoemd, en dat is het verschil tussen "hij liet Drive met rust" en "hij
 * bevestigde Drive" — en daarmee ook het verschil tussen wél en niet in het
 * bevestigingsregime belanden (`hasCuratedGrants` in toolPolicy.js wordt waar
 * zodra er één entry staat). Een kiezer die bij openen-en-sluiten alles
 * wegschrijft, zet die schakelaar om zonder dat iemand iets koos.
 */

import { applyAppSelection, hasCuratedGrants, initialSelection, isAppKey, setAppActions } from './toolGrants';

/**
 * Eén rij per GRANT-SUBJECT: twee entries over dezelfde module worden er één.
 *
 * `outlook` en `outlook-readonly` leveren dezelfde tools op dezelfde
 * credentials, en de runtime laat ze allebei meebeslissen (de smalste wint).
 * Toonde de kiezer ze als twee losse rijen, dan kon één vinkje ERBIJ er stil
 * twee AF nemen op de rij ernaast — de eigenaar voegde één leesactie toe, raakte
 * twee andere kwijt en hield de verzendactie, op een rij die hij niet aanraakte.
 *
 * Welke rij het subject is, volgt de BESCHIKBAARHEID: normaal de app die de
 * namen bezit, maar staat die aantoonbaar niet aan terwijl de smalle variant
 * dat wel doet, dan is de smalle het subject — anders schrijft de kiezer grants
 * (en een app-niveau vinkje) op een app die deze gebruiker niet heeft.
 */
export function foldSharedApps(apps) {
    const list = (Array.isArray(apps) ? apps : []).filter(a => a && isAppKey(a.id));
    const byId = new Map(list.map(a => [a.id, a]));
    const superseded = new Set();
    for (const app of list) {
        const via = typeof app.grantsVia === 'string' && app.grantsVia ? app.grantsVia : null;
        if (!via) continue;
        const owner = byId.get(via);
        if (!owner) continue;                     // de eigenaar wordt hier niet getoond
        const narrowWins = owner.available === false && app.available === true;
        superseded.add(narrowWins ? owner.id : app.id);
    }
    return list.filter(a => !superseded.has(a.id));
}

/** Staat deze app aan op app-niveau? Legacy `null` = "alles wat beschikbaar is". */
export function isAppEnabled(enabledIntegrations, appId) {
    if (!Array.isArray(enabledIntegrations)) return true;
    return enabledIntegrations.includes(appId);
}

function asSet(value) {
    // `null` blijft `null` (onbekend); alles wat er niet is, is een lege keuze.
    if (value === null) return null;
    if (value === undefined) return new Set();
    return value instanceof Set ? new Set(value) : new Set(Array.isArray(value) ? value : []);
}

function sameSet(a, b) {
    if (a === null || b === null) return a === b;
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

/**
 * De vinkjes waarmee de kiezer OPENGAAT.
 *
 * Bovenop `initialSelection` (die een ontbrekende entry uitklapt naar álle
 * acties — de "geen migratie"-regel) komt hier de app-poort: staat de app uit,
 * dan staat er niets aan. Onbekende acties blijven `null`; daar valt niets te
 * kiezen en dus ook niets weg te schrijven.
 */
export function chooserInitialSelection({
    toolsConfig = null, enabledIntegrations = null, apps = [], catalog = null,
} = {}) {
    // `apps` = de rijen die de kiezer TOONT (gevouwen); `catalog` = alles wat
    // de server kent. Dat tweede is nodig om de gedeelde namen te kunnen
    // doorsnijden: een app die niet getoond wordt kan ze nog steeds versmallen.
    const expanded = initialSelection(toolsConfig, apps, { catalog });
    const out = new Map();
    for (const [appId, picked] of expanded) {
        if (picked === null) { out.set(appId, null); continue; }
        out.set(appId, isAppEnabled(enabledIntegrations, appId) ? new Set(picked) : new Set());
    }
    return out;
}

/** De app-ids waarvan de selectie verschilt van de beginstand. */
export function changedAppIds(initial, current) {
    const ids = [];
    const initialMap = initial instanceof Map ? initial : new Map();
    const currentMap = current instanceof Map ? current : new Map();
    for (const [appId, before] of initialMap) {
        if (!isAppKey(appId)) continue;
        // Onbekende acties: er valt niets te vergelijken en niets te schrijven.
        if (before === null) continue;
        const after = asSet(currentMap.has(appId) ? currentMap.get(appId) : before);
        if (after === null) continue;
        if (!sameSet(asSet(before), after)) ids.push(appId);
    }
    return ids;
}

/**
 * Hoeveel acties erbij komen en hoeveel eraf gaan — de tekst op de knop.
 *
 * Twee getallen, geen saldo: "3 erbij, 1 eraf" is iets anders dan "2 erbij", en
 * een kiezer die alleen het saldo toont verzwijgt de helft van wat hij doet.
 */
export function selectionDelta(initial, current) {
    let added = 0;
    let removed = 0;
    const initialMap = initial instanceof Map ? initial : new Map();
    const currentMap = current instanceof Map ? current : new Map();
    for (const [appId, before] of initialMap) {
        if (!isAppKey(appId) || before === null) continue;
        const after = asSet(currentMap.has(appId) ? currentMap.get(appId) : before);
        if (after === null) continue;
        const beforeSet = asSet(before);
        for (const name of after) if (!beforeSet.has(name)) added += 1;
        for (const name of beforeSet) if (!after.has(name)) removed += 1;
    }
    return { added, removed, dirty: added > 0 || removed > 0 };
}

/**
 * De app-niveau lijst na de kiezer: ≥1 vinkje zet de app aan, nul zet hem uit.
 *
 * Alleen de apps die VERANDERDEN doen mee. Over de rest zei niemand iets, en
 * een lijst herschrijven op grond van een selectie die je niet toonde is
 * hetzelfde soort stilzwijgende migratie als een grants-map die je uit de
 * aangevinkte apps opbouwt.
 */
function nextEnabledList(enabledIntegrations, changed, selection) {
    const list = enabledIntegrations.filter(id => typeof id === 'string' && id);
    let enabledChanged = false;
    for (const appId of changed) {
        const picked = asSet(selection instanceof Map ? selection.get(appId) : null);
        if (picked === null) continue;
        const on = picked.size > 0;
        const has = list.includes(appId);
        if (on && !has) { list.push(appId); enabledChanged = true; }
        if (!on && has) { list.splice(list.indexOf(appId), 1); enabledChanged = true; }
    }
    return { list, enabledChanged };
}

/**
 * De EERSTE curatie verandert de betekenis van zwijgen — leg vast wat er stond.
 *
 * Een app die de kiezer nooit kon tonen (`requiresGrant`: de browser, de
 * notebooks, de regex-regels) houdt alles zolang niemand de agent cureerde, en
 * krijgt NIETS zodra er één entry staat. Vinkte de eigenaar alleen Gmail
 * smaller, dan schreef de kiezer alleen Gmail weg — en verloor de agent
 * stilzwijgend zijn browser, terwijl het scherm het vinkje aan liet staan en de
 * knop zei dat er niets werd weggenomen.
 *
 * Daarom: gaat de map van niet-gecureerd naar gecureerd, dan krijgt elke
 * `requiresGrant`-app die de kiezer TOONDE en die de eigenaar NIET aanraakte
 * zijn toestand uitgeschreven. Dat neemt niets af en voegt niets toe; het legt
 * vast wat er stond.
 */
function _keepRequiresGrantApps({ before, after, catalog, initial }) {
    if (hasCuratedGrants(before) || !hasCuratedGrants(after)) return after;
    let out = after;
    for (const app of catalog) {
        if (app.requiresGrant !== true) continue;
        if (out && Object.prototype.hasOwnProperty.call(out, app.id)) continue;
        const picked = initial instanceof Map ? initial.get(app.id) : null;
        if (!(picked instanceof Set)) continue;      // onbekende acties: niets te schrijven
        const names = (Array.isArray(app.actions) ? app.actions : [])
            .map(a => a && a.name).filter(n => typeof n === 'string' && n);
        const chosen = names.filter(n => picked.has(n));
        out = setAppActions(out, app.id, chosen.length === names.length && names.length > 0 ? '*' : chosen);
    }
    return out;
}

/**
 * Wat er bij "toepassen" wordt weggeschreven.
 *
 * Levert een NIEUWE config-fragment: de grants-map en (als hij een lijst is) de
 * app-niveau lijst. De aanroeper schrijft ze in één patch weg — één opslag per
 * kiezersessie, niet één per vinkje.
 *
 * @returns {{tools: object, enabledIntegrations: string[]|null, changed: string[],
 *            enabledChanged: boolean}}
 */
export function commitSelection({
    toolsConfig = null,
    enabledIntegrations = null,
    apps = [],
    catalog: fullCatalog = null,
    initial = new Map(),
    selection = new Map(),
} = {}) {
    const changed = changedAppIds(initial, selection);
    const shownList = Array.isArray(apps) ? apps.filter(a => a && isAppKey(a.id)) : [];
    const catalog = (Array.isArray(fullCatalog) && fullCatalog.length
        ? fullCatalog.filter(a => a && isAppKey(a.id))
        : shownList);
    const byId = new Map(shownList.map(a => [a.id, a]));
    const shownApps = changed.map(id => byId.get(id)).filter(Boolean);
    let tools = applyAppSelection(toolsConfig, { shownApps, selection }, { catalog });
    tools = _keepRequiresGrantApps({ before: toolsConfig, after: tools, catalog: shownList, initial });

    if (!Array.isArray(enabledIntegrations)) {
        // Legacy `null`: de app-poort blijft zoals hij was. Zie de kop.
        return { tools, enabledIntegrations, changed, enabledChanged: false };
    }
    const { list, enabledChanged } = nextEnabledList(enabledIntegrations, changed, selection);
    return { tools, enabledIntegrations: enabledChanged ? list : enabledIntegrations, changed, enabledChanged };
}
