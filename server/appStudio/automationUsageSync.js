/**
 * De schrijver van `automation_usage` voor één STUDIO-APP (P4 deel C).
 *
 * De index beantwoordt één vraag: WELKE KNOP DRAAIT DEZE AUTOMATISERING? De
 * automation-editor toont het antwoord als de capsule "Gebruikt door 1 knop", en
 * dat is geen sierstrook: het is het enige scherm waarop iemand die op het
 * punt staat een automatisering te verwijderen, te hernoemen of te deactiveren ziet
 * dat er een app-knop aan hangt.
 *
 * Deze module is de exacte vorm van `core/webpages/webpageUsageSync.js` (W5),
 * met dezelfde drie regels — omdat het dezelfde drie manieren zijn waarop een
 * reconciler op een gedeelde index stil fout gaat.
 *
 * ── DRIE REGELS DIE NIET MOGEN VERSCHUIVEN ──────────────────────────
 *
 * 1. EEN MISLUKTE SCAN WIST NIETS. `reconcileAutomationUsage` is
 *    delete-then-insert op `(consumer_kind, consumer_id)`: wie hem een LEGE
 *    lijst geeft, wist alle rijen van die app. De scan KAN mislukken — de
 *    databaselees valt om, de definitie komt terug als iets dat geen definitie
 *    is — en dan is de eerlijke uitslag "ik weet het niet", niet "deze app
 *    gebruikt niets". Zou dat laatste hier gebeuren, dan leest de capsule na
 *    één storing "wordt nergens gebruikt" en verwijdert iemand een automatisering die
 *    een knop in productie aanzet. Onbekend versmalt: de oude rijen blijven
 *    staan, en dat wordt LUID gezegd (`ok:false` + een regel in het log),
 *    nooit stil. Dit is dezelfde val die W5 bij de 409-poort dichtzette.
 *
 *    Let op waar die val precies zit: `studioAppStore` parseert een definitie
 *    met een `{}`-terugval, dus "onleesbaar" en "leeg" zien er bij de
 *    aanroeper identiek uit. Vandaar de vormcontrole hieronder — een canonieke
 *    definitie heeft ALTIJD een `screens`-array (componentSpecs.emptyDefinition,
 *    en de validator eist het) — en niet een `Object.keys(...).length === 0`,
 *    want een echt lege app is een geldige app.
 *
 * 2. HIJ DRAAIT OP ELKE SAVE, DUS HIJ HANGT ERNAAST. Nooit IN het pad van de
 *    save: `reconcileAppAutomationUsageDetached` wordt niet ge-await en gooit
 *    nooit. Een index is geen bewerking waard. Hij is bovendien GEDEBOUNCET
 *    (dezelfde vorm als W5 en als `datatableStore.notifyDatatableChanged`): de
 *    eerste save zet een timer, elke save daarbinnen valt eronder, en de pass
 *    leest de toestand pas op het moment dat hij vuurt — dus de LAATSTE
 *    toestand, niet de eerste. De editor autosaved per toetsaanslag-groep; dat
 *    kost zo één scan in plaats van tien.
 *
 *    Idempotent is hij per constructie: `ref_id` is `act:<actionId>`, één rij
 *    per (actie, automatisering). Een sequence-stap heeft geen id, dus zijn POSITIE
 *    zou de enige andere sleutel zijn — en een positie schuift bij elke
 *    bewerking op. Zie appStudio/automationRefs.js.
 *
 * 3. EEN VERWIJDERDE APP LAAT NIETS ACHTER. Er is geen FK van deze index naar
 *    `studio_apps` (andere store, eigen boot-DDL), dus niets ruimt de rijen op.
 *    `listUsageOfAutomation` LEFT JOINt, en een achtergebleven rij vertelt een
 *    automation-eigenaar dat een knop die hij niet kan zien zijn automatisering aanzet.
 *    Vandaar `purgeAppAutomationUsage` op het delete-pad — én, als vangnet,
 *    een reconcile die geen app-rij meer vindt en dan zelf opruimt in plaats
 *    van te schrijven. Afzeggen dekt ook de pass die AL LIEP: `_purgeEpoch`
 *    telt per app hoe vaak er is opgeruimd, en een pass die met een ouder
 *    getal terugkomt schrijft niet meer.
 *
 * ── DE EIGENAAR IS DE APP, NOOIT DE SESSIE ──────────────────────────
 *
 * `reconcileAutomationUsage` grendelt zijn INSERT op `automations.user_id =
 * ownerUserId`, en die eigenaar komt hier van de APP-rij (`app.userId`) —
 * nooit van wie de save deed. Dat is niet dezelfde persoon: `CreateAutomationRow`
 * maakt een automatisering onder `req.session.user.id`, en bij een geïnstalleerde of
 * overgedragen Oplossing loopt die uiteen met `app.userId`. Een verwijzing
 * over die grens heen kan sowieso niet draaien — `automationBridge` weigert
 * bij `automation.userId !== app.userId` — dus indexeren zou een koppeling
 * tonen die bij de eerste klik weigert, mét de naam van andermans app erbij.
 *
 * Het gevolg: `entries` niet leeg en `written === 0` betekent "de automatisering
 * bestaat niet meer, of is niet van deze eigenaar" — een reden, geen succes.
 * Zonder die tak heet dat `{ok:true, written:0}` en zegt de capsule stil
 * "wordt nergens gebruikt".
 */

