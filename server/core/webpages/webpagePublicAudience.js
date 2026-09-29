/**
 * "Wie ziet de pagina" — de vier rijen, en wat er bij de vierde hoort.
 *
 * Drie van de vier rijen zijn het gewone Studio-publiek dat elk object heeft:
 * Persoonlijk, Hele organisatie, Groepen (afgeleid uit `is_published` +
 * `shared_groups`, precies zoals de frontend `audienceModeOf` het doet). De
 * vierde is van een andere soort en die moet dat blijven.
 *
 * ── EEN PUBLIEKE SHARE IS GEEN INGELOGDE PAGINA MET MINDER RECHTEN ──
 *
 * Op /w/<slug> staat een script-vrije, door DOMPurify gehaalde MOMENTOPNAME
 * (services/webpageSnapshot.js). Er draait daar geen `beeflowTables`, en de
 * anonieme bridge kent alleen /ai/chat en /ai/stream (publicShareBridge.js).
 * Daaruit volgt alles wat deze module afdwingt:
 *
 *   1. PUBLIEKE TABELBINDINGEN ZIJN ALLEEN-LEZEN. `readwrite` bestaat voor
 *      Persoonlijk, Organisatie en Groepen. Naar buiten gaat een gerenderde
 *      tabel, geen kanaal terug.
 *   2. `publicColumns` IS DE POORT, en die wordt GEVRAAGD. Openbaar zetten
 *      zonder kolomkeuze mag niet stilzwijgend "dan maar alles" betekenen —
 *      en ook niet stilzwijgend het vorige antwoord hergebruiken. Een tabel
 *      die niet in de keuze voorkomt, gaat op NUL kolommen.
 *   3. HET AGENT-BLOK IS INTERN-ONLY. `ai.ask` is bewust uit de anonieme
 *      bridge gehouden, dus een openbare bezoeker draait het niet. De
 *      Openbaar-rij zegt dat erbij in plaats van het blok stil niets te laten
 *      doen (dat is de zin die WebpageActionsPanel al aankondigde).
 *   4. MAAR /ai/chat EN /ai/stream ZITTEN ER WÉL IN. Staat
 *      `bridge_grants.ai.publicEnabled` aan, dan injecteert publicViewer.js in
 *      de react-tak een ECHTE beeflowAI-brug in het publieke document en chat
 *      een anonieme bezoeker op het LLM-budget van de auteur — met
 *      `publicGroundOnPage` zelfs gegrond op de kennis van de pagina. Dat is de
 *      enige eigenschap van dit oppervlak die GELD KOST en de enige die een
 *      bezoeker een levend kanaal geeft, dus hij hoort hier net zo hard te
 *      staan als de twee hierboven. Punten 1-3 zijn constanten; deze is een
 *      SCHAKELAAR, en er is nergens anders een scherm dat hem toont.
 *
 * ── HET ADRES OVERLEEFT DE SHARE ────────────────────────────────────
 *
 * `slug` staat op de PAGINA, `public_share_id` wijst naar de share die dat
 * adres bedient. Daarom kan de onderliggende link vervangen worden — ander
 * token, ander wachtwoord, andere ontvangerslijst — zonder dat het adres
 * verandert. Dat is de winst van "één share is het adres"; het N-share-model
 * eronder blijft gewoon bestaan (losse /share/<token>-links naast de
 * canonieke).
 *
 * Alles hieronder is puur. De I/O staat in routes/webpagesAudience.js, zodat
 * deze beslissingen zonder database te bijten zijn.
 */

'use strict';

/** De drie interne standen, letterlijk gelijk aan VisibilityCapsule's namen. */
const PERSONAL = 'personal';
const ORG = 'org';
const GROUPS = 'groups';

/**
 * Dezelfde afleiding als de frontend (`VisibilityCapsule.audienceModeOf`), met
 * dezelfde drie waarden: een gepubliceerd ding ZONDER groepen is van de hele
 * organisatie, mét groepen van die groepen, en niet-gepubliceerd is
 * persoonlijk. Hier herhaald omdat de server het antwoord ook los moet kunnen
 * geven — één regel, twee plekken, en de namen letterlijk gelijk zodat een
 * verschil meteen opvalt.
 */
function audienceModeOf({ isPublished, sharedGroups }) {
    if (!isPublished) return PERSONAL;
    const groups = Array.isArray(sharedGroups) ? sharedGroups.filter(Boolean) : [];
    return groups.length > 0 ? GROUPS : ORG;
}

/**
 * De poort: welke kolommen van welke gebonden tabel mogen naar buiten?
 *
 * Per binding twee lijsten die verschillend moeten blijven:
 *   columns        wat de pagina INTERN mag lezen
 *   publicColumns  wat er op /w/<slug> in de snapshot terechtkomt
 *
 * Er is met opzet GEEN veld "is hier al over besloten". Nul publieke kolommen
 * is een geldige, veilige uitkomst — "de tabel hangt eraan en er gaat niets
 * naar buiten" — en niet te onderscheiden van "nog niet gevraagd" zonder een
 * derde stand die niets toevoegt: het scherm VRAAGT de keuze bij openbaar
 * zetten, en `applyColumnChoice` zet elke tabel die in dat antwoord ontbreekt
 * terug op nul. Onbekend versmalt daar, niet hier.
 */
