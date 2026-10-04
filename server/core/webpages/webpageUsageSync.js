/**
 * De usage-index, geschreven vanuit een WEBPAGINA (`consumer_kind='webpage'`).
 *
 * `automation_datatable_usage` beantwoordt één vraag: WIE raakt deze tabel aan?
 * Voor automatiseringen wordt hij op elke definitie-save geschreven, voor kennisbanken
 * op elke bronwijziging. De waarde `'webpage'` staat sinds W3 in
 * `datatableStore.CONSUMER_KINDS` en werd nog door niemand geschreven — dit
 * bestand is die schrijver.
 *
 * ── WAAROM DIT GEEN COSMETICA IS ────────────────────────────────────
 *
 * Drie oppervlakken lezen die index, en alle drie geloven wat er staat:
 *   - de "Wordt gebruikt door"-lijst van een tabel;
 *   - de poort die een tabel-verwijdering met 409 tegenhoudt;
 *   - de waarschuwing bij het laten vallen van een KOLOM (`columns`).
 * Een pagina die er niet in staat, is een pagina die niemand ziet als hij op
 * het punt staat de tabel eronder weg te halen. Ontbrekende rijen zijn hier dus
 * geen achterstand in een lijstje maar een stille poort.
 *
 * ── DRIE REGELS DIE NIET MOGEN VERSCHUIVEN ──────────────────────────
 *
 * 1. EEN MISLUKTE SCAN WIST NIETS. `reconcileUsageFor` is delete-then-insert
 *    op `(consumer_kind, id)`: wie hem een LEGE lijst geeft, wist alle rijen
 *    van die pagina. De bindingsscan kan mislukken — de objectopslag ligt plat,
 *    een extra bestand is niet op te halen — en `readPageCode` zegt dat met
 *    `readable:false` in plaats van met lege strings. Zou dat hier als "deze
 *    pagina gebruikt niets" worden gelezen, dan wist een storing de index en
 *    staat de 409-poort daarna open zonder dat iemand iets merkt. Onbekend
 *    versmalt: de oude rijen blijven staan, en dat wordt luid gezegd
 *    (`ok:false` + een regel in het log), nooit stil.
 *
 * 2. HIJ DRAAIT OP ELKE SAVE, DUS HIJ HANGT ERNAAST. Nooit in het pad van de
 *    save: `reconcileWebpageUsageDetached` wordt niet ge-await en gooit nooit.
 *    Een index is geen bewerking waard. Hij is bovendien GEDEBOUNCET (dezelfde
 *    vorm als `datatableStore.notifyDatatableChanged`): de eerste save zet een
 *    timer, elke save daarbinnen valt eronder, en de pass leest de toestand pas
 *    op het moment dat hij vuurt — dus de LAATSTE toestand, niet de eerste. Een
 *    autosave-reeks in de Code-tab kost zo één scan in plaats van tien.
 *    Idempotent is hij per constructie: `step_id` is `dt:<datatableId>`, één rij
 *    per gebonden tabel. Een regelnummer als sleutel zou bij elke bewerking een
 *    nieuwe `step_id` schrijven en de index onbeperkt laten groeien.
 *
 * 3. EEN VERWIJDERDE PAGINA LAAT NIETS ACHTER. Er is geen FK van deze index
 *    naar `webpages` (andere store), dus niets ruimt de rijen op. `listUsage`
 *    LEFT JOINt, en een achtergebleven rij vertelt een tabel-eigenaar dat iets
 *    wat hij niet kan zien zijn tabel gebruikt. Vandaar `purgeWebpageUsage` op
 *    het delete-pad — én, als vangnet, een reconcile die geen paginarij meer
 *    vindt en dan zelf opruimt in plaats van te schrijven. Afzeggen dekt ook
 *    de pass die AL LIEP: `_purgeEpoch` telt per pagina hoe vaak er is
 *    opgeruimd, en een pass die met een ouder getal terugkomt schrijft niet
 *    meer. Zonder dat zette een pass die de paginarij nog zag de rijen terug
 *    vlak nadat de verwijdering ze had weggehaald.
 *
 * ── DE SCOPE KOMT VAN DE EIGENAAR, NOOIT UIT `organization_id` ───────
 *
 * `webpages.organization_id` is NULL tot een pagina voor het eerst naar de ORG
 * wordt gepubliceerd (`setWebpagePublished` is de enige schrijver; een kloon
 * zet hem terug op null, een openbaar adres raakt hem niet). Tabellen van een
 * org-lid zijn daarentegen ORG-scoped vanaf hun eerste rij. Wie de scope dus
 * uit die kolom afleidt, biedt de index voor élke niet-gepubliceerde pagina de
 * PERSOONLIJKE scope aan — de INSERT van `reconcileUsageFor` is gegrendeld op
 * `(scope_kind, scope_id)` van de tabel, matcht niet, en schrijft nul rijen op
 * een reconcile die zichzelf geslaagd noemt. Precies dezelfde les als bij de
 * automations (`routes/automation/crud.js`: "A datatable is scoped by
 * organisation and needs it stored, not derived").
 *
 * De bron is daarom de EIGENAAR: `resolveDatatablePrincipalForUser(page.userId)`
 * → `datatableScopesFor`, dezelfde twee scopes die de tabel-routes zelf voor
 * hem oplossen. Het zijn er ook echt twee — een org-lid bereikt zijn
 * organisatie- én zijn persoonlijke tabellen, en een pagina die er van allebei
 * één bindt hoort er allebei één te indexeren. `reconcileUsageFor` neemt die
 * lijst en leest per rij de scope van de TABEL, zodat één transactie beide
 * dekt.
 *
 * ── WAT ER IN DE INDEX KOMT: DE VERENIGING VAN TWEE BRONNEN ─────────
 *
 * Een pagina bereikt een tabel op twee manieren, en de index moet ze allebei
 * kennen:
 *
 *   de BINDING   `bridge_grants.tables` — de poort. Alleen hierdoor mag
 *                `window.beeflowTables` de tabel lezen of schrijven, en juist
 *                die weg is voor een scan onzichtbaar: een pagina die haar
 *                rijen met `beeflowTables.query('tbl_x')` uit eigen JS haalt,
 *                heeft geen enkel `bf-*`-element. Zonder deze bron zou dat de
 *                zwaarste gebruiker zijn die nergens staat.
 *   het ELEMENT  `<bf-table source="…">` / `<bf-stat source="…">`, gevonden
 *                door `webpageBindings.collectUses`. Dit is wat de auteur
 *                OPSCHREEF, ook als de binding er (nog) niet is.
 *
 * De poort is de bovengrens: wat niet gebonden is, kan de pagina op geen enkele
 * manier lezen. De vereniging is dus altijd ruimer dan wat er echt bereikbaar
 * is, en dat is de goede kant om te missen — een rij te veel maakt een
 * verwijdering luidruchtiger, een rij te weinig maakt hem stil.
 *
 * Daarom mag `unresolved` uit de scan hier ook niet blokkeren: een
 * `<bf-table source={id}>` waarvan het adres ter plekke wordt gebouwd, kan de
 * scan niet aanwijzen — maar aan de andere kant moet die tabel gebonden zijn om
 * te werken, en dán staat hij al in de binding.
 *
 * `mode` en `columns` komen uit de BINDING, want alleen die weet ze: een
 * element noemt geen kolommen, en of de pagina mag schrijven staat in de grant.
 * Zonder binding is het antwoord `read` en geen enkele kolom — de smalle kant.
 *
 * ── DE DERDE STAND: ONLEESBARE GRANTS ───────────────────────────────
 *
 * De grants worden uit dezelfde paginarij gelezen als de scope; valt die lezing
 * om, dan is er geen halve reconcile mogelijk. Rijen schrijven met een LEGE
 * kolomlijst zou de kolom-drop-waarschuwing voor deze pagina uitzetten, en dat
 * is precies dezelfde stille poort als regel 1. Beide bronnen leesbaar, of
 * niets schrijven.
 */

