import { createAutomationDraft, createFormAutomation, studioLockHint } from '../studioApps';
import { studioAppForKind } from '../studioNav';

/**
 * De OVERDRACHTSTABEL van de AI-router: van een gekozen soort naar de deur
 * die daar vandaag al bij hoort (Track H4, v1).
 *
 * ── Eén antwoord op "waar wordt dit gemaakt" ────────────────────────────────
 *
 * De sectie komt uit `studioAppForKind(kind)` en de handeling uit de
 * `create.onCreate` van diezelfde registerrij — dezelfde callback die het
 * "Nieuw"-menu aanroept. Dus geen tweede kind→scherm-wandeling hier: die
 * bestond al twee keer eerder in dit programma (studioMap.REGISTRY_BY_KIND en
 * attentionLink.SEGMENT_BY_KIND) en dat is precies waarom studioNav.js hem
 * heeft opgeslokt. De AI-router opent letterlijk dezelfde deur als het menu.
 *
 * ── Een gelockte soort is een bordje, geen deur ─────────────────────────────
 *
 * `sections` is de resolveStudioNav-uitvoer die de aanroeper al vasthoudt
 * (gate-passerende secties plus de gelockte). Staat de sectie daar LOCKED, of
 * staat hij er niet in, dan is `available: false` en doet `run` NIETS —
 * dezelfde regel als NewMenu en de rail. De server hoort zo'n soort al niet
 * terug te geven; dit is de tweede rem, en die hoort er te zijn (huisregel 12:
 * onbekend versmalt).
 *
 * ── Wat er vandaag WEL en NIET meegaat: TWEE vragen, twee tabellen ──────────
 *
 * De schema-kaart doet twee beloften — "het gaat <naam> heten" en "dit is de
 * opdracht" — en die reizen NIET samen. Eén vlag voor allebei was de fout van
 * de eerste ronde: `automation` droeg de naam mee, stond daarom op `true`, en
 * het scherm las dat als "de brief komt aan" en verzweeg de brief juist op de
 * meest waarschijnlijke route. Dus twee tabellen, elk met één vraag:
 *
 *   SEED_SUPPORT[kind]  komt de BRIEF (de beschrijving) bij de bouwer aan?
 *   NAME_SUPPORT[kind]  komt de NAAM van de kaart bij het nieuwe ding aan?
 *
 * SEED_SUPPORT staat op false voor elke soort behalve `form` (zie de tabel),
 * en dat is geen slordigheid maar de stand van zaken: alleen de Form-pagina
 * leest vandaag een prompt van buiten. Voor de rest: de
 * keten die er een zou dragen loopt door zes bestanden die geen van alle in de
 * fence van H4 zitten (useNavigateToPage → AuthedApp → AgentHub →
 * Studio/index → studioApps → de bouwer zelf). Een `?seed=` die niemand leest
 * is geen zaaien, dus die wordt hier niet gesuggereerd. Zet de regel op true
 * zodra de ontvangstkant `takeSeed(kind)` echt leest — dat is de enige
 * wijziging die hier nodig is.
 */

/**
 * Per soort: komt de BRIEF aan bij de bouwer?
 *
 * Alleen `form` JA (de Vragen-tab van de Form-pagina leest `takeSeed`
 * onder `form:<id>`). Voor de rest NEE, en per soort waarom:
 *
 * automation — de assistent leest presetChatInput/autoSendInput, en die
 *              worden alleen intern gezet (components/automation/index.jsx):
 *              geen prop, geen URL-parameter. (BuilderShell.canAutoSend eist
 *              bovendien `!automationId`, terwijl createAutomationDraft de rij
 *              juist eerst aanmaakt — het kanaal moet dus ook daar langs.)
 * form       — WEL: createFormFromRouter maakt het formulier, parkeert de
 *              brief onder `form:<id>` en opent de Vragen-tab, die hem
 *              meteen aan "Build it with AI" geeft.
 * kb         — studio/knowledge/new maakt er direct één aan en opent hem; er
 *              is geen veld voor een prompt onderweg.
 * skill      — het AI-concept van een skill hoort bij
 *              POST /api/skills/ai/draft (Track S3), niet bij deze router.
 * agent      — studio/agents opent het kaartraster, niet de wizard, en
 *              AgentWizard heeft geen initialPrompt-prop.
 * webpage    — de beschrijf-balk bestaat (pages/webpages/BuildBar.jsx) maar
 *              WebpagesPage geeft `onBuild` niet door.
 * app        — het remix-promptpad werkt alleen op een BESTAANDE app.
 * datatable  — 'new' valt in de "niet gevonden"-tak van DatatablesStudio.
 * solution   — idem: SolutionsStudio opent op activeId 'new'.
 * meeting    — een opname/upload begint bij een bestand, niet bij tekst.
 */