function describeColumnGate(tables) {
    const list = Array.isArray(tables) ? tables : [];
    const rows = list.map(t => {
        const columns = Array.isArray(t?.columns) ? t.columns : [];
        const publicColumns = Array.isArray(t?.publicColumns) ? t.publicColumns : [];
        return {
            datatableId: t?.datatableId || '',
            columns,
            publicColumns,
            // Internally a binding may write; publicly it never can.
            mode: t?.mode === 'readwrite' ? 'readwrite' : 'read',
            publicMode: 'read',
            share: publicColumns.length > 0,
        };
    }).filter(r => r.datatableId);
    return {
        tables: rows,
        anyBound: rows.length > 0,
        // Hoeveel tabellen daadwerkelijk iets naar buiten sturen. Nul gebonden
        // tabellen én nul delende tabellen zien er op het scherm hetzelfde uit
        // en zijn dat niet: het eerste is "er hangt niets aan", het tweede is
        // "er hangt iets aan en het blijft binnen".
        sharingCount: rows.filter(r => r.share).length,
    };
}

/**
 * Pas de kolomkeuze toe op de bindingen — de schrijfkant van diezelfde poort.
 *
 * `choice` is `{ [datatableId]: string[] }`, zoals het scherm hem bij "Openbaar
 * zetten" oplevert. De regels, allemaal in de versmallende richting:
 *
 *   - een tabel die NIET in `choice` staat, krijgt een LEGE publicColumns.
 *     Weglaten is geen instemming, en het vorige antwoord hergebruiken zou
 *     betekenen dat een kolom die vorig jaar goedgekeurd is vandaag opnieuw
 *     naar buiten glipt zonder dat iemand ernaar keek;
 *   - een gekozen kolom die niet in `columns` staat, valt af (normalizeTableGrant
 *     doet dat óók nog eens bij het opslaan — twee sloten op dezelfde deur is
 *     hier de bedoeling);
 *   - `choice` mag geen tabellen TOEVOEGEN. Wat er niet gebonden is, wordt hier
 *     niet gebonden.
 */
function applyColumnChoice(tables, choice) {
    const list = Array.isArray(tables) ? tables : [];
    const picked = (choice && typeof choice === 'object' && !Array.isArray(choice)) ? choice : {};
    return list.map(t => {
        const columns = Array.isArray(t?.columns) ? t.columns : [];
        const raw = picked[t?.datatableId];
        const wanted = Array.isArray(raw) ? raw : [];
        const publicColumns = [];
        for (const c of wanted) {
            if (typeof c !== 'string') continue;
            const key = c.trim();
            if (!key || !columns.includes(key) || publicColumns.includes(key)) continue;
            publicColumns.push(key);
        }
        return { ...t, publicColumns };
    });
}

/**
 * Is de toegangsinstelling van de bestaande canonieke share anders dan wat er
 * nu gevraagd wordt?
 *
 * Bepaalt of "Openbaar" opslaan de bestaande link kan HOUDEN of hem moet
 * VERVANGEN. Vervangen betekent een nieuw token — bestaande links werken niet
 * meer — dus dat mag alleen als de eigenaar echt iets anders vroeg.
 *
 * Een MEEGESTUURD wachtwoord telt altijd als een wijziging: we kunnen het niet
 * met de argon2-hash vergelijken zonder te verifiëren, en "misschien hetzelfde"
 * mag geen reden zijn om een wachtwoordwissel stilletjes te laten vallen.
 */
function accessOptionsChanged(share, requested) {
    if (!share) return true;
    const want = requested || {};
    const mode = want.accessMode || 'unlisted';
    if (share.accessMode !== mode) return true;
    if (typeof want.password === 'string' && want.password.length > 0) return true;
    if (mode === 'email') {
        const now = normalizeEmails(share.allowedEmails);
        const next = normalizeEmails(want.allowedEmails);
        if (now.length !== next.length) return true;
        return now.some((e, i) => e !== next[i]);
    }
    return false;
}

/** Kleine letters, ontdubbeld, gesorteerd — zodat vergelijken betekenisvol is. */
function normalizeEmails(raw) {
    if (!Array.isArray(raw)) return [];
    const out = new Set();
    for (const e of raw) {
        if (typeof e !== 'string') continue;
        const v = e.trim().toLowerCase();
        if (v) out.add(v);
    }
    return [...out].sort();
}

