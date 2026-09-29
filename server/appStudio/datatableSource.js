/**
 * App Studio — de TWEEDE tabelsoort: een modeltabel wier rijen in een
 * STUDIO-DATATABEL staan (`model.tables[].source = {kind:'datatable', …}`).
 *
 * ── WAAROM DIT EEN EIGEN BESLISSING IS ──────────────────────────────
 * Een gewone app-tabel staat in de database VAN DE APP. Die database is van de
 * eigenaar, en wie er iets uit mag zien bepaalt de app helemaal zelf
 * (rlsGateway + het `access`-blok van de tabel). Een Studio-datatabel is van
 * niemand in het bijzonder: hij staat in de organisatie, wordt gedeeld met
 * routines en met andere apps, en draagt zijn eigen rechtenladder
 * (auth/datatableAccess — viewer < editor < owner).
 *
 * Een app die zo'n tabel leest is dus een TWEEDE DEUR naar gegevens die al een
 * slot hebben. De app mag dat slot niet vervangen; hij mag er alleen nog een
 * bij zetten. Alles hieronder volgt daaruit.
 *
 * ── REGEL 1: DE GRAAD IS DIE VAN DE KIJKER, NOOIT DIE VAN DE AUTEUR ─
 * `gradeForPrincipal` wordt gesteld voor de PRINCIPAAL VAN DE KIJKER: zijn
 * organisatie, zijn groepen, zijn orgRole, vers uit de database. De app-eigenaar
 * is niet de vrager. Zou de graad voor de eigenaar worden bepaald, dan zou elke
 * gedeelde app een uitgiftepunt zijn voor de rechten van zijn maker: één scherm
 * met een tabelbinding en iedereen die de app mag openen leest de HR-tabel van
 * de eigenaar.
 *
 * ── REGEL 2: EFFECTIEF = MINIMUM, NOOIT DE UNIE ─────────────────────
 * Er zijn drie antwoorden op "wat mag deze lezing":
 *   a) de graad van de KIJKER op de datatabel
 *   b) de graad van de APP-EIGENAAR op diezelfde datatabel
 *   c) wat de APP-ROL van de kijker op deze modeltabel mag (het `access`-blok)
 * De effectieve graad is het MINIMUM van die drie.
 *
 * a) en b) gaan door `auth/datatableAccess.effectiveGradeForRun` — de regel die
 * daar al vooruit geschreven stond, letterlijk (datatableAccess.js:311-317):
 *
 *     const a = gradeForPrincipal(table, grants, principal);
 *     if (!onBehalfOfPrincipal || onBehalfOfPrincipal.userId === principal.userId) return a;
 *     const b = gradeForPrincipal(table, grants, onBehalfOfPrincipal);
 *     if (!a || !b) return null;
 *     return rank(a) <= rank(b) ? a : b;
 *
 * WAAROM EEN UNIE HIER EEN LEK ZOU ZIJN. Een unie telt twee graden bij elkaar
 * op: mag de kijker lezen en mag de eigenaar schrijven, dan levert de unie
 * schrijfrecht op dat GEEN VAN BEIDEN alleen had. Toegepast op deze deur is dat
 * niet theoretisch — het is precies de aanval: de kijker heeft niets op de
 * datatabel, de eigenaar heeft alles, en de unie maakt van "ik mag deze app
 * openen" hetzelfde als "ik ben de eigenaar". De MIN doet het omgekeerde: een
 * app kan nooit méér uitdelen dan zijn kijker zelf al had, en nooit méér dan
 * zijn maker zelf had. `if (!a || !b) return null` maakt daarbij van ONBEKEND
 * een weigering in plaats van de laagste graad — "geen graad" en "de laagste
 * graad" blijven verschillende waarden.
 *
 * c) is de derde MIN en staat hieronder in `appRoleGrade`.
 *
 * ── REGEL 3: `mode:'read'` CAPT OP viewer ───────────────────────────
 * Een koppeling die 'read' zegt, mag ook via de graad geen schrijfrecht laten
 * ontstaan. De cap is niet symbolisch: `owner` kortsluit in
 * core/dataEngine/accessFilter.resolveScope naar 'all' en slaat elke rijfilter
 * over, dus zonder cap zou een `row_scope:'own'`-tabel via een read-koppeling
 * álle rijen tonen aan wie toevallig owner-graad heeft. Met de cap ziet
 * iedereen door deze deur wat een viewer ziet.
 *
 * ── WAT EEN LEZER PER ROUTE KRIJGT ──────────────────────────────────
 * routes/studioAppData.js (ingelogd, `ctx.viewerId` = de sessiegebruiker):
 *   de kijker krijgt zijn EIGEN graad op de datatabel, verlaagd tot die van de
 *   app-eigenaar en tot wat zijn app-rol op deze tabel mag. Geen graad op de
 *   datatabel (andere organisatie, geen grant, niet in het publicatiepubliek,
 *   of een persoonlijke tabel van iemand anders) = 403, geen lege lijst.
 *
 * routes/studioAppPublic.js (publiek, `ctx.role` = de gereserveerde rol
 * `public` en `ctx.viewerId` = een anoniem, serverbedacht bezoekers-id):
 *   ALTIJD een weigering. Een anonieme bezoeker is geen principaal — hij heeft
 *   geen organisatie, geen groepen en geen orgRole — en de enige graad die er
 *   dan nog te lenen valt is die van de auteur. Dat is precies wat niet mag,
 *   dus dit pad eindigt hier met 403 en een reden. Een openbaar formulier dat
 *   organisatiegegevens moet tonen, doet dat via een tabel van de app zelf.
 *
 * ── ONBEKEND VERSMALT, MAAR ZEGT WAAROM ─────────────────────────────
 * Geen enkele tak hieronder valt terug op 'viewer' en geen enkele geeft een
 * lege lijst. Kan de graad niet worden bepaald — de identiteit is niet te lezen,
 * de tabel is weg, de koppeling deugt niet — dan is dat een weigering die
 * vertelt wát er niet kon. Een lege lijst zou hetzelfde scherm opleveren als
 * "er zijn geen rijen", en dat verschil is het enige waar iemand op kan
 * handelen. Zie ook readError.js: een weigering is nooit een 404, want de
 * runtime-client degradeert die naar "leeg".
 *
 * ── LEZEN ÉN SCHRIJVEN, ÉÉN BESLISSING ──────────────────────────────
 * `resolveDatatableRead` (dataReadRunner) en `resolveDatatableWrite`
 * (actionExecutor/records.js) zijn twee ingangen op ÉÉN body. Er stond hier
 * even een tweede module voor het schrijfpad (`datatableBinding.js`, met
 * MIN(app-eigenaar, app-rol, mode) en zónder de eigen graad van de kijker); die
 * is weggehaald zodra bleek dat het twee antwoorden op dezelfde vraag waren.
 * De ruimere van de twee is niet gekozen: een app die schrijft namens iemand
 * die zelf niets op de tabel mag, is precies de deur die regel 1 dichthoudt.
 *
 * Wat een SCHRIJVING er bovenop krijgt, en verder niets:
 *   • `mode:'read'` is een WEIGERING met een reden, niet een cap die verderop
 *     toevallig ook 403 oplevert. Een koppeling die als lezen is opgeslagen en
 *     toch een schrijfstap krijgt, moet dat zeggen — een stille no-op ziet er
 *     voor de gebruiker uit als een gelukte actie en de rij die nooit verscheen
 *     wordt pas dagen later gemist.
 *   • de graad moet minstens `editor` zijn (`gradeAtLeast`) — de GROVE
 *     controle die core/dataEngine/accessFilter.js in zijn moduledoc noemt: het
 *     gecompileerde predicaat is géén schrijfrechtcheck en mag er nooit voor
 *     doorgaan.
 *   • beide `access`-blokken worden PER ACTIE bevraagd. `appRoleGrade`
 *     hieronder vouwt create/update/delete tot één bovengrens; een rol die wel
 *     mag toevoegen maar niet verwijderen zou daarmee alsnog mogen verwijderen.
 *     `assertCanWrite` op de MODELtabel (de app-rol) en op de DATATABEL (de
 *     graad) stelt de vraag alsnog voor precies deze actie.
 */