const SEED_SUPPORT = Object.freeze({
    automation: false,
    // De Form-pagina (Forms/form/QuestionsTab.jsx) leest hem: de brief wordt
    // geparkeerd ONDER HET ID van het zojuist gemaakte formulier
    // (`form:<automationId>`, zie run hieronder) en de Vragen-tab laat er
    // meteen de vragen uit opstellen — het "Build it with AI"-paneel.
    form: true,
    kb: false,
    skill: false,
    agent: false,
    webpage: false,
    app: false,
    datatable: false,
    solution: false,
    meeting: false,
});

/**
 * Per soort: komt de NAAM van de kaart aan bij het ding dat ontstaat?
 *
 * automation — JA: createAutomationDraft(ctx, { title }) POST de titel mee,
 *              dus de nieuwe routine draagt de naam van de schema-kaart.
 * form       — NEE, en dit is de scherpste: createFormAutomation neemt
 *              vandaag alleen `ctx` en zet de titel zelf op "Untitled form".
 *              We geven `{ title }` al mee (klaar voor de dag dat studioApps
 *              hem aanneemt), maar zolang hij genegeerd wordt beweren we niet
 *              dat de naam meegaat — er ONTSTAAT een rij, onder een andere
 *              naam dan de kaart net noemde.
 * skill      — NEE, zelfde vorm: de create-callback POST hard
 *              t('skills_studio.untitled', 'Untitled skill').
 * kb         — NEE, zelfde vorm: KnowledgeStudio's 'new'-route maakt er direct
 *              één aan onder t('knowledge.untitled', 'New knowledge base').
 * de rest    — NEE, maar zonder rij: agent/webpage/app/datatable/solution/
 *              meeting zijn navigaties, er ontstaat niets om te benoemen.
 *
 * Alle vier de NEE's krijgen op het scherm dezelfde ene zin (DescribeItPanel:
 * `studio.ai.name_manual`), want het gebruikerseffect is hetzelfde: de naam
 * die de kaart noemde staat straks niet in de zijbalk.
 */
const NAME_SUPPORT = Object.freeze({
    automation: true,
    // createFormAutomation neemt de titel aan sinds de Form-pagina bestaat.
    form: true,
    kb: false,
    skill: false,
    agent: false,
    webpage: false,
    app: false,
    datatable: false,
    solution: false,
    meeting: false,
});

/** Een `t` die niets vertaalt, zodat deze module ook zonder er een werkt. */
const plainT = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

const NOOP_RUN = () => Promise.resolve(null);

/**
 * De ENKELVOUDIGE naam van een soort, uit de `create`-rij van zijn sectie —
 * dus letterlijk het woord dat het "Nieuw"-menu gebruikt. Geen tweede
 * woordenlijst voor dezelfde tien dingen: dan heet een app op het ene scherm
 * anders dan op het andere.
 */
export function kindLabel(kind, t = plainT) {
    const app = studioAppForKind(kind);
    if (!app?.create?.labelKey) return typeof kind === 'string' ? kind : '';
    return t(app.create.labelKey, app.create.labelFallback);
}

const unavailable = (kind, section, locked, lockHint, label = '') => ({
    kind: kind || null,
    section: section || null,
    label,
    available: false,
    locked: locked || null,
    lockHint: lockHint || null,
    seedable: false,
    carriesName: false,
    run: NOOP_RUN,
});

/**
 * De bestemming van een soort.
 *
 * @param {string|null} kind
 * @param {{ sections?: any[], t?: Function }} [opts] `sections` = de
 *        resolveStudioNav-uitvoer; `t` alleen voor het label en de lock-hint.
 * @returns {{ kind, section, label, available, locked, lockHint, seedable,
 *             carriesName, run }} `seedable` = de brief komt aan,
 *          `carriesName` = de naam komt aan. Twee vragen, nooit één vlag.
 */
