/**
 * Wat er veranderde tussen twee versies van een Blueprint — "What changed".
 *
 * NIET te verwarren met core/releaseNotesDrafter.js en stores/releaseNotesStore.js:
 * die twee gaan over de releases van het PRODUCT (build, git-range, changelog).
 * Dit gaat over de release van één Oplossing: manifest v(n-1) naast manifest v(n).
 *
 * ── Twee lagen, en het onderscheid ertussen is het hele punt ───────────────
 *
 * 1. DE BOOLEAN DIFF is exact en altijd beschikbaar. Per entiteit vergelijkt
 *    `diffEntities` de hash van hetzelfde `hashDefinition` dat de upgrade
 *    gebruikt (appStudio/templateUpgrade.js) — één hasher in dit product, want
 *    jsonb bewaart geen key-volgorde en een tweede hasher zou vroeg of laat een
 *    ongewijzigde entiteit gewijzigd noemen. Deze laag doet GEEN modelaanroep,
 *    raakt het netwerk niet en kan niet omvallen.
 *
 * 2. DE `text` is een fast-tier één-regel-samenvatting per GEWIJZIGDE entiteit.
 *    Dat is de semantische diff in gewone taal, en het is de enige laag die van
 *    een model afhangt.
 *
 * Let op welke vraag laag 1 beantwoordt. De upgrade vergelijkt manifest tegen
 * de LEVENDE entiteit ("heeft de ontvanger dit bewerkt?"). Hier vergelijken we
 * manifest tegen manifest ("wat heeft de MAKER veranderd?"). Zelfde hasher,
 * andere vraag — en daarom werkt deze diff óók voor datatables en kennisbanken,
 * die de upgrade niet kan vergelijken omdat er geen levende payload voor is.
 *
 * ── De modelaanroep mag nooit gooien en nooit de publicatie tegenhouden ────
 *
 * Valt hij om — geen provider, geen model geconfigureerd, een time-out, een
 * weigering, onparseerbare argumenten — dan staat er geen verzonnen zin maar
 * GÉÉN zin: `text` blijft null. Het verschil met "er is niets veranderd" zit in
 * `change`, dat exact is: `change: 'changed'` met `text: null` betekent "we
 * konden het niet opschrijven", `change: 'unchanged'` betekent "geen nieuws".
 * Die twee door elkaar halen is het verschil tussen geen nieuws en geen woorden;
 * `summaryMissing()` is de enige plek waar die vraag beantwoord hoort te worden.
 *
 * De twee lagen zijn ook apart aan te roepen. `diffEntities` is synchroon en
 * puur: een caller die eerst wil publiceren en pas daarna wil verrijken schrijft
 * die notes weg en draait `describeChanges` erna.
 *
 * ── De naad met de release-tabel ──────────────────────────────────────────
 *
 * De echte vorm van een notitie is de LIJST per entiteit. `publishRelease`
 * (stores/blueprintStore.js) neemt echter een plat OBJECT aan — de kolom is
 * `notes JSONB NOT NULL DEFAULT '{}'` en een array wordt geweigerd — en
 * begrenst het geheel op 64 KB. `releaseNotesPayload()` is die ene vertaling,
 * op één plek, inclusief de krimp die voorkomt dat een Oplossing met honderden
 * entiteiten zijn eigen publicatie laat afketsen op een notitie.
 *
 * ── PRIVACY: wat er WEL naar het model gaat ───────────────────────────────
 *
 * De JSON-diff van een entiteit kan klantgegevens bevatten — een voorbeeld in
 * een prompt, een e-mailadres in een routinestap, een tabelrij die als
 * standaardwaarde is blijven staan. De hele diff opsturen is dus geen optie.
 *
 * Wat vertrekt is de VORM van de wijziging, nooit de INHOUD:
 *
 *   • het soort entiteit (`automation`, `app`, …) — productvocabulaire;
 *   • een lijst feiten `{ path, change, count?, value? }`, waarbij `path` een
 *     KEY-PAD is (`definition.steps[]`) en dus schema, geen data;
 *   • een `value` uitsluitend op de paden in VALUE_PATHS, die stuk voor stuk een
 *     GESLOTEN vocabulaire van het product zelf zijn (een staptype, een
 *     kolomtype), en dan nog alleen als de waarde er als token uitziet
 *     (TOKEN_RE) — een tweede slot voor het geval er ooit vrije tekst op zo'n
 *     pad belandt.
 *
 * WIENS MODEL. De tier-resolutie krijgt altijd `userId` (en `userOrgId` als het
 * project er een heeft) mee. Zonder `userId` vertrekt er GEEN aanroep: een
 * resolutie zonder context valt terug op de globale fast-tier, en dan zou de
 * vorm van andermans Oplossing naar het model van de instantie gaan in plaats
 * van naar het model dat die werkruimte koos — onbekend hoort te versmallen,
 * niet te verbreden.
 *
 * Welke velden überhaupt bekeken worden staat in FIELD_ALLOW: een EXPLICIETE
 * allow-list per soort, geen deny-list. Een veld dat volgend jaar aan het
 * manifest wordt toegevoegd bereikt het model dus niet vanzelf — het telt wél
 * mee in de boolean diff, want die gaat over de hele entiteit.
 *
 * UITGESLOTEN, en waarom:
 *   • ELKE bladwaarde buiten VALUE_PATHS. Daar zit de klanttekst: promptvoorbeelden,
 *     e-mailteksten, kolomnamen, HTML van een pagina, standaardwaarden.
 *   • De NAAM van de entiteit. Die staat al in de note-rij en wordt door het
 *     scherm zelf getoond, dus het model heeft hem niet nodig — en een routine
 *     kan naar een klant genoemd zijn ("Herinnering Van Dijk BV").
 *   • `ref` en elk ander intern handvat: nutteloos voor een zin.
 *   • `scheduleCron` als WAARDE. Een cron is geen persoonsgegeven, maar om hem
 *     door te laten zou TOKEN_RE spaties moeten toestaan, en dat maakt het
 *     tweede slot bot voor élk ander toegelaten pad. "Het schema is gewijzigd"
 *     is genoeg.
 *   • Het model-id van een agent. "Er is een ander model gekozen" is het feit;
 *     de merknaam voegt niets toe dat het bekijken waard is.
 *   • Alles voorbij MAX_DEPTH niveaus diep, en objectsleutels die niet als
 *     identifier lezen (KEY_RE) — daar wonen door gebruikers verzonnen sleutels.
 *   • Entiteiten die de nieuwe versie NIET meer bevat. Het notitieblok is de
 *     inhoudsopgave van de nieuwe versie, en de drie toestanden zijn
 *     added/changed/unchanged; een installatie verwijdert bovendien nooit iets
 *     (zie upgrade.js), dus "removed" zou iets beloven wat er niet gebeurt.
 */