'use strict';

// Pure modules: de vocabulaire en de compiler-helft van de access-laag.
const {
    PUBLIC_ROLE_KEY,
    // De bron-grammatica komt UIT het vocabulaire, nooit uit een kopie hier.
    // Er stond een tweede lijst ('datatable', 'read'|'readwrite') letterlijk in
    // de shapeOk hieronder; die liep bij een derde kind of een derde mode stil
    // uit de pas met validate/refs.js en dataModel/modelValidate.js, die hem
    // dan wél zouden accepteren. De richting van die drift is veilig (deze
    // module weigert), maar hij komt pas boven als een gebruiker de app opent.
    TABLE_SOURCE_KINDS,
    TABLE_SOURCE_MODES,
    WRITABLE_TABLE_SOURCE_MODE,
} = require('../core/dataEngine/dataModel/vocabulary');
const { resolveScope, assertCanWrite } = require('../core/dataEngine/accessFilter');
// De rechtenladder zelf. Bewust NIET injecteerbaar: dit is de beslissing, niet
// een afhankelijkheid ervan.
const {
    GRADES,
    narrowGrade,
    gradeAtLeast,
    gradeForPrincipal,
    effectiveGradeForRun,
    synthesizeAccess,
    datatableScopesFor,
    resolveDatatablePrincipalForUser,
} = require('../auth/datatableAccess');
const { ANON_VIEWER_PREFIX } = require('./publicAccess');
const { readError } = require('./readError');