export function destinationForKind(kind, { sections = null, t = plainT } = {}) {
    const app = studioAppForKind(kind);
    // Onbekende soort, of een sectie zonder eigen "Nieuw"-ingang: er is geen
    // deur om te openen, dus er komt er ook geen bij.
    if (!app || !app.create || typeof app.create.onCreate !== 'function') {
        return unavailable(kind, app || null, null, null, kindLabel(kind, t));
    }

    const row = (sections || []).find((s) => s && s.id === app.id) || null;
    // Afwezig telt als niet-beschikbaar, met dezelfde hint die NewMenu's
    // AI-regel kiest als hij de doelsectie niet ziet: we weten niet WAAROM
    // hij weg is (een permissie-gate verbergt de rij), en dan mag het scherm
    // er geen enkele belofte over doen.
    if (!row || row.locked) {
        const reason = row?.locked || 'ceiling';
        return unavailable(kind, app, reason, studioLockHint(reason, t), kindLabel(kind, t));
    }

    const label = kindLabel(kind, t);
    const seedable = SEED_SUPPORT[kind] === true;
    const carriesName = NAME_SUPPORT[kind] === true;

    return {
        kind,
        section: app,
        label,
        available: true,
        locked: null,
        lockHint: null,
        seedable,
        carriesName,
        run: ({ onNavigate, t: runT = t, user = null, name = '', seed = '' } = {}) => {
            const ctx = { onNavigate, t: runT, user };
            const title = typeof name === 'string' && name.trim() ? name.trim() : '';
            // De brief blijft op het overdrachtskanaal staan, ook als deze
            // bouwer hem (nog) niet leest: parkeren is de aanroeper zijn
            // keuze, maar wie run() rechtstreeks aanroept mag hem meegeven.
            if (kind === 'form') return createFormFromRouter(ctx, { title, seed });
            if (seed) parkSeed(kind, seed);
            if (kind === 'automation') return createAutomationDraft(ctx, title ? { title } : undefined);
            return app.create.onCreate(ctx);
        },
    };
}

/**
 * Een formulier uit de AI-router: aangemaakt als formulier dat zijn
 * antwoorden in een tabel verzamelt (de aanbevolen keuze van de "New
 * form"-dialoog), en geopend op de Vragen-tab van de Form-pagina — niet in
 * de routine-bouwer. De brief wordt NA het aanmaken geparkeerd, onder het id
 * van dit formulier: een brief die onder het kale 'form' zou staan, zou door
 * de eerstvolgende Vragen-tab van WELK formulier dan ook worden opgepakt.
 */
async function createFormFromRouter(ctx, { title = '', seed = '' } = {}) {
    const id = await createFormAutomation({ ...ctx, onNavigate: null }, { title: title || null, collect: true });
    if (!id) return null;
    if (seed) parkSeed(`form:${id}`, seed);
    if (ctx.onNavigate) ctx.onNavigate(`studio/forms/${id}/questions`);
    return id;
}

// ── Het zaaikanaal ────────────────────────────────────────────────────────
//
// Eén sleutel, één brief, één keer lezen. De ontvangstkant bestaat vandaag
// NIET (zie SEED_SUPPORT), en dat moet zichtbaar zijn in het gedrag: wie niet
// leest, krijgt niets, en de brief blijft niet stilzwijgend rondslingeren
// voor een volgend scherm dat er toevallig langsloopt.
//
// sessionStorage en niet een module-variabele, omdat de bouwer in een andere
// lazy chunk (en soms na een volledige navigatie) opent. Alles in try/catch:
// in privé-modus GOOIT het lezen én het schrijven al bij het aanraken van
// window.sessionStorage, en een AI-router die daarop omvalt is erger dan een
// brief die niet meereist.

const SEED_KEY = 'beeflow.studioAi.seed';

const store = () => {
    try { return window.sessionStorage; } catch { return null; }
};

/** Parkeer de brief voor `kind`. Stilletjes niets doen als dat niet kan. */
export function parkSeed(kind, seed) {
    const text = typeof seed === 'string' ? seed.trim() : '';
    const key = typeof kind === 'string' ? kind : '';
    try {
        const s = store();
        if (!s) return false;
        if (!key || !text) { s.removeItem(SEED_KEY); return false; }
        s.setItem(SEED_KEY, JSON.stringify({ kind: key, seed: text }));
        return true;
    } catch {
        return false;
    }
}

/**
 * Haal de brief voor `kind` op — en WIS hem, of hij nu paste of niet.
 * Een brief die voor een andere soort geparkeerd stond hoort niet bij dit
 * scherm en blijft dus ook niet liggen.
 */
export function takeSeed(kind) {
    let raw = null;
    try {
        const s = store();
        if (!s) return null;
        raw = s.getItem(SEED_KEY);
        s.removeItem(SEED_KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.seed !== 'string' || !parsed.seed) return null;
    if (kind && parsed.kind !== kind) return null;
    return parsed.seed;
}

export { SEED_KEY, SEED_SUPPORT, NAME_SUPPORT };