'use strict';
const logger = require('../../telemetry/log');

/** De log-prefix, zodat een ops-regel het pad noemt. */
const LABEL = 'Webpages';

/**
 * De sleutel van één rij binnen deze pagina: één rij per TABEL, niet per
 * element. Zie regel 2 — stabiel over saves heen is de hele eis.
 */
const STEP_PREFIX = 'dt:';

/** Zelfde venster als de live-tap op datatableStore, om dezelfde reden. */
const RECONCILE_DEBOUNCE_MS = 5000;

/** Waarom er niets is geschreven — in mensentaal, voor de logregel. */
const REASONS = Object.freeze({
    'no-id': 'no webpage id',
    'no-page': 'the page no longer exists',
    'no-scope': 'the page has neither an organisation nor an owner',
    'unreadable-code': 'the page files could not be read, so what it binds is unknown',
    'unreadable-page': 'the page row could not be read',
    'not-indexed': 'the tables it binds are in neither scope the owner can reach',
    superseded: 'the page was deleted while this pass was running',
    failed: 'the reconcile itself failed',
});

/**
 * De scopes waarvan deze pagina tabellen mag noemen — org eerst, dan
 * persoonlijk.
 *
 * Zie de kop: dit gaat langs de EIGENAAR en niet langs `page.organizationId`.
 * Valt die opzoeking om (`identityError`, of hij gooit), dan is de organisatie
 * onbekend en zou alleen de persoonlijke scope aanbieden een org-pagina stil op
 * nul rijen zetten. Onbekend versmalt hier naar NIETS DOEN: een lege lijst
 * terug, wat de aanroeper als `no-scope` leest en dus als "laat de index
 * staan". De kolom op de paginarij is daarbij het laatste vangnet — hij is
 * onvolledig (NULL tot publicatie) maar nooit verkeerd.
 *
 * `webpages.user_id` is NOT NULL, dus een pagina zonder eigenaar bestaat alleen
 * als de rij onder ons vandaan is gehaald — en dan is een lege lijst het
 * eerlijke antwoord.
 */