/**
 * De bron van een modeltabel, of null als de app haar rijen zelf bezit.
 *
 * `null` en `undefined` betekenen allebei "eigen opslag" — de soort die er
 * altijd al was. Alles wat er wél staat wordt beoordeeld, ook als het geen
 * object is: stil als "eigen opslag" lezen zou een kapotte koppeling laten
 * uitkomen op de database van de app, waar die tabel niet bestaat.
 */
function tableSource(table) {
    const s = table ? table.source : null;
    return (s === undefined || s === null) ? null : s;
}

/** Haalt deze modeltabel haar rijen uit een Studio-datatabel? */
function isDatatableBacked(table) {
    return tableSource(table) !== null;
}

/**
 * Het MINIMUM van twee graden — of null zodra er één onbekend is.
 *
 * De rekenkunde zelf is `auth/datatableAccess.narrowGrade`: één implementatie
 * van "versmallen, nooit optellen", gedeeld met effectiveGradeForRun. Wat hier
 * omheen staat is de VOCABULAIRECHECK. narrowGrade weert een falsy waarde
 * (`!a || !b → null`), maar een waarheidsachtige niet-graad ('admin', een
 * rolnaam uit de app) krijgt `rank() === -1` en wint dan als kleinste — dan komt
 * er een string uit die geen graad is. Downstream valt dat dicht
 * (`resolveScope` kent alleen viewer/editor en geeft 'none'), maar een graad die
 * geen graad is hoort de deur niet te halen: hier is dat een weigering.
 */
function minGrade(a, b) {
    if (!GRADES.includes(a) || !GRADES.includes(b)) return null;
    return narrowGrade(a, b);
}

/**
 * De graad die de APP-ROL van de kijker hoogstens toestaat — de derde MIN.
 *
 * De app-rol zegt wat iemand in DEZE app met DEZE tabel mag; dat staat in het
 * `access`-blok van de modeltabel en is de mapping die de auteur zelf heeft
 * ingesteld. Mag die rol de tabel wijzigen, dan is 'editor' de bovengrens;
 * anders 'viewer'. De app-eigenaar zelf (rol 'owner') wordt hier niet verlaagd —
 * zijn eigen graad op de datatabel is dan de enige begrenzing die telt.
 *
 * Of de rol de tabel überhaupt mag LEZEN is hier al beantwoord: dataReadRunner
 * .requireReadableTable heeft `rlsGateway.canRead(table, role)` gedraaid en
 * anders 403 gegeven. Deze functie gaat alleen over de bovengrens.
 *
 * Geen rol = geen graad. Dat is de kijker die nergens in de rolmapping valt;
 * hij komt langs deze functie niet verder, ook niet met een grant op de
 * datatabel — de app is dan niet de deur waardoor hij binnenkomt.
 */
function appRoleGrade(table, role) {
    if (typeof role !== 'string' || !role) return null;
    if (role === 'owner') return 'owner';
    const mayWrite = resolveScope(table, role, 'update') !== 'none'
        || resolveScope(table, role, 'delete') !== 'none'
        || resolveScope(table, role, 'create') === true;
    return mayWrite ? 'editor' : 'viewer';
}