'use strict';
const log = require('../../telemetry/log');

/** Hoeveel tekens een note-regel maximaal is. Eén regel, geen alinea. */
const MAX_TEXT_CHARS = 160;
/** Zoveel entiteiten krijgen hooguit een modelaanroep. De rest houdt text null. */
const MAX_SUMMARIES = 25;
/** Eén regel is het wachten niet waard. */
const TIMEOUT_MS = 15_000;
/** Totale tijd die het tekstlaagje mag kosten; daarna blijft de rest zonder zin. */
const DEADLINE_MS = 45_000;
/** Hoeveel aanroepen tegelijk lopen. */
const CONCURRENCY = 3;
/** Zoveel feiten gaan er hooguit mee. Een muur van paden leest geen model. */
const MAX_FACTS = 24;
/** Zo diep wordt er in een object gekeken; dieper zitten verzonnen sleutels. */
const MAX_DEPTH = 4;
/** Harde bovengrens op het JSON dat de gebruikersboodschap wordt. */
const MAX_PAYLOAD_CHARS = 4000;
/** Lengtegrens op de naam die in de note-rij belandt. */
const MAX_NAME_CHARS = 120;
/**
 * Waar de envelop onder moet blijven.
 *
 * Met de hand gelijkgehouden aan `blueprintStore.MAX_NOTES_BYTES`, want de
 * store aanroepen zou hier bij require een pool openen. Geëxporteerd, zodat de
 * drifttest in stores/blueprintStore.releases.test.js de twee tegen elkaar kan
 * leggen: zakt de grens in de store ooit onder deze waarde, dan zou
 * `normalizeNotes` gooien en werd een PUBLICATIE geweigerd wegens een notitie —
 * precies wat dit onderdeel nooit mag veroorzaken.
 */
