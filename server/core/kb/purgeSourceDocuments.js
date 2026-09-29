// @typecheck
'use strict';

/**
 * ── ALLE DOCUMENTEN VAN ÉÉN BRON WEG, CHUNKS EERST ──────────────────
 *
 * `documents.source_id` verwijst met `ON DELETE CASCADE` naar `kb_sources`
 * (stores/knowledgeBases.js). Zodra de bronrij valt veegt Postgres élke
 * documentrij mee — óók de rijen waar `deleteDocumentChunks` nooit langs is
 * geweest. Alleen die functie ruimt de vectoren op (lokale `kb_chunks` én
 * `DELETE /kb/documents/{id}` op de search-service), dus een overgeslagen rij
 * laat zijn embeddings voorgoed staan: de tekst is weg van het scherm en nog
 * steeds vindbaar in het zoeken. In een privacyproduct is dat DE bug.
 *
 * Eén pagina van 200 is daar niet genoeg voor: bij 201 documenten blijft er
 * één achter, zonder dat er iets misgaat om te melden. Vandaar de RONDEN-lus.
 * Er wordt na elke ronde opnieuw gelist vanaf het begin — niet met een
 * oplopende offset — want de vorige ronde heeft zijn eigen rijen al uit de
 * resultaatverzameling gehaald; een oplopende offset zou juist gaan overslaan.
 *
 * ── WAAROM DIT EEN EIGEN MODULE IS ──────────────────────────────────
 * Deze opruiming stond twee keer los: mét lus in
 * routes/knowledgeBases/sources.js, en ZONDER lus in
 * routes/transcriptions/usage.js — waar het commentaar bovendien claimde
 * hetzelfde te doen als de KB-route. Twee paden die hetzelfde moeten doen
 * horen dezelfde code te delen; dit is die code.
 *
 * ── DE STORES KOMEN BINNEN, ZE WORDEN NIET GEREQUIRED ───────────────
 * `kbStore` en `deleteDocumentChunks` zijn parameters. Twee redenen:
 * stores/knowledgeBases.js start bij module-load zijn eigen `initDB()`, en
 * routes/transcriptions/usage.js requiret zijn stores juist daarom pas in de
 * handler — een require hier zou die zorgvuldigheid via de achterdeur alsnog
 * omzeilen. En het houdt deze lus toetsbaar zonder database: beide aanroepers
 * hebben de twee al in de hand op het moment dat ze hem nodig hebben.
 *
 * ── "KLAAR" IS EEN ANTWOORD, GEEN AANNAME ───────────────────────────
 * De lus stopt om drie redenen en maar één daarvan betekent "leeg":
 *   - een ronde kwam leeg terug           → `complete: true`
 *   - een volle ronde haalde niets weg    → `complete: false` (stoppen in
 *     plaats van rondjes draaien op documenten die niet weg willen)
 *   - de rondenlimiet is op               → `complete: false`
 * De aanroeper MOET `complete` lezen voordat hij de bronrij weghaalt: doet hij
 * dat niet, dan cascadeert de FK precies de rijen weg die zijn blijven staan.
 * `errors` leeg is niet hetzelfde als klaar — de rondenlimiet gooit niets.
 */

/** Zoveel documenten per ronde opvragen, en zoveel ronden maximaal. */
const PAGE = 200;
const MAX_ROUNDS = 200;

/**
 * Haal de chunks + documentrijen van één kennisbank-bron weg.
 *
 * Verwijdert de BRON zelf NIET — dat is een besluit van de aanroeper, en hij
 * hoort het pas te nemen als `complete` waar is.
 *
 * @param {object} p
 * @param {object} p.kbStore                stores/knowledgeBases (of een double)
 * @param {Function} p.deleteDocumentChunks core/kb/kbIngestionHelpers.deleteDocumentChunks
 * @param {string} p.kbId                   kennisbank waar de bron in zit
 * @param {string} p.sourceId               `kb_sources.id`
 * @param {string} p.tenantId               eigenaar van de kennisbank (`knowledge_bases.tenant_id`)
 * @param {number} [p.pageSize=200]         documenten per ronde
 * @param {number} [p.maxRounds=200]        harde bovengrens op het aantal ronden
 * @returns {Promise<{deleted: number, errors: Array<{documentId: string, error: string}>, complete: boolean}>}
 */
async function purgeSourceDocuments({
    kbStore, deleteDocumentChunks, kbId, sourceId, tenantId,
    pageSize = PAGE, maxRounds = MAX_ROUNDS,
} = /** @type {any} */ ({})) {
    // Zonder de twee kan er niets worden opgeruimd. Gooien in plaats van een
    // leeg-en-klaar antwoord: dat laatste zou de aanroeper de bron laten
    // weghalen terwijl er nog geen enkele chunk weg is.
    if (!kbStore || typeof kbStore.listDocuments !== 'function') {
        throw new Error('purgeSourceDocuments: kbStore.listDocuments is required');
    }
    if (typeof deleteDocumentChunks !== 'function') {
        throw new Error('purgeSourceDocuments: deleteDocumentChunks is required');
    }
    // Een LEGE bron-id is geen "alle bronnen", het is een programmeerfout.
    // `buildDocumentFilters` (stores/knowledgeBases.js:79) hangt de clausule
    // `source_id = ?` er alleen aan als `filters.sourceId` truthy is — het
    // commentaar daaronder legt die val zelf uit: null "is falsy and would
    // silently match EVERY document". Zonder deze twee regels zou een derde
    // aanroeper met een ontbrekende id de HELE kennisbank leegvegen en daarna
    // "klaar" te horen krijgen. Hetzelfde voor `kbId`: zonder kennisbank is er
    // geen begrenzing om binnen te blijven.
    if (typeof kbId !== 'string' || !kbId.trim()) {
        throw new Error('purgeSourceDocuments: kbId is required — an empty one is not "every knowledge base"');
    }
    if (typeof sourceId !== 'string' || !sourceId.trim()) {
        throw new Error('purgeSourceDocuments: sourceId is required — an empty one would match EVERY document');
    }

    const perRound = Number(pageSize) > 0 ? Number(pageSize) : PAGE;
    const rounds = Number(maxRounds) > 0 ? Number(maxRounds) : MAX_ROUNDS;

    let deleted = 0;
    const errors = [];
    let complete = false;

    for (let round = 0; round < rounds; round++) {
        const docs = await kbStore.listDocuments(kbId, { limit: perRound, filters: { sourceId } });
        if (!docs || docs.length === 0) { complete = true; break; }
        let removedThisRound = 0;
        for (const doc of docs) {
            try {
                // skipSnapshot: dit is een BRON-gedreven verwijdering. Een kopie
                // per opruiming in kb_document_versions vult een audittabel die
                // geen wispad heeft — precies het tegendeel van wat hier moet.
                await deleteDocumentChunks(kbId, doc.id, tenantId, { skipSnapshot: true });
                deleted++;
                removedThisRound++;
            } catch (err) {
                // Eén rij per document: een document dat elke ronde opnieuw
                // weigert hoort niet zes keer in de lijst te staan. De EERSTE
                // fout blijft staan — dat is degene die het dichtst bij de
                // oorzaak zit.
                if (!errors.some(e => e.documentId === doc.id)) {
                    errors.push({ documentId: doc.id, error: err.message });
                }
            }
        }
        // Niets kwam eraf in een volle ronde: stoppen, en NIET als klaar melden.
        if (removedThisRound === 0) break;
    }

    return { deleted, errors, complete };
}

module.exports = { purgeSourceDocuments, PAGE, MAX_ROUNDS };