/**
 * De rijregel die de auteur aan DEZE app-rol hing voor DEZE modeltabel.
 *
 * Alleen een niet-lege string of een AST; alles anders is geen regel. Wordt
 * niet hier gevalideerd: `PUT /api/studio-apps/:id/schema` toetst elke
 * rowFilter met `rlsGateway.validateRowFilter` vóór het opslaan, en een regel
 * die daar toch langs kwam laat `rowFilterToSql` in het leespad falen — een
 * weigering, nooit een ruimere lezing.
 */
function rowFilterForRole(table, role) {
    if (typeof role !== 'string' || !role || role === 'owner') return null;
    const rules = table && table.access && table.access.rowFilters;
    if (!rules || typeof rules !== 'object') return null;
    const rule = rules[role];
    if (typeof rule === 'string') return rule.trim() ? rule : null;
    // Een AST is een object — een LIJST niet. `[]` is waar en van het type
    // 'object', en zou er zonder deze regel als "regel" doorheen glippen.
    return (rule && typeof rule === 'object' && !Array.isArray(rule)) ? rule : null;
}

/**
 * De principaal van één gebruiker, vers uit de database — of een weigering.
 *
 * `resolveDatatablePrincipalForUser` slikt zelf een mislukte gebruikerslezing
 * (`try { … } catch (_) { }`) en levert dan een principaal zonder organisatie,
 * zonder orgRole en zonder groepen op. Die degradeert naar "geen graad", en dat
 * is als ANTWOORD prima (onbekend versmalt) maar als BOODSCHAP fout: het zou de
 * kijker vertellen dat hij geen toegang heeft terwijl in werkelijkheid niemand
 * het kon nagaan. Vandaar dat een uitval hier een eigen weigering krijgt, met
 * dezelfde redenering als `datatable_identity_unavailable` in
 * core/automationRunner/datatableResolve.js.
 *
 * DRIE MANIEREN WAAROP DIT MISGAAT, en alle drie komen ze hier uit als 503.
 * De resolver kan stuklopen; hij kan niets teruggeven; en — het geval dat lang
 * onzichtbaar was — hij kan de gebruikerslezing intern hebben opgegeten en een
 * principaal MÉT userId maar ZONDER org, orgRole en groepen teruggeven. Dat
 * laatste degradeert verderop naar "geen graad" en zou er als 403 uitkomen
 * terwijl het een 503 was. Sinds `resolveDatatablePrincipal` zijn mislukte
 * lezingen MELDT (`principal.identityError`, additief, naar het voorbeeld van
 * `ctx.identityError` in core/automationRunner/datatableResolve.js) is ook die
 * tak te zien, en wordt hij hier geweigerd in plaats van stilzwijgend als een
 * te lage graad afgehandeld.
 */
async function principalFor(userId, resolve, unavailable) {
    let principal = null;
    try {
        principal = await resolve(userId);
    } catch (_) {
        // De oorzaak blijft binnen: `safe`-boodschappen gaan letterlijk naar de
        // client, en een databasefout is niets voor die kant van de lijn.
        principal = null;
    }
    if (!principal || !principal.userId || principal.identityError) {
        throw readError(503, unavailable);
    }
    return principal;
}

/** De acties die op een gekoppelde tabel bestaan. `read` is de vierde. */
const WRITE_ACTIONS = Object.freeze(['create', 'update', 'delete']);

/**
 * Alles wat één LEZING of één SCHRIJVING van een datatabel-gekoppelde modeltabel
 * nodig heeft. Eén body, twee ingangen — zie de kop van dit bestand.
 *
 * @param {object} ctx   de context ({app, viewerId, role, viewer, …}) — het
 *   leespad geeft die van dataReadRunner, het schrijfpad bouwt dezelfde vorm
 * @param {object} table de MODELtabel (met `source`), niet de datatabel
 * @param {object} [deps] injecteerbare randen (stores, principaalresolver) voor tests
 * @param {'read'|'create'|'update'|'delete'} [action]
 * @returns {Promise<{tableMeta, grade, scopeKey, viewer, dialect, datatable}>}
 * @throws  een cliënt-veilige weigering (readError) met een reden
 */