const MAX_NOTES_ENVELOPE_BYTES = 64 * 1024;

/** Manifest-sleutel (meervoud) → het enkelvoudige kind-vocabulaire van de stamps/plan. */
const KIND_OF = Object.freeze({
    automations: 'automation',
    apps: 'app',
    webpages: 'webpage',
    datatables: 'datatable',
    agents: 'agent',
    knowledgeBases: 'knowledge_base',
});

/**
 * De velden per soort waarvan een WIJZIGING beschreven mag worden.
 *
 * Allow-list, geen deny-list: een veld dat volgend jaar aan het manifest wordt
 * toegevoegd bereikt het model niet totdat iemand het hier opschrijft. Dat een
 * veld hier staat betekent overigens niet dat de INHOUD ervan vertrekt — alleen
 * het pad. Waarden vertrekken uitsluitend via VALUE_PATHS.
 */
const FIELD_ALLOW = Object.freeze({
    automation: Object.freeze(['kind', 'title', 'description', 'triggerType', 'scheduleCron', 'scheduleTz', 'definition']),
    app: Object.freeze(['name', 'description', 'icon', 'accentColor', 'definition', 'seedTables']),
    webpage: Object.freeze(['name', 'description', 'instructions', 'icon', 'accentColor', 'tagline', 'files', 'bridgeGrants']),
    datatable: Object.freeze(['key', 'name', 'description', 'rowScope', 'retentionDays', 'retentionField', 'subjectColumn', 'columns']),
    agent: Object.freeze(['name', 'description', 'systemPrompt', 'model', 'starterPrompts', 'threadsEnabled', 'copyEnabled', 'workspaceEnabled', 'config']),
    knowledge_base: Object.freeze(['name', 'description', 'icon', 'usageContexts']),
});

/**
 * De paden waarvan de WAARDE mee mag. Stuk voor stuk een gesloten vocabulaire
 * van het product zelf: een staptype komt uit de stappencatalogus, een kolomtype
 * uit een vaste lijst, een rowScope is 'own' of 'all'. Vrije tekst staat hier
 * niet, en kan hier ook niet per ongeluk in belanden: TOKEN_RE is het tweede
 * slot op elke waarde die dit passeert.
 */
const VALUE_PATHS = Object.freeze([
    'kind',
    'triggerType',
    'scheduleTz',
    'rowScope',
    'threadsEnabled',
    'copyEnabled',
    'workspaceEnabled',
    'config.memoryEnabled',
    'definition.trigger.type',
    'definition.steps[].type',
    'columns[].type',
    'usageContexts[]',
]);
/** Dezelfde lijst als Set. Los, omdat een bevroren Set niet bevroren IS: het
 *  freeze-slot zit op de eigen properties, niet op de inhoud van een Set — en
 *  een allow-list die stilletjes aangevuld kan worden is er geen. */
const VALUE_PATH_SET = new Set(VALUE_PATHS);

/** Een objectsleutel die als schema leest. Al het andere wordt `*` in het pad. */
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** Een waarde die als enum-token leest. Geen spaties: vrije tekst valt af. */
const TOKEN_RE = /^[A-Za-z0-9_.:/-]{1,40}$/;

const TOOL = Object.freeze({
    type: 'function',
    function: {
        name: 'record_change_summary',
        description: 'Record, in one short line, what changed in this part of the Solution.',
        parameters: {
            type: 'object',
            properties: {
                summary: {
                    type: 'string',
                    description: `One line of at most ${MAX_TEXT_CHARS} characters, saying what changed. No name, no quotes, no bullet list.`,
                },
            },
            required: ['summary'],
        },
    },
});

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Dezelfde hasher als de upgrade. Laat geladen, net als daar. */
function hashOf(payload) {
    const { hashDefinition } = require('../../appStudio/templateUpgrade');
    return hashDefinition(payload);
}

// ── Laag 1: de boolean diff ────────────────────────────────────────────────

/** De naam die in de note-rij komt. Automations heten `title`, tabellen hebben ook een `key`. */
function nameOf(entity) {
    const raw = [entity?.name, entity?.title, entity?.key, entity?.ref]
        .find(v => typeof v === 'string' && v.trim());
    return (raw || '').trim().slice(0, MAX_NAME_CHARS);
}

function entityList(manifest, pluralKind) {
    const list = manifest?.solution?.entities?.[pluralKind];
    return Array.isArray(list) ? list.filter(isObject) : [];
}