'use strict';
const logger = require('../telemetry/log');

/** De log-prefix, zodat een ops-regel het pad noemt. */
const LABEL = 'AppStudio';

/** Zelfde venster als W5 en als de live-tap op datatableStore. */
const RECONCILE_DEBOUNCE_MS = 5000;

/** Waarom er niets is geschreven — in mensentaal, voor de logregel. */
const REASONS = Object.freeze({
    'no-id': 'no app id',
    'no-app': 'the app no longer exists',
    'no-owner': 'the app row has no owner',
    'unreadable-app': 'the app row could not be read',
    'unreadable-definition': 'the app definition could not be read, so what it runs is unknown',
    'not-indexed': 'the automations it names do not exist, or do not belong to the app owner',
    superseded: 'the app was deleted while this pass was running',
    failed: 'the reconcile itself failed',
});

/**
 * Wat draait deze app NU aan automatiseringen?
 *
 * @returns {Promise<{ok:boolean, reason:string, ownerId?:string|null,
 *                    entries?:Array, unset?:number}>}
 *   `ok:false` betekent ALTIJD "laat de index staan" — nooit "schrijf een lege
 *   lijst". Het onderscheid staat in `reason`.
 */
async function collectAppAutomationUsage(appId, deps = {}) {
    if (!appId) return { ok: false, reason: 'no-id' };
    const studioAppStore = deps.studioAppStore || require('../stores/studioAppStore');
    const refs = deps.automationRefs || require('./automationRefs');

    let app;
    try {
        app = await studioAppStore.getStudioApp(appId);
    } catch (e) {
        // Een LEESFOUT is geen verdwenen app. Zou dit als 'no-app' worden
        // gelezen, dan ruimde een databasehik de index op van een app die
        // gewoon bestaat.
        return { ok: false, reason: 'unreadable-app', error: e.message };
    }
    if (!app) return { ok: false, reason: 'no-app' };
    if (!app.userId) return { ok: false, reason: 'no-owner' };

    // ── BEIDE DEFINITIES, EN DAT IS GEEN DETAIL ─────────────────────────
    //
    // De vraag die deze index beantwoordt is "wie breekt er als ik dit
    // weggooi", en dat gaat over PRODUCTIE. Bezoekers draaien de GEPUBLICEERDE
    // kopie (routes/studioAppsRun.js: `(isOwner && wantDraft) ? app.definition
    // : app.publishedDefinition`), terwijl de auteur de werkende definitie
    // bewerkt. Alleen de draft indexeren gaat op precies één moment fout, en
    // dat is het gevaarlijkste moment dat er is: de eigenaar haalt de knop
    // midden in een herontwerp uit het scherm, publiceert nog niet, de
    // autosave herindexeert — en de capsule zegt vanaf dat moment met volle
    // zekerheid "No app button runs this automation yet" terwijl de LIVE app die
    // knop nog gewoon heeft. Hij gooit de automatisering weg en de live app breekt.
    //
    // Dus de UNIE. Een rij te veel maakt een verwijdering luidruchtiger, een
    // rij te weinig maakt hem stil — dezelfde richting als bij de onbedrade
    // actie hierboven. Dat betekent ook dat een net-bedrade knop die nog niet
    // gepubliceerd is meetelt: dat is een knop die er straks is, en de
    // waarschuwing gaat over weggooien.
    //
    // (`appRefLookup.js` kiest wél de draft, en dat blijft juist: die linkt
    // terug naar de EDITOR, en daar is de draft de waarheid.)
    const sources = [
        { what: 'draft', definition: app.definition, required: true },
        { what: 'published', definition: app.publishedDefinition, required: false },
    ];

    const merged = new Map();   // `${refId}|${automationId}` → entry
    let unset = 0;
    for (const src of sources) {
        // Nooit gepubliceerd: geen kopie, geen probleem. Alleen de WERKENDE
        // definitie moet er zijn.
        if (!src.required && (src.definition === null || src.definition === undefined)) continue;
        // Zie regel 1: de store parseert met een `{}`-terugval, dus alleen de
        // VORM kan onleesbaar van leeg onderscheiden. Een canonieke definitie
        // heeft altijd een screens-array; een lege `actions` is daarentegen
        // volkomen normaal en mag de index wél leegmaken.
        if (!src.definition || typeof src.definition !== 'object' || Array.isArray(src.definition)
            || !Array.isArray(src.definition.screens)) {
            return { ok: false, reason: 'unreadable-definition', ownerId: app.userId, which: src.what };
        }
        const found = refs.collectAutomationRefs(src.definition);
        // `unset` telt alleen de DRAFT: dat is wat de auteur voor zich heeft,
        // en de gepubliceerde kopie zou dezelfde onbedrade acties nog eens
        // meetellen.
        if (src.what === 'draft') unset = found.unset;
        for (const e of found.entries) {
            const key = `${e.refId}|${e.automationId}`;
            // De DRAFT wint bij gelijke sleutel: zijn knoplabel en scherm zijn
            // wat de auteur op zijn scherm ziet staan.
            if (!merged.has(key)) merged.set(key, e);
        }
    }

    return { ok: true, reason: 'collected', ownerId: app.userId, entries: [...merged.values()], unset };
}