async function resolveDatatableSource(ctx, table, deps = {}, action = 'read') {
    const isWrite = WRITE_ACTIONS.includes(action);
    if (!isWrite && action !== 'read') {
        // Een aanroeper die een actie verzint hoort niet stilzwijgend als lezer
        // behandeld te worden — dat zou de mode-weigering hieronder overslaan.
        throw readError(422, 'This screen asked for something a linked Studio table cannot do.');
    }
    // Lazy vereist, net als core/automationRunner/datatableResolve.js het doet:
    // deze twee slepen de pg-pool binnen en deze module moet laadbaar blijven in
    // suites die de database stubben.
    const datatableStore = deps.datatableStore || require('../stores/datatableStore');
    const datatableDbStore = deps.datatableDbStore || require('../stores/datatableDbStore');
    const resolvePrincipal = deps.resolveDatatablePrincipalForUser || resolveDatatablePrincipalForUser;

    // ── de koppeling zelf ───────────────────────────────────────────
    const source = tableSource(table);
    const shapeOk = source && typeof source === 'object' && !Array.isArray(source)
        && TABLE_SOURCE_KINDS.includes(source.kind)
        && typeof source.datatableId === 'string' && source.datatableId
        // Alleen de modes uit het vocabulaire. Een waarde die er niet in staat
        // stil als 'read' lezen zou een typefout in een recht veranderen; alles
        // wat geen mode is, is een kapotte koppeling — niet een smallere.
        && TABLE_SOURCE_MODES.includes(source.mode);
    if (!shapeOk) {
        throw readError(422, 'This screen reads a linked Studio table, but the link is not valid.');
    }

    // ── een `read`-koppeling schrijft niet, en zegt dat ─────────────
    // Vóór alles wat een database aanraakt: dit antwoord hangt niet af van wie
    // je bent of van de vraag of de tabel er nog is, en een weigering die pas ná
    // het zoeken valt kan alsnog een storing worden. De cap op 'viewer' verderop
    // blijft óók staan — die is het tweede slot voor een aanroeper die ooit een
    // schrijving als `action:'read'` binnenbrengt.
    if (isWrite && source.mode !== WRITABLE_TABLE_SOURCE_MODE) {
        throw readError(403, 'This screen is linked to a Studio table for reading only, so it cannot change rows.');
    }

    // ── REGEL 1: wie leest — de kijker, nooit de auteur ─────────────
    // Twee onafhankelijke poorten voor hetzelfde antwoord op de publieke route:
    // de gereserveerde rol (wat de app van hem vindt) en het anonieme
    // bezoekers-id (wie hij is). Eén ervan zou genoeg zijn; twee zorgen dat een
    // toekomstige route die er maar één zet niet stilzwijgend doorloopt.
    if (ctx && ctx.role === PUBLIC_ROLE_KEY) {
        throw readError(403, `A public page cannot ${isWrite ? 'change rows in' : 'read'} a linked Studio table.`);
    }
    const viewerId = ctx ? ctx.viewerId : null;
    if (typeof viewerId !== 'string' || !viewerId || viewerId.startsWith(ANON_VIEWER_PREFIX)) {
        throw readError(403, 'Reading a linked Studio table needs a signed-in account.');
    }
    const ownerId = ctx && ctx.app ? ctx.app.userId : null;
    if (typeof ownerId !== 'string' || !ownerId) {
        throw readError(503, 'Could not check who owns this app, so access to the linked Studio table cannot be decided.');
    }

    const viewerPrincipal = await principalFor(
        viewerId, resolvePrincipal,
        'Could not check who you are, so access to the linked Studio table cannot be decided.',
    );
    // Dezelfde principaal? Dan geen tweede ronde: de app-eigenaar die zijn eigen
    // app bekijkt is één persoon, en effectiveGradeForRun rekent dat verderop
    // ook zo af.
    const ownerPrincipal = ownerId === viewerId
        ? viewerPrincipal
        : await principalFor(
            ownerId, resolvePrincipal,
            'Could not check who the app owner is, so access to the linked Studio table cannot be decided.',
        );

    // ── de tabel, in de scopes van de EIGENAAR ──────────────────────
    // De auteur heeft deze koppeling gelegd, dus in zijn organisatie of zijn
    // persoonlijke scope staat hij. Nooit globaal zoeken en achteraf toetsen —
    // dat is een tenant raden (core/automationRunner/datatableResolve.js,
    // weigering 1). De scopes van de KIJKER zijn hier niet de vraag: dat zou een
    // gelijknamige tabel uit een andere tenant kunnen opleveren.
    let datatable = null;
    let scope = null;
    try {
        for (const s of datatableScopesFor(ownerPrincipal)) {
            datatable = await datatableStore.getDatatable(source.datatableId, s);
            if (datatable) { scope = s; break; }
        }
    } catch (_) {
        throw readError(503, 'Could not reach the linked Studio table.');
    }
    if (!datatable) {
        // 422, geen 404: een 404 wordt door de runtime-client een lege lijst, en
        // "de gekoppelde tabel bestaat niet meer" is geen leeg scherm waard.
        throw readError(422, 'The Studio table this screen reads is no longer available to the app owner.');
    }

    // ── REGEL 2: de graden, en het MINIMUM ervan ────────────────────
    let grants;
    try {
        grants = await datatableStore.listGrants(datatable.id);
    } catch (_) {
        // Zonder de grants is elke graad een gok naar beneden die als antwoord
        // "geen toegang" oplevert. Dat is de juiste RICHTING maar de verkeerde
        // BOODSCHAP — zie principalFor.
        throw readError(503, 'Could not check who may read the linked Studio table.');
    }

    // Apart uitgerekend, uitsluitend om te kunnen zeggen WAT er misging. De
    // beslissing komt hieronder uit effectiveGradeForRun; deze twee zijn de
    // reden in de weigering.
    const viewerGrade = gradeForPrincipal(datatable, grants, viewerPrincipal);
    const ownerGrade = gradeForPrincipal(datatable, grants, ownerPrincipal);
    if (!viewerGrade) {
        throw readError(403, 'You do not have access to the Studio table this screen reads.');
    }
    if (!ownerGrade) {
        throw readError(403, 'The app owner no longer has access to the Studio table this screen reads.');
    }

    // MIN(kijker, eigenaar) — nooit de unie. Zie de kop van dit bestand.
    const shared = effectiveGradeForRun(datatable, grants, viewerPrincipal, ownerPrincipal);
    // MIN met de app-rol (regel 2c) en met de koppelingsmodus (regel 3).
    const roleCap = appRoleGrade(table, ctx.role);
    const modeCap = source.mode === WRITABLE_TABLE_SOURCE_MODE ? 'owner' : 'viewer';
    const grade = minGrade(minGrade(shared, roleCap), modeCap);
    if (!grade) {
        // Bereikbaar via `roleCap === null` — een kijker die in de rolmapping van
        // de app nergens valt. In het leespad is dat vandaag afgevangen door
        // dataReadRunner.requireReadableTable (`canRead(table, null)` is false),
        // dus dit is de tweede rem op dezelfde helling. Hij blijft ook staan
        // omdat een vierde MIN die iemand later toevoegt anders stilzwijgend
        // `null` als graad zou doorgeven, en `resolveScope(meta, null, 'read')`
        // daar 'none' van maakt: een lege lijst in plaats van een weigering.
        throw readError(403, 'This screen may not read the Studio table behind it.');
    }

    // ── de tabelbeschrijving, mét het access-blok van de datatabel ──
    let meta = null;
    try {
        meta = await datatableStore.getTableMeta(scope, datatable.id);
    } catch (_) {
        throw readError(503, 'Could not read the layout of the linked Studio table.');
    }
    if (!meta) {
        throw readError(422, 'The Studio table this screen reads has no columns yet.');
    }
    const tableMeta = { ...meta, access: synthesizeAccess(datatable) };
    // ── de RIJREGEL van de app-rol, bovenop de graad ────────────────
    //
    // `synthesizeAccess` vertaalt de rechtenladder van de DATATABEL (viewer /
    // editor, row_scope 'own'|'all'); de rijfilters van het MODEL vielen er tot
    // nu toe buiten, want het access-blok werd in zijn geheel vervangen. Een
    // rol "alleen leverancier X" werd daardoor zonder één foutmelding genegeerd:
    // hij bewaarde prima, valideerde prima, en filterde niets.
    //
    // Hij komt er nu bij, onder de GRAAD — dat is de sleutel waarmee de
    // compiler hieronder zoekt, want `viewer.role` is hier de graad. VERSMALLEN
    // ALLEEN: het predicaat wordt door accessFilter ge-AND met dat van de
    // graad, dus een rijregel kan nooit méér rijen tonen dan de ladder al
    // toestond. `role === 'owner'` slaat rijfilters over (accessFilter), dus de
    // eigenaar van de tabel blijft alles zien — precies zoals bij een app-eigen
    // tabel.
    const roleRule = rowFilterForRole(table, ctx.role);
    if (roleRule && grade !== 'owner') {
        tableMeta.access = { ...tableMeta.access, rowFilters: { [grade]: roleRule } };
    }

    // ── wat een SCHRIJVING er bovenop krijgt ────────────────────────
    if (isWrite) {
        // De grove controle. `assertCanWrite` hieronder zou een viewer ook al
        // weigeren (synthesizeAccess geeft viewer update:'none'), maar
        // core/dataEngine/accessFilter.js zegt in zoveel woorden dat een
        // gradeAtLeast nooit weg mag omdat "het filter het wel afvangt": het
        // predicaat beantwoordt WELKE RIJEN, niet OF.
        if (!gradeAtLeast(grade, 'editor')) {
            throw readError(403, 'You do not have permission to change rows in the Studio table behind this screen.');
        }
        // Twee `access`-blokken, PER ACTIE — `appRoleGrade` vouwde ze tot één
        // bovengrens en dat is te grof voor een rol die wel mag toevoegen maar
        // niet verwijderen.
        //   1. de MODELtabel × de app-rol  — wat de auteur deze rol in DEZE app toestond
        //   2. de DATATABEL  × de graad    — wat de rechtenladder van de tabel toestaat
        // Allebei versmallen; één van de twee weglaten is het lek.
        try {
            assertCanWrite(table, ctx.role, action);
            assertCanWrite(tableMeta, grade, action);
        } catch (e) {
            // AccessError draagt een cliënt-veilige boodschap maar niet de
            // `safe`-vlag; hier krijgt hij hem, zodat het schrijfpad één soort
            // weigering kent.
            throw readError(e && e.status === 400 ? 422 : 403,
                (e && e.message) || 'You do not have permission to perform this action');
        }
    }

    return {
        datatable,
        scope,
        // Nooit zelf `${kind}:${id}` plakken — de sleutel wordt door de store
        // geparseerd, en een handgemaakte variant hasht naar een ANDER schema
        // (stores/datatableDbStore.js, "THE TENANT IS A SCOPE KEY").
        scopeKey: datatableDbStore.scopeKey(scope),
        // synthesizeAccess vertaalt de graad-ladder naar het `access`-blok dat
        // de compiler leest (viewer/editor + row_scope 'own'|'all'). Het
        // access-blok van de MODELtabel hoort bij de opslag van de app en zegt
        // niets over deze rijen; het is hierboven al verwerkt als bovengrens.
        tableMeta,
        grade,
        // De viewer voor de rijfilter. `id` is wat 'own' scope tegen `created_by`
        // legt. `role` is hier bewust de GRAAD en niet de app-rol: binnen het
        // access-blok van de datatabel is de graad de rol, en een rijfilter die
        // ooit `viewer.role` leest moet hetzelfde antwoord krijgen als de
        // compiler.
        viewer: { ...(ctx.viewer || {}), id: viewerId, role: grade },
        // Datatabellen staan ALTIJD in Postgres (zie stores/datatableDbStore.js);
        // de procesbrede STUDIO_APP_ENGINE gaat over de app-eigen opslag en zegt
        // hier niets. Een compile onder de verkeerde dialect is geen crash maar
        // stilzwijgend andere SQL, dus de dialect wordt hier uitgesproken.
        dialect: 'pg',
    };
}