/**
 * De boolean diff, per entiteit, zonder één modelaanroep.
 *
 * Gematcht op `ref`, want dat is het enige identiteitsbegrip dat een manifest
 * heeft: echte ids reizen bewust niet mee (zie capture.js). Refs zijn
 * POSITIONEEL, dus een maker die entiteiten omgooit ziet een verschuiving als
 * "gewijzigd". Dat is de veilige kant van de fout: deze diff kan iets ten
 * onrechte gewijzigd noemen, maar nooit ten onrechte ONgewijzigd.
 *
 * @returns {Array<{kind:string, entityId:string, name:string, change:'added'|'changed'|'unchanged', text:null}>}
 */
function diffEntities({ previousManifest = null, manifest } = {}) {
    const notes = [];
    for (const [plural, kind] of Object.entries(KIND_OF)) {
        const previousByRef = new Map(
            entityList(previousManifest, plural)
                .filter(e => typeof e.ref === 'string' && e.ref)
                .map(e => [e.ref, e]),
        );
        for (const entity of entityList(manifest, plural)) {
            const ref = typeof entity.ref === 'string' ? entity.ref : '';
            const before = ref ? previousByRef.get(ref) : undefined;
            let change = 'added';
            if (before !== undefined) change = hashOf(before) === hashOf(entity) ? 'unchanged' : 'changed';
            notes.push({
                kind,
                // Het bundel-lokale ref, NOOIT een echt id: een manifest draagt
                // er geen, en dit veld heet `entityId` omdat het de identiteit
                // van de entiteit BINNEN de release is.
                entityId: ref,
                name: nameOf(entity),
                change,
                text: null,
            });
        }
    }
    return notes;
}

/** Is deze regel een ontbrekende samenvatting, of gewoon geen nieuws? */
function summaryMissing(note) {
    return !!note && note.change === 'changed' && !note.text;
}

// ── Laag 2a: wat het model te zien krijgt ──────────────────────────────────

function safeKey(key) {
    return KEY_RE.test(key) ? key : '*';
}

/** Een waarde mag alleen mee op een toegelaten pad, en alleen als token. */
function safeValue(value, path) {
    if (!VALUE_PATH_SET.has(path)) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string' && TOKEN_RE.test(value)) return value;
    return undefined;
}

function sameJson(a, b) {
    if (a === undefined && b === undefined) return true;
    if (a === undefined || b === undefined) return false;
    return hashOf(a) === hashOf(b);
}

function pushFact(facts, fact) {
    if (facts.length >= MAX_FACTS) return;
    const key = JSON.stringify(fact);
    if (facts.some(f => JSON.stringify(f) === key)) return;
    facts.push(fact);
}

