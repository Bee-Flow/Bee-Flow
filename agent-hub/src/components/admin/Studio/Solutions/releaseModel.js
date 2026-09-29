/**
 * Wat de Versies- en Installaties-tab van de server terugkrijgen, en wat dat
 * betekent — puur, zonder browser, zonder tekst.
 *
 * Zelfde contract als solutionOverviewModel.js hiernaast: elke functie geeft een
 * TOESTAND terug, nooit een zin. Het scherm rendert die toestand door `t()`. Een
 * helper die proza teruggaf zou copy neerzetten waar geen vertaler bij kan.
 *
 * ── De ene fout die deze twee tabs niet mogen maken ────────────────────────
 *
 * "Er is niets" en "we konden het niet lezen" zien er allebei uit als een lege
 * lijst. Op deze twee tabs is dat verschil groter dan elders:
 *
 *   - EEN LEGE VERSIELIJST leest als "deze Oplossing is nooit gepubliceerd",
 *     terwijl de installaties elders er wél van uitgaan dat hij dat is.
 *   - EEN INSTALLATIETELLER DIE NUL WORDT leest als "niemand gebruikt dit",
 *     en dat is precies het antwoord waarop iemand besluit iets weg te gooien.
 *
 * Daarom draagt elk antwoord hier een `state`, en is `ok` met een lege lijst
 * alleen bereikbaar via een GESLAAGDE lees. `unreadable` is geen fout die je
 * wegwerkt maar een antwoord dat het scherm uitspreekt.
 *
 * ── De teller is per definitie niet compleet ───────────────────────────────
 *
 * `projects.installed_from_blueprint_id` wordt geschreven bij een GALERIJ-install
 * en bij een bestandsinstall waarvan de server de herkomstbewering heeft
 * nagelopen; een installatie op een ándere instantie is onzichtbaar, en een
 * herkomst die niet te staven was telt niet mee. Er bestaat dus geen
 * `complete: true` voor dit getal, en dit model biedt er ook geen vlag voor:
 * het scherm zegt ALTIJD "minstens n op deze instantie". Een vlag zou een
 * server die hem per ongeluk op true zet die zin laten weghalen.
 */

/** Een geheel, niet-negatief getal, of null. `null` blijft null — nooit 0. */
function countOrNull(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const n = Math.trunc(value);
    return n >= 0 ? n : null;
}