async function scopesForPage(page, deps = {}) {
    if (!page || !page.userId) return [];
    const datatableStore = deps.datatableStore || require('../../stores/datatableStore');
    const access = deps.datatableAccess || require('../../auth/datatableAccess');
    try {
        const principal = await access.resolveDatatablePrincipalForUser(page.userId);
        if (principal && principal.identityError) {
            // "Ik kon de organisatie niet lezen" is iets anders dan "hij heeft
            // er geen". De kolom weet het soms wél; is ook die leeg, dan is er
            // geen scope waar we voor kunnen instaan.
            return page.organizationId
                ? [datatableStore.orgScope(page.organizationId), datatableStore.userScope(page.userId)]
                : [];
        }
        const scopes = access.datatableScopesFor(principal) || [];
        if (scopes.length) return scopes;
    } catch (_) {
        // Zelfde tak als identityError: geen gok op één scope.
        return page.organizationId
            ? [datatableStore.orgScope(page.organizationId), datatableStore.userScope(page.userId)]
            : [];
    }
    return [];
}

/**
 * Wat bindt deze pagina NU aan tabellen?
 *
 * @returns {Promise<{ok:boolean, reason:string, scopes?:Array, entries?:Array,
 *                    ownerId?:string|null, unresolved?:number}>}
 *   `ok:false` betekent ALTIJD "laat de index staan" — nooit "schrijf een lege
 *   lijst". Het onderscheid staat in `reason`.
 */