/**
 * Zet de index gelijk aan wat deze app nu aan automatiseringen aanzet.
 *
 * Gooit nooit. Het antwoord zegt of er IETS is geschreven en waarom niet:
 * `ok:false` betekent dat de bestaande rijen zijn blijven staan.
 */
async function reconcileAppAutomationUsage(appId, deps = {}) {
    const log = deps.log || console;
    if (!appId) return { ok: false, reason: 'no-id', written: 0 };
    const store = deps.automationUsageStore || require('../stores/automationUsageStore');
    // Zie regel 3: het getal waaraan een pass merkt dat er tijdens zijn lezing
    // is opgeruimd. Vóór de eerste await gelezen, dus elke purge die daarna
    // komt verhoogt hem.
    const epochAtStart = _purgeEpoch.get(appId) || 0;

    // Eén try om ALLES. "Gooit nooit" hierboven is een belofte aan de save die
    // hem aanroept, en die belofte mag niet afhangen van de vraag of elke
    // aangeroepen laag zijn eigen belofte nakomt.
    try {
        const collected = await collectAppAutomationUsage(appId, deps);

        // De app is weg. Dit is het VANGNET achter purgeAppAutomationUsage,
        // niet de hoofdweg: de delete ruimt zelf op. Belandt er toch een
        // reconcile na een verwijdering (een gedebouncete pass die nog liep),
        // dan is opruimen het juiste antwoord — schrijven zou rijen terugzetten
        // voor een app die niemand meer kan openen.
        if (collected.reason === 'no-app') {
            const purged = await store.purgeUsageForConsumer('app', appId);
            return { ok: true, reason: 'no-app', written: 0, purged };
        }

        if (!collected.ok) {
            // Regel 1: zeggen, niet wissen.
            log.warn(`[${LABEL}] ${appId}: automation usage index left as-is — ${REASONS[collected.reason] || collected.reason}`);
            return { ok: false, reason: collected.reason, written: 0 };
        }

        // De app is verwijderd terwijl deze pass las. Doorschrijven zou de
        // rijen terugzetten die de purge net heeft weggehaald — een spookrij
        // die daarna namens een knop spreekt die niemand meer kan indrukken.
        if ((_purgeEpoch.get(appId) || 0) !== epochAtStart) {
            log.warn(`[${LABEL}] ${appId}: automation usage index left as-is — ${REASONS.superseded}`);
            return { ok: false, reason: 'superseded', written: 0 };
        }

        const written = await store.reconcileAutomationUsage('app', appId, collected.ownerId, collected.entries);

        // NUL rijen op een NIET-lege lijst is geen geslaagde reconcile. De
        // INSERT is gegrendeld op `automations.user_id = ownerId`, dus dit is
        // precies de vorm waarin een verwijderde of andermans automatisering zich
        // meldt: de DELETE liep wél, de INSERT niet. Zonder deze tak heet dat
        // `{ok:true, written:0}` en zegt de capsule stil "nergens gebruikt".
        if (written === 0 && collected.entries.length > 0) {
            log.warn(`[${LABEL}] ${appId}: ${collected.entries.length} automation reference(s) but nothing indexed — ${REASONS['not-indexed']}`);
            return {
                ok: false,
                reason: 'not-indexed',
                written: 0,
                entries: collected.entries,
                unset: collected.unset || 0,
            };
        }
        // Een `run_automation` zonder gekozen automatisering is de stand waarin elk
        // sjabloon wordt uitgeleverd. Het blokkeert niets, dus het hoort niet
        // in `ok` — maar zonder deze regel gaf een app met tien onbedrade
        // acties nul signaal, want het detached pad gooit de returnwaarde weg.
        if (collected.unset > 0) {
            log.warn(`[${LABEL}] ${appId}: ${collected.unset} action(s) still have no automation selected — indexed ${written} row(s) from the rest`);
        }
        return {
            ok: true,
            reason: 'reconciled',
            written,
            entries: collected.entries,
            unset: collected.unset || 0,
        };
    } catch (e) {
        log.warn(`[${LABEL}] ${appId}: automation usage index left as-is — ${REASONS.failed} (${e.message})`);
        return { ok: false, reason: 'failed', written: 0 };
    }
}