/**
 * De Studio-datatabellen die deze gebruiker kan bereiken, als lijst van ids.
 *
 * De AUTEURSTIJD-tweelingbroer van de lezing hierboven: `validate.js` toetst
 * `model.tables[].source.datatableId` hierop, zodat de publicatiepoort dezelfde
 * tabellen ziet als de runtime. Beide scopes (organisatie én persoonlijk) —
 * alleen de persoonlijke meesturen zou een werkende app afkeuren.
 *
 * → `null` zodra de identiteit of de store niet gelezen kan worden. "Geen
 * lijst" en "een lege lijst" zijn verschillende antwoorden: de eerste laat
 * checkTableSource de id BIJ NAAM als waarschuwing melden, de tweede zou elke
 * gekoppelde tabel afkeuren op grond van een vraag die niemand kon
 * beantwoorden.
 */
async function listOwnerDatatableIds(ownerId, deps = {}) {
    if (typeof ownerId !== 'string' || !ownerId) return null;
    const datatableStore = deps.datatableStore || require('../stores/datatableStore');
    const resolvePrincipal = deps.resolveDatatablePrincipalForUser || resolveDatatablePrincipalForUser;
    try {
        const principal = await resolvePrincipal(ownerId);
        // Een principaal die deels niet gelezen kon worden mist misschien juist
        // de organisatie waar de tabel in staat. Dan liever geen lijst dan een
        // halve.
        if (!principal || !principal.userId || principal.identityError) return null;
        const ids = new Set();
        for (const scope of datatableScopesFor(principal)) {
            for (const dt of await datatableStore.listDatatablesForScope(scope)) {
                if (dt && typeof dt.id === 'string') ids.add(dt.id);
            }
        }
        return [...ids];
    } catch (_) {
        return null;
    }
}