async function collectWebpageUsage(webpageId, deps = {}) {
    if (!webpageId) return { ok: false, reason: 'no-id' };
    const webpageStore = deps.webpageStore || require('../../stores/webpageStore');
    const datatableStore = deps.datatableStore || require('../../stores/datatableStore');
    const bindings = deps.webpageBindings || require('./webpageBindings');

    let page;
    try {
        page = await webpageStore.getWebpageRaw(webpageId);
    } catch (e) {
        // Een LEESFOUT is geen verdwenen pagina. Zou dit als 'no-page' worden
        // gelezen, dan ruimde een databasehik de index op van een pagina die
        // gewoon bestaat.
        return { ok: false, reason: 'unreadable-page', error: e.message };
    }
    if (!page) return { ok: false, reason: 'no-page' };

    const scopes = await scopesForPage(page, { datatableStore, datatableAccess: deps.datatableAccess });
    if (!scopes.length) return { ok: false, reason: 'no-scope', ownerId: page.userId || null };

    // De EIGENAAR leest, niet de aanroeper: de opslagsleutel van elk slot hangt
    // aan het account van de eigenaar. Een kloon wordt zo onder zijn NIEUWE
    // eigenaar gescand, en een save door een beheerder leest niet per ongeluk
    // een lege pagina.
    const ownerId = page.userId || null;
    let code;
    try {
        code = await bindings.readPageCode(ownerId, webpageId);
    } catch (e) {
        return { ok: false, reason: 'unreadable-code', ownerId, error: e.message };
    }
    if (!code || code.readable !== true) return { ok: false, reason: 'unreadable-code', ownerId };

    // `fallbackIds` blijft leeg: geen enkel tabel-element kent een terugval
    // (alleen `<bf-agent>` doet dat, en dat is een andere familie). Een terugval
    // die er ooit bijkomt levert hier `unknown-fallback` op — het element valt
    // dan in `unresolved` in plaats van met een geraden id in de index te
    // belanden, en de binding hieronder dekt het alsnog.
    const uses = bindings.collectUses(bindings.scanBfElements(code), { fallbackIds: {} });
    const fromCode = (uses && uses.targets && Array.isArray(uses.targets.datatable))
        ? uses.targets.datatable : [];

    // De binding is de POORT en dus de bovengrens; zie de kop.
    const grants = typeof webpageStore.normalizeBridgeGrants === 'function'
        ? webpageStore.normalizeBridgeGrants(page.bridgeGrants)
        : (page.bridgeGrants || {});
    const boundById = new Map();
    for (const t of (Array.isArray(grants.tables) ? grants.tables : [])) {
        if (t && typeof t.datatableId === 'string' && t.datatableId) boundById.set(t.datatableId, t);
    }

    const ids = new Set(boundById.keys());
    for (const target of fromCode) {
        if (target && typeof target.id === 'string' && target.id) ids.add(target.id);
    }

    const entries = [...ids].map((datatableId) => {
        const bound = boundById.get(datatableId) || null;
        return {
            datatableId,
            stepId: `${STEP_PREFIX}${datatableId}`,
            // Alleen een expliciete schrijf-grant maakt hier 'readwrite'; al het
            // andere — geen binding, een onbekende waarde — is 'read'.
            mode: bound && bound.mode === 'readwrite' ? 'readwrite' : 'read',
            // Wat de pagina van deze tabel MAG lezen. Dit is wat de
            // kolom-drop-waarschuwing leest, dus een lege lijst betekent hier
            // "geen kolom genoemd" en nooit "alle kolommen".
            columns: bound && Array.isArray(bound.columns) ? [...bound.columns] : [],
        };
    });

    return {
        ok: true,
        reason: 'collected',
        scopes,
        ownerId,
        entries,
        // Elementen die wél iets binden maar niet aan te wijzen zijn. Ze
        // blokkeren niets (zie de kop) maar horen wel in de logregel thuis.
        unresolved: (uses && Array.isArray(uses.unresolved))
            ? uses.unresolved.filter(u => u && u.kind === 'datatable').length
            : 0,
    };
}

/**
 * Zet de index gelijk aan wat deze pagina nu bindt.
 *
 * Gooit nooit. Het antwoord zegt of er IETS is geschreven en waarom niet:
 * `ok:false` betekent dat de bestaande rijen zijn blijven staan.
 */