// ── het pad dat de schrijvers gebruiken ───────────────────────────────
//
// Gedebounced per app, met dezelfde vorm als W5: de EERSTE aanleiding zet de
// timer, elke aanleiding daarbinnen valt eronder, en de timer wordt bij het
// vuren verwijderd — dus een wijziging die daarna binnenkomt zet gewoon een
// nieuwe. De pass leest de toestand pas op het moment dat hij draait, dus hij
// ziet de laatste save, niet de eerste.

const _pending = new Map();

/**
 * Hoe vaak er voor deze app is opgeruimd.
 *
 * `cancelPendingReconcile` wist alleen een timer die nog niet gevuurd heeft —
 * een pass die al aan het LEZEN is, is daarmee niet meer af te zeggen. Dit
 * getal is dat wel: de pass leest het vóór zijn eerste await en weigert te
 * schrijven als het daarna is opgehoogd. De sleutel blijft na de purge in de
 * map staan (een handvol bytes per verwijderde app, en een UUID komt nooit
 * terug), zodat een pass die er ná de purge nog uit komt hem ook echt ziet.
 */
const _purgeEpoch = new Map();

/** Een lopende pass afzeggen (de app wordt verwijderd). */
function cancelPendingReconcile(appId) {
    const timer = _pending.get(appId);
    if (!timer) return false;
    clearTimeout(timer);
    _pending.delete(appId);
    return true;
}

/**
 * "Deze app is opgeslagen." Nooit awaiten, nooit gooien — een save mag hier
 * niet op wachten en er niet aan kapotgaan.
 *
 * @param {string} appId
 * @param {{delayMs?:number}} [deps] verder dezelfde deps als reconcileAppAutomationUsage
 */
function reconcileAppAutomationUsageDetached(appId, deps = {}) {
    if (!appId) return;
    const delayMs = Number.isFinite(deps.delayMs) ? deps.delayMs : RECONCILE_DEBOUNCE_MS;
    if (_pending.has(appId)) return;                  // één pass dekt de reeks
    const timer = setTimeout(() => {
        _pending.delete(appId);
        Promise.resolve()
            .then(() => reconcileAppAutomationUsage(appId, deps))
            .catch(e => logger.warn(`[${LABEL}] automation usage reconcile failed for ${appId}: ${e.message}`));
    }, delayMs);
    // Een wachtende pass mag het proces bij afsluiten niet openhouden.
    timer.unref?.();
    _pending.set(appId, timer);
}

/**
 * De app is verwijderd — haal haar rijen weg.
 *
 * Eerst de wachtende pass afzeggen: die zou de rijen anders opnieuw kunnen
 * schrijven vlak nadat ze zijn opgeruimd. Gooit nooit; een verwijdering mag
 * niet mislukken over een index.
 */