/** Eén LEZING — de ingang van dataReadRunner.readPlan. */
function resolveDatatableRead(ctx, table, deps = {}) {
    return resolveDatatableSource(ctx, table, deps, 'read');
}

/**
 * Eén SCHRIJVING — de ingang van actionExecutor/records.js.
 *
 * Dezelfde body, dezelfde drie MINs, plus de mode-weigering, `gradeAtLeast` en
 * de twee `access`-blokken per actie. Wat de aanroeper daarna nog doet is
 * compileren en uitvoeren; er valt geen rechtenbeslissing meer buiten deze
 * functie.
 *
 * @param {'create'|'update'|'delete'} action
 */
function resolveDatatableWrite(ctx, table, action, deps = {}) {
    return resolveDatatableSource(ctx, table, deps, action);
}

/**
 * A datatable's fields as a LINKED model table would carry them.
 *
 * Pure. A relation field on a datatable names its target by DATATABLE id (a
 * Nextcloud mirror pointing at the mirror of another table). In the model,
 * a relation names a MODEL table — so when this app links the target too, the
 * field is re-pointed at that model table; when it does not, the field is
 * degraded to `text` (the row id is still readable) and reported, so the
 * author can link the target and get the relation back.
 *
 * @returns {{ fields:Array, warnings:string[] }}
 */