async function reconcileWebpageUsage(webpageId, deps = {}) {
    const log = deps.log || console;
    if (!webpageId) return { ok: false, reason: 'no-id', written: 0 };
    const usageSync = deps.usageSync || require('../../automation/datatableUsageSync');
    // Zie regel 3 in de kop: het getal waaraan een pass merkt dat er tijdens
    // zijn lezing is opgeruimd. Vóór de eerste await gelezen, dus elke purge
    // die daarna komt verhoogt hem.
    const epochAtStart = _purgeEpoch.get(webpageId) || 0;

    // Eén try om ALLES. "Gooit nooit" hierboven is een belofte aan de save die
    // hem aanroept, en die belofte mag niet afhangen van de vraag of elke
    // aangeroepen laag zijn eigen belofte nakomt.
    try {
        const collected = await collectWebpageUsage(webpageId, deps);

        // De pagina is weg. Dit is het VANGNET achter purgeWebpageUsage, niet
        // de hoofdweg: de delete-route ruimt zelf op. Belandt er toch een
        // reconcile na een verwijdering (een gedebouncete pass die nog liep),
        // dan is opruimen het juiste antwoord — schrijven zou rijen terugzetten
        // voor een pagina die niemand meer kan openen.
        if (collected.reason === 'no-page') {
            const purged = await usageSync.purgeUsageFor('webpage', webpageId, { label: LABEL });
            return { ok: true, reason: 'no-page', written: 0, purged };
        }

        if (!collected.ok) {
            // Regel 1: zeggen, niet wissen.
            log.warn(`[${LABEL}] ${webpageId}: usage index left as-is — ${REASONS[collected.reason] || collected.reason}`);
            return { ok: false, reason: collected.reason, written: 0 };
        }

        // De pagina is verwijderd terwijl deze pass las. Doorschrijven zou de
        // rijen terugzetten die de purge net heeft weggehaald — een spookrij
        // die daarna een tabel-verwijdering met 409 tegenhoudt namens een
        // pagina die niemand meer kan openen.
        if ((_purgeEpoch.get(webpageId) || 0) !== epochAtStart) {
            log.warn(`[${LABEL}] ${webpageId}: usage index left as-is — ${REASONS.superseded}`);
            return { ok: false, reason: 'superseded', written: 0 };
        }

        const written = await usageSync.syncUsageFor(
            'webpage', webpageId, collected.scopes, collected.entries, { label: LABEL },
        );
        if (written < 0) {
            // syncUsageFor logt de fout zelf; de reconcile draait in een
            // transactie, dus de rijen staan er nog zoals ze stonden.
            return { ok: false, reason: 'failed', written: 0 };
        }
        // NUL rijen op een NIET-lege lijst is geen geslaagde reconcile. De
        // INSERT is gegrendeld op de scope van de tabel, dus dit is precies de
        // vorm waarin een verkeerde scope zich meldt: de DELETE liep wél, de
        // INSERT niet, en zonder deze tak heet dat `{ok:true, written:0}` en
        // gaat de 409-poort op elke genoemde tabel stil open. syncUsageFor logt
        // hier zelf al een regel; wat hier telt is dat de UITSLAG het zegt.
        if (written === 0 && collected.entries.length > 0) {
            log.warn(`[${LABEL}] ${webpageId}: ${collected.entries.length} table binding(s) but nothing indexed — ${REASONS['not-indexed']}`);
            return {
                ok: false,
                reason: 'not-indexed',
                written: 0,
                entries: collected.entries,
                unresolved: collected.unresolved || 0,
            };
        }
        // De kop belooft dat een adres dat de scan niet kan aanwijzen wordt
        // GEMELD. Het blokkeert niets, dus het hoort niet in `ok` — maar zonder
        // deze regel gaf een pagina met tien `<bf-table source={id}>` nul
        // signaal, want het detached pad gooit de returnwaarde weg.
        if (collected.unresolved > 0) {
            log.warn(`[${LABEL}] ${webpageId}: ${collected.unresolved} table reference(s) the scan could not resolve — indexed ${written} row(s) from the bindings instead`);
        }
        return {
            ok: true,
            reason: 'reconciled',
            written,
            entries: collected.entries,
            unresolved: collected.unresolved || 0,
        };
    } catch (e) {
        log.warn(`[${LABEL}] ${webpageId}: usage index left as-is — ${REASONS.failed} (${e.message})`);
        return { ok: false, reason: 'failed', written: 0 };
    }
}