async function purgeAppAutomationUsage(appId, deps = {}) {
    if (!appId) return 0;
    cancelPendingReconcile(appId);
    // Vóór de purge zelf: een pass die NU aan het lezen is moet bij terugkomst
    // al een ander getal zien, ook als de purge hieronder even duurt.
    _purgeEpoch.set(appId, (_purgeEpoch.get(appId) || 0) + 1);
    try {
        const store = deps.automationUsageStore || require('../stores/automationUsageStore');
        return await store.purgeUsageForConsumer('app', appId);
    } catch (e) {
        // De verwijdering zelf is al gebeurd; hier alsnog gooien zou de
        // gebruiker een 500 geven over een app die weg IS. De rijen blijven dan
        // staan — hinderlijk, maar zichtbaar in het log, en de volgende
        // reconcile op dat id ruimt ze via het vangnet alsnog op.
        (deps.log || console).warn(`[${LABEL}] ${appId}: automation usage purge failed — ${e.message}`);
        return 0;
    }
}

/**
 * ── DE BACKFILL: DE INDEX BESTAAT NIET VOOR APPS DIE NIEMAND OPSLAAT ────────
 *
 * De tabel wordt leeg aangelegd en vult zich alleen bij een save, een create
 * of een teruggezette versie. Op de dag van uitrol is zij dus leeg voor élke
 * bestaande app, en dan leest elke automation-eigenaar "No app button runs this
 * automatisering yet" over knoppen die gewoon draaien — een uitspraak over de wereld,
 * gedaan op een tabel die nog nooit is gevuld. En dat blijft zo tot iemand
 * toevallig die app opslaat.
 *
 * Twee dingen samen dichten dat:
 *   1. `automation_usage_indexed` maakt "leeg" en "nog nooit gekeken"
 *      scheidbaar, zodat de capsule kan zwijgen in plaats van te beweren.
 *   2. Deze pass VULT hem, in stukjes. Hij hangt aan de leeskant (de route die
 *      de capsule voedt) in plaats van aan boot: een app die nooit gelezen
 *      wordt hoeft ook niemand een verkeerd antwoord te geven, en boot mag
 *      niet trager worden van een index.
 *
 * Nooit ge-await door de aanroeper, nooit gooiend, en hoogstens één pass
 * tegelijk in dit proces. Elke app gaat door dezelfde reconcile als een save,
 * dus alle drie de regels hierboven gelden ook hier — een app die niet te
 * lezen is wordt overgeslagen en krijgt géén markering, zodat de volgende pass
 * het opnieuw probeert.
 */
const BACKFILL_BATCH = 25;
let _backfillRunning = false;

async function backfillAutomationUsage(deps = {}) {
    if (_backfillRunning) return { ok: true, reason: 'already-running', indexed: 0 };
    _backfillRunning = true;
    const log = deps.log || console;
    const store = deps.automationUsageStore || require('../stores/automationUsageStore');
    const limit = Number.isFinite(deps.limit) ? deps.limit : BACKFILL_BATCH;
    let indexed = 0;
    let failed = 0;
    try {
        const appIds = await store.listUnindexedApps(limit);
        for (const appId of appIds) {
            const out = await reconcileAppAutomationUsage(appId, deps);
            if (out.ok) indexed += 1; else failed += 1;
        }
        if (indexed || failed) {
            log.warn(`[${LABEL}] automation usage backfill: indexed ${indexed} app(s)`
                + (failed ? `, ${failed} left for the next pass` : ''));
        }
        return { ok: true, reason: 'backfilled', indexed, failed };
    } catch (e) {
        log.warn(`[${LABEL}] automation usage backfill failed — ${e.message}`);
        return { ok: false, reason: 'failed', indexed, failed };
    } finally {
        _backfillRunning = false;
    }
}

/** Zelfde pass, maar losgekoppeld: een lees wacht er niet op. */
function backfillAutomationUsageDetached(deps = {}) {
    Promise.resolve()
        .then(() => backfillAutomationUsage(deps))
        .catch(e => logger.warn(`[${LABEL}] automation usage backfill failed: ${e.message}`));
}

module.exports = {
    collectAppAutomationUsage,
    backfillAutomationUsage,
    backfillAutomationUsageDetached,
    BACKFILL_BATCH,
    reconcileAppAutomationUsage,
    reconcileAppAutomationUsageDetached,
    purgeAppAutomationUsage,
    cancelPendingReconcile,
    LABEL,
    RECONCILE_DEBOUNCE_MS,
    REASONS,
};