/**
 * Het model dat het scherm tekent. Puur: alle rijen komen als argument binnen.
 *
 * `canonicalShare` is de LEVENDE share waar `public_share_id` naar wijst, of
 * null. Een wijzer naar een ingetrokken share hoort hier als null binnen te
 * komen — "openbaar" is dan uit, niet "openbaar met een kapotte link".
 */
function buildAudienceModel({
    webpage,
    canonicalShare = null,
    canonicalShareKnown = true,
    shareCount = 0,
    tables = [],
    ai = null,
    solution = null,
    baseUrl = '',
}) {
    const wp = webpage || {};
    const slug = wp.slug || null;
    const gate = describeColumnGate(tables);
    const isPublic = !!canonicalShare;
    // De ai-plak van `bridge_grants`, of niets. Ontbreekt hij, dan is dat een
    // NIET-GELEZEN stand en geen "uit": zie `aiKnown` hieronder.
    const aiGrant = (ai && typeof ai === 'object' && !Array.isArray(ai)) ? ai : null;
    return {
        internal: {
            mode: audienceModeOf({ isPublished: wp.isPublished, sharedGroups: wp.sharedGroups }),
            isPublished: !!wp.isPublished,
            sharedGroups: Array.isArray(wp.sharedGroups) ? wp.sharedGroups : [],
            organizationId: wp.organizationId || null,
        },
        public: {
            on: isPublic,
            // DRIE standen, niet twee. Kon de share niet opgezocht worden (de
            // database hikte), dan is `on: false` een BEWERING over blootstelling
            // die we niet kunnen waarmaken — en die kant op liegen is de
            // gevaarlijke: de eigenaar leest "niet openbaar" over een pagina die
            // het misschien wél is. `known: false` zegt "niet te controleren",
            // en het scherm hoort dan niets uit te zetten of aan te zetten.
            known: canonicalShareKnown !== false,
            shareId: canonicalShare?.id || null,
            accessMode: canonicalShare?.accessMode || 'unlisted',
            hasPassword: !!canonicalShare?.hasPassword,
            allowedEmails: normalizeEmails(canonicalShare?.allowedEmails),
            expiresAt: canonicalShare?.expiresAt || null,
            viewCount: canonicalShare?.viewCount || 0,
            lastViewedAt: canonicalShare?.lastViewedAt || null,
            // Twee eigenschappen van het publieke oppervlak die het scherm moet
            // uitspreken, niet impliceren. Ze zijn niet instelbaar: ze volgen
            // uit wat een snapshot is.
            tablesReadOnly: true,
            agentRuns: false,
            // En de DERDE, die dat wél is. `bridge_grants.ai.publicEnabled` zet
            // een echte beeflowAI-brug in het publieke document (publicViewer.js
            // → routes/publicShareBridge.js): anonieme bezoekers chatten dan op
            // het budget van de auteur. Zwijgt het model hierover, dan leest de
            // eigenaar de twee regels hierboven als "er draait publiek geen AI"
            // — de gevaarlijke richting.
            //
            // Driewaardig, net als `known` hierboven en om dezelfde reden: kwam
            // de ai-plak niet mee, dan is `aiRuns:false` een bewering over
            // blootstelling die niemand kan waarmaken. Onbekend versmalt: het
            // scherm zegt dan dat het niet te lezen was en beweert niets.
            aiKnown: !!aiGrant,
            aiRuns: aiGrant?.publicEnabled === true,
            // Grondt die publieke AI ook op de kennis van de pagina? Dan gaat
            // niet alleen budget naar buiten maar ook inhoud, langs de kolompoort
            // heen die dit scherm zo zorgvuldig telt.
            aiGroundsOnPage: aiGrant?.publicGroundOnPage === true,
        },
        address: slug
            ? { slug, path: `/w/${slug}`, url: baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}/w/${slug}` : null }
            : null,
        columnGate: gate,
        // Het N-share-model blijft: dit telt ALLE levende shares, canoniek of
        // niet, zodat "er staan nog drie losse links open" zichtbaar is.
        //
        // Dat getal is niet decoratief. "Openbaar uit" trekt uitsluitend de
        // CANONIEKE share in — een losse /share/<token> van dezelfde pagina
        // blijft daarna serveren — dus dit is het enige veld waaraan het
        // scherm kan zien dat "Off" niet hetzelfde is als "niemand kan er
        // meer bij".
        shareCount: Number(shareCount) || 0,
        // En daarom driewaardig, net als `public.known`: was de lijst
        // onleesbaar (`null`), dan is 0 geen feit maar een mislukte lezing, en
        // "er staat verder niets open" mag daar niet uit volgen.
        shareCountKnown: shareCount !== null && shareCount !== undefined,
        solution: solution ? { id: solution.id, name: solution.name || '' } : null,
    };
}

module.exports = {
    PERSONAL,
    ORG,
    GROUPS,
    audienceModeOf,
    describeColumnGate,
    applyColumnChoice,
    accessOptionsChanged,
    normalizeEmails,
    buildAudienceModel,
};