// ── het pad dat de routes gebruiken ───────────────────────────────────
//
// Gedebounced per pagina, met dezelfde vorm als
// `datatableStore.notifyDatatableChanged`: de EERSTE aanleiding zet de timer,
// elke aanleiding daarbinnen valt eronder, en de timer wordt bij het vuren
// verwijderd — dus een wijziging die daarna binnenkomt zet gewoon een nieuwe.
// De pass leest de toestand pas op het moment dat hij draait, dus hij ziet de
// laatste save, niet de eerste.

const _pending = new Map();

/**
 * Hoe vaak er voor deze pagina is opgeruimd.
 *
 * `cancelPendingReconcile` wist alleen een timer die nog niet gevuurd heeft —
 * een pass die al aan het LEZEN is, is daarmee niet meer af te zeggen. Dit
 * getal is dat wel: de pass leest het vóór zijn eerste await en weigert te
 * schrijven als het daarna is opgehoogd. De sleutel blijft na de purge in de
 * map staan (een handvol bytes per verwijderde pagina, en een id komt nooit
 * terug), zodat een pass die er ná de purge nog uit komt hem ook echt ziet.
 */
const _purgeEpoch = new Map();

/** Een lopende pass afzeggen (de pagina wordt verwijderd). */
function cancelPendingReconcile(webpageId) {
    const timer = _pending.get(webpageId);
    if (!timer) return false;
    clearTimeout(timer);
    _pending.delete(webpageId);
    return true;
}

/**
 * "Deze pagina is opgeslagen." Nooit awaiten, nooit gooien — een save mag hier
 * niet op wachten en er niet aan kapotgaan.
 *
 * @param {string} webpageId
 * @param {{delayMs?:number}} [deps] verder dezelfde deps als reconcileWebpageUsage
 */
function reconcileWebpageUsageDetached(webpageId, deps = {}) {
    if (!webpageId) return;
    const delayMs = Number.isFinite(deps.delayMs) ? deps.delayMs : RECONCILE_DEBOUNCE_MS;
    if (_pending.has(webpageId)) return;              // één pass dekt de reeks
    const timer = setTimeout(() => {
        _pending.delete(webpageId);
        Promise.resolve()
            .then(() => reconcileWebpageUsage(webpageId, deps))
            .catch(e => logger.warn(`[${LABEL}] usage reconcile failed for ${webpageId}: ${e.message}`));
    }, delayMs);
    // Een wachtende pass mag het proces bij afsluiten niet openhouden.
    timer.unref?.();
    _pending.set(webpageId, timer);
}

/**
 * De pagina is verwijderd — haal haar rijen weg.
 *
 * Eerst de wachtende pass afzeggen: die zou de rijen anders opnieuw kunnen
 * schrijven vlak nadat ze zijn opgeruimd. Gooit nooit; een verwijdering mag
 * niet mislukken over een index.
 */
async function purgeWebpageUsage(webpageId, deps = {}) {
    if (!webpageId) return 0;
    cancelPendingReconcile(webpageId);
    // Vóór de purge zelf: een pass die NU aan het lezen is moet bij terugkomst
    // al een ander getal zien, ook als de purge hieronder even duurt.
    _purgeEpoch.set(webpageId, (_purgeEpoch.get(webpageId) || 0) + 1);
    try {
        const usageSync = deps.usageSync || require('../../automation/datatableUsageSync');
        return await usageSync.purgeUsageFor('webpage', webpageId, { label: LABEL });
    } catch (e) {
        // De verwijdering zelf is al gebeurd; hier alsnog gooien zou de
        // gebruiker een 500 geven over een pagina die weg IS. De rijen blijven
        // dan staan — hinderlijk, maar zichtbaar in het log, en de volgende
        // reconcile op dat id ruimt ze via het vangnet alsnog op.
        (deps.log || console).warn(`[${LABEL}] ${webpageId}: usage purge failed — ${e.message}`);
        return 0;
    }
}

module.exports = {
    collectWebpageUsage,
    reconcileWebpageUsage,
    reconcileWebpageUsageDetached,
    purgeWebpageUsage,
    cancelPendingReconcile,
    scopesForPage,
    STEP_PREFIX,
    RECONCILE_DEBOUNCE_MS,
    REASONS,
};