function projectFieldsForModel(datatableFields, model) {
    const byDatatableId = new Map();
    for (const t of (model && Array.isArray(model.tables) ? model.tables : [])) {
        const src = t && t.source && typeof t.source === 'object' ? t.source : null;
        if (src && src.kind === 'datatable' && typeof src.datatableId === 'string') byDatatableId.set(src.datatableId, t.id);
    }
    const warnings = [];
    const fields = (Array.isArray(datatableFields) ? datatableFields : []).map((f) => {
        if (!f || f.type !== 'relation' || !f.relation || typeof f.relation.table !== 'string') return f;
        const modelTableId = byDatatableId.get(f.relation.table);
        if (modelTableId) return { ...f, relation: { ...f.relation, table: modelTableId, fk: false } };
        warnings.push(`"${f.name || f.key}" links to a Studio table this app does not link (${f.relation.table}); it is carried as text until that table is linked too.`);
        const { relation, ...rest } = f;
        return { ...rest, type: 'text' };
    });
    return { fields, warnings };
}

module.exports = {
    isDatatableBacked,
    listOwnerDatatableIds,
    projectFieldsForModel,
    resolveDatatableRead,
    resolveDatatableWrite,
    WRITE_ACTIONS,
    // test-only — de pure helften van de beslissing
    _tableSource: tableSource,
    _minGrade: minGrade,
    _appRoleGrade: appRoleGrade,
};