/** Multiset-telling van de waarden op één toegelaten pad binnen een array. */
function valueCounts(list, key, path) {
    const counts = new Map();
    for (const item of (Array.isArray(list) ? list : [])) {
        const raw = key === null ? item : (isObject(item) ? item[key] : undefined);
        const value = safeValue(raw, path);
        if (value === undefined) continue;
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
}

/**
 * Arrays worden als MULTISET vergeleken, niet element voor element.
 *
 * Eén stap vooraan invoegen verschuift anders elk volgend element en levert een
 * muur van "gewijzigd" op waar niets gewijzigd is. Een telling plus de
 * toegelaten waarden ("twee stappen erbij: send_email, condition") zegt wat een
 * releasenotitie nodig heeft, en per ongeluk een index-verschuiving als inhoud
 * beschrijven kan zo niet.
 */
function arrayFacts(before, after, path, facts) {
    const arrayPath = `${path}[]`;
    const start = facts.length;

    if (before.length !== after.length) {
        const delta = after.length - before.length;
        pushFact(facts, {
            path: arrayPath,
            change: delta > 0 ? 'added' : 'removed',
            count: Math.abs(delta),
        });
    }

    // De toegelaten waardepaden die binnen déze array liggen: `x[]` voor een
    // array van scalars, `x[].type` voor een array van objecten.
    for (const valuePath of VALUE_PATH_SET) {
        let key;
        if (valuePath === arrayPath) key = null;
        else if (valuePath.startsWith(`${arrayPath}.`) && !valuePath.slice(arrayPath.length + 1).includes('.')) key = valuePath.slice(arrayPath.length + 1);
        else continue;

        const beforeCounts = valueCounts(before, key, valuePath);
        const afterCounts = valueCounts(after, key, valuePath);
        for (const value of new Set([...beforeCounts.keys(), ...afterCounts.keys()])) {
            const delta = (afterCounts.get(value) || 0) - (beforeCounts.get(value) || 0);
            if (delta === 0) continue;
            pushFact(facts, { path: valuePath, change: delta > 0 ? 'added' : 'removed', count: Math.abs(delta), value });
        }
    }

    if (facts.length === start) pushFact(facts, { path: arrayPath, change: 'changed' });
}

function walk(before, after, path, depth, facts) {
    if (facts.length >= MAX_FACTS) return;
    if (sameJson(before, after)) return;

    if (before === undefined || after === undefined) {
        const present = before === undefined ? after : before;
        const fact = { path, change: before === undefined ? 'added' : 'removed' };
        const value = safeValue(present, path);
        if (value !== undefined) fact.value = value;
        pushFact(facts, fact);
        return;
    }

    if (Array.isArray(before) && Array.isArray(after)) {
        arrayFacts(before, after, path, facts);
        return;
    }

    if (isObject(before) && isObject(after)) {
        if (depth >= MAX_DEPTH) { pushFact(facts, { path, change: 'changed' }); return; }
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        for (const key of keys) walk(before[key], after[key], `${path}.${safeKey(key)}`, depth + 1, facts);
        return;
    }

    const fact = { path, change: 'changed' };
    const value = safeValue(after, path);
    if (value !== undefined) fact.value = value;
    pushFact(facts, fact);
}

/**
 * Alles wat over één gewijzigde entiteit naar het model mag — of null als er
 * niets beschrijfbaars veranderde.
 *
 * Gebouwd uit FIELD_ALLOW en niet door sleutels uit de entiteit te verwijderen:
 * een veld dat volgend jaar wordt toegevoegd lekt anders vanzelf mee.
 */
function modelPayload(kind, before, after) {
    const allowed = FIELD_ALLOW[kind];
    if (!allowed) return null;
    const facts = [];
    for (const field of allowed) {
        walk(
            isObject(before) ? before[field] : undefined,
            isObject(after) ? after[field] : undefined,
            field, 1, facts,
        );
    }
    if (!facts.length) return null;
    facts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { kind, changes: facts };
}

// ── Laag 2b: de zin, die nooit gooit ───────────────────────────────────────

/**
 * De enige begrenzing op een aanroep die NOOIT settelt.
 *
 * Een half-open socket geeft geen antwoord en geen fout; zonder deze race
 * blijft `summariseChange` voor altijd hangen, en daarmee — zodra een route
 * hem await — het publicatieverzoek zelf. De deadline in `describeChanges`
 * redt dat niet: die wordt getoetst VOOR de await, niet tijdens.
 *
 * Geëxporteerd om precies die reden testbaar te zijn: een belofte die nooit
 * settelt hoort hier binnen `ms` als afwijzing uit te komen, en de timer wordt
 * opgeruimd zodra de belofte wél settelt (anders houdt een geslaagde aanroep
 * de event-loop nog `ms` lang open — zichtbaar in een testrun zonder
 * --test-force-exit).
 */
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/** Modeluitvoer is onvertrouwd: type, lengte en leegte worden hier afgedwongen. */
function normalise(structured) {
    if (!isObject(structured)) return null;
    const summary = typeof structured.summary === 'string' ? structured.summary.trim() : '';
    if (!summary) return null;
    return summary.slice(0, MAX_TEXT_CHARS);
}

function systemPrompt(language) {
    return [
        'You write one-line change notes for a packaged Solution, for the people who will install the new version.',
        `Answer in ${language}.`,
        'You are given a STRUCTURAL list of what changed: which fields changed, how many items were added or removed, and — only for a few closed vocabularies — the value.',
        'You are NOT given the content. Never invent a value, a name, an address, a number or a piece of text you cannot see in the list.',
        `Write at most ${MAX_TEXT_CHARS} characters, one line, no bullet list, no quotes.`,
        'Do not name the item — the screen shows its name next to your line. Describe only what changed about it.',
        'If the list is vague, be vague and short ("the steps changed") rather than specific and wrong.',
    ].join(' ');
}

/**
 * Eén regel over één gewijzigde entiteit — of null.
 *
 * GOOIT NOOIT. Geen provider, geen geconfigureerd model, een onleesbare config,
 * een time-out, een geweigerde tool, onparseerbare argumenten: allemaal null.
 * Null is "we konden het niet opschrijven", nooit "er is niets veranderd" —
 * `change` blijft daarvoor de enige bron.
 */
async function summariseChange({ kind, before, after, language = 'English', userOrgId = null, userId = null, modelId = undefined, timeoutMs = TIMEOUT_MS, deps = {} } = {}) {
    try {
        const payload = modelPayload(kind, before, after);
        if (!payload) return null;

        const llmClient = deps.llmClient || require('../../core/llm/llmClient');
        let model = modelId;
        if (model === undefined) {
            // ONBEKEND VERSMALT. Zonder `userId` is er niets op te halen: de
            // org-override hangt aan `userOrgId` en de EU-modus aan de
            // Privacy Shield van de gebruiker (modelResolver.isEUModeActive).
            // Een resolutie zonder allebei valt terug op de GLOBALE fast-tier —
            // dan zou de vorm van andermans Oplossing naar het model van de
            // instantie gaan in plaats van naar het model dat die werkruimte
            // gekozen heeft. Geen context is dus geen zin, nooit een bredere
            // keuze. (`userOrgId` mag wél null zijn: een persoonlijk project
            // heeft geen organisatie, en de gebruiker beslist dan zelf.)
            if (!userId) return null;
            const resolve = deps.resolveModelForTierName
                || require('../../core/llm/modelResolver').resolveModelForTierName;
            // `fallback` blijft opt-in en wordt hier niet gegeven —
            // niemand-heeft-er-een-geconfigureerd is een echt antwoord en
            // betekent: geen zin.
            model = await resolve('fast', { userOrgId, userId });
        }
        if (!model) return null;

        const body = JSON.stringify(payload).slice(0, MAX_PAYLOAD_CHARS);
        const result = await withTimeout(
            llmClient.chatForcedTool(model, [
                { role: 'system', content: systemPrompt(language) },
                { role: 'user', content: body },
            ], TOOL, { maxTokens: 200, temperature: 0 }),
            timeoutMs,
            'release note',
        );
        return normalise(result?.structured);
    } catch (e) {
        // Stil op warn-niveau: op een installatie zonder provider zou dit
        // anders bij elke publicatie per entiteit afgaan.
        log.warn('[Blueprint] change summary unavailable:', e.message);
        return null;
    }
}

/**
 * Vul `text` op de gewijzigde regels. Muteert de meegegeven notes en geeft ze
 * terug. Gooit niet, en houdt niets tegen: wat na de deadline of boven
 * MAX_SUMMARIES komt houdt gewoon `text: null`.
 */
async function describeChanges(notes, { previousManifest = null, manifest, language = 'English', userOrgId = null, userId = null, timeoutMs = TIMEOUT_MS, deps = {}, deadlineMs = DEADLINE_MS, now = () => Date.now() } = {}) {
    const list = Array.isArray(notes) ? notes : [];
    const targets = list.filter(n => n && n.change === 'changed').slice(0, MAX_SUMMARIES);
    if (!targets.length) return list;
    // Zelfde versmalling als in `summariseChange`, hier vóór de resolutie zodat
    // er zonder gebruikerscontext geen enkele aanroep vertrekt.
    if (!userId) return list;

    const byRef = new Map();
    for (const [plural, kind] of Object.entries(KIND_OF)) {
        for (const entity of entityList(previousManifest, plural)) byRef.set(`prev:${kind}:${entity.ref}`, entity);
        for (const entity of entityList(manifest, plural)) byRef.set(`next:${kind}:${entity.ref}`, entity);
    }

    // Eén modelresolutie voor de hele ronde: hij kost een configlezing en het
    // antwoord is voor elke entiteit hetzelfde. Gooit hij, dan valt de hele
    // tekstlaag stil — precies zoals één omgevallen aanroep dat voor één regel
    // doet, en de notes gaan onveranderd terug.
    let modelId = null;
    try {
        const resolve = deps.resolveModelForTierName
            || require('../../core/llm/modelResolver').resolveModelForTierName;
        modelId = await resolve('fast', { userOrgId, userId });
    } catch (e) {
        log.warn('[Blueprint] no model for change summaries:', e.message);
        return list;
    }
    if (!modelId) return list;

    const deadline = now() + deadlineMs;
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const index = cursor++;
            if (index >= targets.length) return;
            if (now() >= deadline) return;
            const note = targets[index];
            note.text = await summariseChange({
                kind: note.kind,
                before: byRef.get(`prev:${note.kind}:${note.entityId}`),
                after: byRef.get(`next:${note.kind}:${note.entityId}`),
                language, userOrgId, userId, modelId, timeoutMs, deps,
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    return list;
}

/**
 * De notes zoals `blueprintStore.publishRelease` ze aanneemt.
 *
 * Die verlangt een plat OBJECT (`notes JSONB NOT NULL DEFAULT '{}'::jsonb`; een
 * array wordt geweigerd met "Release notes must be an object") en begrenst het
 * geheel op MAX_NOTES_BYTES — 64 KB. De echte vorm van een notitie is de lijst
 * per entiteit, dus die zit hier in een envelop onder `entities`.
 *
 * EN HIJ PAST ALTIJD. Een Oplossing met honderden entiteiten gaat over die 64 KB
 * heen, en dan zou publishRelease gooien — dat is de publicatie tegenhouden
 * vanwege een notitie, precies wat dit onderdeel nooit mag doen. Dus krimpt hij
 * van minst naar meest waardevol:
 *   1. de ZINNEN, want dat is de verrijking; de exacte diff is de kern;
 *   2. de ONGEWIJZIGDE regels, want dat is het minste nieuws;
 *   3. en anders de staart van de lijst.
 * Wat wegviel staat als `omitted` in de envelop, zodat het scherm "n onderdelen
 * staan er niet bij" kan zeggen in plaats van te suggereren dat ze er niet zijn.
 *
 * `maxBytes` heeft dezelfde default als `blueprintStore.MAX_NOTES_BYTES`; de
 * store zelf wordt hier niet aangeroepen, want die opent bij require een pool.
 */
function releaseNotesPayload(notes, { maxBytes = MAX_NOTES_ENVELOPE_BYTES } = {}) {
    const rows = (Array.isArray(notes) ? notes : []).filter(n => n && typeof n === 'object');
    const fits = (payload) => Buffer.byteLength(JSON.stringify(payload), 'utf8') <= maxBytes;

    let payload = { entities: rows, omitted: 0, textsDropped: false };
    if (fits(payload)) return payload;

    const stripped = rows.map(n => ({ ...n, text: null }));
    payload = { entities: stripped, omitted: 0, textsDropped: true };
    if (fits(payload)) return payload;

    let list = stripped.filter(n => n.change !== 'unchanged');
    for (;;) {
        payload = { entities: list, omitted: rows.length - list.length, textsDropped: true };
        if (fits(payload) || !list.length) return payload;
        list = list.slice(0, Math.floor(list.length / 2));
    }
}

/**
 * De notes voor één release: de exacte boolean diff, met een zin op de
 * gewijzigde regels waar dat lukte.
 *
 * Gooit niet. Valt de tekstlaag in zijn geheel om, dan staan de exacte
 * added/changed/unchanged er nog steeds — publiceren kan altijd doorgaan.
 */
async function buildReleaseNotes({ previousManifest = null, manifest, language = 'English', userOrgId = null, userId = null, timeoutMs = TIMEOUT_MS, deps = {}, deadlineMs = DEADLINE_MS, now = () => Date.now() } = {}) {
    const notes = diffEntities({ previousManifest, manifest });
    try {
        await describeChanges(notes, { previousManifest, manifest, language, userOrgId, userId, timeoutMs, deps, deadlineMs, now });
    } catch (e) {
        log.warn('[Blueprint] change summaries unavailable:', e.message);
    }
    return notes;
}

module.exports = {
    buildReleaseNotes,
    releaseNotesPayload,
    diffEntities,
    describeChanges,
    summariseChange,
    summaryMissing,
    modelPayload,
    normalise,
    withTimeout,
    KIND_OF,
    FIELD_ALLOW,
    VALUE_PATHS,
    TOOL,
    MAX_NOTES_ENVELOPE_BYTES,
    MAX_TEXT_CHARS,
    MAX_SUMMARIES,
    MAX_FACTS,
    MAX_DEPTH,
    TIMEOUT_MS,
    DEADLINE_MS,
};