/** Een versienummer zoals de server het telt: geheel en groter dan nul. */
export function versionOrNull(value) {
    return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Eén release-rij, uit een EXPLICIETE allow-list opgebouwd — niet door sleutels
 * uit de rij te halen. Een kolom die volgend jaar aan `project_releases` wordt
 * toegevoegd bereikt het scherm dan niet vanzelf. Zonder id is er geen rij.
 */
function releaseRow(row) {
    if (!row || typeof row !== 'object') return null;
    if (typeof row.id !== 'string' || !row.id) return null;
    return {
        id: row.id,
        version: versionOrNull(row.version),
        publishedAt: typeof row.publishedAt === 'string' ? row.publishedAt : null,
        notes: (row.notes && typeof row.notes === 'object' && !Array.isArray(row.notes)) ? row.notes : null,
    };
}

/**
 * De publicatiegeschiedenis, uit het antwoord van de releases-route.
 *
 * @param {{status:string, data:any}} remote  Zoals useRemote/`fetch`-state hem draagt.
 * @returns {{state:'loading'|'unreadable'|'ok', releases:Array}}
 */
export function readReleases(remote) {
    const status = remote?.status;
    if (status === 'idle' || status === 'loading' || !status) return { state: 'loading', releases: [] };
    if (status !== 'ok') return { state: 'unreadable', releases: [] };

    const list = remote?.data?.releases;
    // GEEN array = geen antwoord. Een body zonder `releases` is niet "nul
    // publicaties": dat zou een route die van vorm verandert stilletjes
    // laten lezen als een Oplossing die nooit is uitgebracht.
    if (!Array.isArray(list)) return { state: 'unreadable', releases: [] };

    return { state: 'ok', releases: list.map(releaseRow).filter(Boolean) };
}

/** Eén entiteitsregel van een notitie, ook weer uit een allow-list. */
function noteRow(row) {
    if (!row || typeof row !== 'object') return null;
    const ref = typeof row.entityId === 'string' ? row.entityId : '';
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : ref;
    const text = typeof row.text === 'string' && row.text.trim() ? row.text.trim() : null;
    return {
        kind: typeof row.kind === 'string' ? row.kind : '',
        ref,
        name,
        change: typeof row.change === 'string' ? row.change : '',
        text,
        // `change: 'changed'` MET `text: null` betekent "we konden het niet
        // opschrijven" — het tegenovergestelde van `unchanged`, dat "geen
        // nieuws" betekent. Dezelfde vraag als summaryMissing() op de server,
        // en de enige plek waar dit scherm hem beantwoordt.
        summaryMissing: row.change === 'changed' && !text,
    };
}

/**
 * De notitie van één release: de rijen van de boolean diff, plus wat er van de
 * tekstlaag terecht is gekomen.
 *
 * DRIE TOESTANDEN, en het verschil ertussen is de hele reden dat deze functie
 * bestaat:
 *
 *   unrecorded  er is voor deze versie helemaal geen diff vastgelegd (een
 *               publicatie van vóór de release-tabel, of een notitie die niet
 *               opgeslagen kon worden). NIET "er is niets veranderd".
 *   ok          de diff is er. Hij kan leeg zijn — een Oplossing zonder
 *               entiteiten — maar dan is dat een gelezen antwoord.
 *
 * `textsDropped` is de derde: de rijen zijn er, de ZINNEN zijn eruit gehaald
 * omdat de notitie anders niet paste. Dat is iets anders dan een model dat
 * omviel, en het scherm moet die twee niet op één hoop gooien.
 *
 * @returns {{state:'unrecorded'|'ok', rows:Array, omitted:number, textsDropped:boolean}}
 */
export function noteRowsOf(release) {
    const notes = release?.notes;
    const entities = notes?.entities;
    if (!notes || !Array.isArray(entities)) {
        return { state: 'unrecorded', rows: [], omitted: 0, textsDropped: false };
    }
    return {
        state: 'ok',
        rows: entities.map(noteRow).filter(Boolean),
        omitted: countOrNull(notes.omitted) || 0,
        textsDropped: notes.textsDropped === true,
    };
}

/**
 * De rijen, gegroepeerd op wat er met de entiteit gebeurde.
 *
 * `unreadable` telt de rijen die in geen enkele bak vielen. Zo'n rij wordt niet
 * stilletjes weggelaten en ook niet bij `unchanged` gegooid: een `change` die dit
 * scherm niet kent is onbekend, en onbekend versmalt naar "dit konden we niet
 * plaatsen" in plaats van naar "geen nieuws".
 */
export function groupNoteRows(rows) {
    const added = [];
    const changed = [];
    const unchanged = [];
    let unreadable = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.change === 'added') added.push(row);
        else if (row?.change === 'changed') changed.push(row);
        else if (row?.change === 'unchanged') unchanged.push(row);
        else unreadable += 1;
    }
    return { added, changed, unchanged, unreadable };
}

/**
 * Hoe vaak deze Oplossing is geïnstalleerd — voor zover deze instantie het weet.
 *
 * `here` en `elsewhere` zijn onafhankelijk onbekend: een van de twee die niet
 * gelezen kon worden mag de andere niet in een totaal wegmoffelen, en al
 * helemaal niet als 0 verschijnen. Ze komen ook nooit als iets anders dan
 * getallen binnen — geen projectnaam, geen org, geen tijdstip.
 *
 * @returns {{state:'loading'|'unreadable'|'ok', here:number|null, elsewhere:number|null}}
 */
export function readInstalls(remote) {
    const status = remote?.status;
    if (status === 'idle' || status === 'loading' || !status) return { state: 'loading', here: null, elsewhere: null };
    if (status !== 'ok') return { state: 'unreadable', here: null, elsewhere: null };

    const body = remote?.data;
    if (!body || typeof body !== 'object') return { state: 'unreadable', here: null, elsewhere: null };

    const here = countOrNull(body.installsHere);
    const elsewhere = countOrNull(body.installsElsewhere);
    // Een geslaagd antwoord waarin geen van beide een getal is, is geen nul.
    if (here === null && elsewhere === null) return { state: 'unreadable', here: null, elsewhere: null };
    return { state: 'ok', here, elsewhere };
}
