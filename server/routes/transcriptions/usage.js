/**
 * Meeting notes — what happens to one (M2), and how to undo one thing that did.
 *
 *   GET    /:id/usage         →  { usage: [...], unchecked: [...] }
 *   DELETE /:id/filed-lines   →  { removedLines, removedDocuments, errors }
 *
 * Feeds three things off one derivation: the "what happens to this meeting"
 * bar under the tag row, the Used-by tab, and the 409 the delete guard
 * answers with. See core/meetingNotes/meetingUsage.js for why it is a scan
 * and not a link table, and for the two things about it that look like bugs.
 *
 * ── MOUNTED BEFORE ./notes ──────────────────────────────────────────
 * `GET /:id` in notes.js captures every literal path that is not in its
 * RESERVED_GET_PATHS — that is how `GET /tags` came to answer 404 for a
 * release. This one is a two-segment path and would survive either order,
 * but it sits with its sibling so the ordering rule stays visible rather
 * than being rediscovered. transcriptions.mount.test.js pins it.
 *
 * ── AUTHORISATION IS THE READ RIGHT ─────────────────────────────────
 * Whoever may open the note may ask what happens to it — it is the same
 * population that already sees its tags, which is what most of this list is
 * derived from. What the answer does NOT do is name things the asker cannot
 * see for themselves: `redactForeign` keeps the kind and the role of somebody
 * else's automation or knowledge base and drops its name, so the tab cannot
 * become a way to enumerate an organisation from one shared meeting.
 *
 * ── THE STORES ARE REQUIRED INSIDE THE HANDLER ──────────────────────
 * stores/knowledgeBases.js, stores/transcriptionStore.js and
 * stores/automationStore/core.js all kick off their own initDB() at module
 * load. routes/transcriptions.payload.test.js requires this whole router
 * tree with a hand-stubbed require cache, and a top-level require here would
 * drag real database init into a test that has no database. The house does
 * this too — routes/knowledgeBases/detail.js requires kbUsage inside the
 * handler for the same reason.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { requireAuth } = require('../../auth/permissions');
const { resolveAccessContext } = require('./shared');
const { validate } = require('../../core/http/validate');
const { NOTHING, NO_QUERY } = require('./schemas');

router.get('/:id/usage', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const transcriptionStore = require('../../stores/transcriptionStore');
        const { usageForMeeting, redactForeign } = require('../../core/meetingNotes/meetingUsage');

        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const note = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        // 404 rather than 403 for a note outside the caller's reach: the same
        // answer every other route on this id gives, so this one cannot be
        // used to probe which ids exist.
        if (!note) return res.status(404).json({ error: 'Not found' });

        const { rows, partial } = await usageForMeeting(note);
        res.json({
            usage: redactForeign(rows, userId),
            // "I could not check notebooks" is a different sentence from "no
            // notebook uses this", and only one of them is safe to delete on.
            // The client says the first out loud; the delete guard treats it
            // as in-use.
            unchecked: partial,
        });
    } catch (err) {
        log.error('[Transcriptions] Usage error:', err.message);
        res.status(500).json({ error: 'Failed to load usage' });
    }
});

/**
 * ── EEN REGEL DIE VERKEERD GELAND IS, WEER WEG (M4) ─────────────────
 *
 * `POST /api/kb/:id/sources` met `kind:'text'` schrijft `config.metadata =
 * { transcriptionId, segmentIndex }` en laat die regel daarmee LANDEN op de
 * tijdlijn van een vergadering: hij verschijnt in de balk onder de tagrij, in
 * het Gebruikt-door-tabblad en in "Uit dit transcript gehaald", en hij houdt
 * de verwijderpoort van die vergadering op 409.
 *
 * Sinds M4 moet de schrijver die vergadering zelf kunnen openen
 * (routes/knowledgeBases/sources.js), dus nieuwe onware regels kunnen er niet
 * meer bij. Rijen die er al staan blijven staan — en voor het slachtoffer is
 * `DELETE /api/kb/:id/sources/:sid` geen uitweg: die vraagt beheer over de
 * kennisbank van de schrijver, en die heeft het slachtoffer per definitie
 * niet. Zonder deze route is de enige overgebleven uitgang de bevestigde
 * ontsnappingsklep van DELETE /:id — de eigen vergadering weggooien om van
 * andermans bewering af te komen.
 *
 * DE BEVOEGDHEID IS EIGENDOM VAN DE VERGADERING, niet leesrecht erop. Een
 * collega met wie de notitie gedeeld is mag hier niets: dit verwijdert rijen
 * uit de kennisbank van iemand anders, en die bevoegdheid hoort bij precies
 * één persoon — degene over wiens vergadering de rij een bewering doet.
 *
 * DE POORT VAN DE SCHRIJFKANT ZIT HIER BEWUST NIET. Of de MAKER van de rij de
 * vergadering (nog) mag zien doet er voor een verwijdering niet toe: een rij
 * die juist NIET gezien had mogen worden is de rij die weg moet. Een
 * leesbaarheidscontrole op dit pad zou van elke verkeerd gelande regel een
 * onverwijderbare regel maken — precies de toestand die dit dicht.
 *
 * De chunks gaan eerst, en dat doet `core/kb/purgeSourceDocuments` — dezelfde
 * lus die routes/knowledgeBases/sources.js gebruikt, niet een tweede variant
 * ernaast. Waarom een LUS en niet één pagina: de FK cascadeert de documentrijen
 * zodra de bron valt, dus een document dat niet door `deleteDocumentChunks` is
 * gegaan verdwijnt wél uit de tabel en houdt zijn embeddings. Eén `listDocuments`
 * met limit 200 liet er bij 201 documenten dus één achter — stil, want er ging
 * niets mis om te melden. In een privacyproduct is verwijderde tekst die vragen
 * blijft beantwoorden de bug.
 *
 * DAAROM VALT DE BRON PAS ALS DE OPRUIMING KLAAR IS. Blijft er iets staan, dan
 * blijft de bronrij óók staan: de regel is dan niet weg, maar hij is ook niet
 * half weg met achtergebleven vectoren. De rij komt in `errors` en telt niet
 * mee in `removedLines`, zodat de eigenaar de vergadering nog steeds op 409
 * ziet staan in plaats van een schone melding te krijgen.
 *
 * Per rij afzonderlijk, en wat niet lukte staat in `errors`: "ik kon dit niet
 * weghalen" is een andere zin dan "er stond niets", en alleen bij de eerste
 * mag de eigenaar niet denken dat hij schoon is.
 */
router.delete('/:id/filed-lines', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const transcriptionStore = require('../../stores/transcriptionStore');
        const { filedTranscriptSources } = require('../../core/meetingNotes/meetingUsage');

        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const note = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        // Zelfde 404 als elke andere route op dit id, zodat ook deze niet te
        // gebruiken is om te achterhalen welke ids bestaan.
        if (!note) return res.status(404).json({ error: 'Not found' });
        if (!note.isOwner) return res.status(403).json({ error: 'Only the owner can remove filed lines', code: 'not_owner' });

        const filed = await filedTranscriptSources(note.id);

        const kbStore = require('../../stores/knowledgeBases');
        const kbSourcesStore = require('../../stores/kbSources');
        const { deleteDocumentChunks } = require('../../core/kb/kbIngestionHelpers');
        const { purgeSourceDocuments } = require('../../core/kb/purgeSourceDocuments');

        let removedLines = 0;
        let removedDocuments = 0;
        const errors = [];
        for (const row of filed) {
            try {
                const purge = await purgeSourceDocuments({
                    kbStore, deleteDocumentChunks,
                    kbId: row.kbId, sourceId: row.sourceId, tenantId: row.tenantId,
                });
                // Wat er wél af is telt mee, ook als de rest bleef staan: dat is
                // geen schone melding, het is een eerlijk aantal.
                removedDocuments += purge.deleted;
                if (!purge.complete) {
                    // Bron NIET weghalen — de FK zou de overgebleven documentrijen
                    // meesleuren en hun embeddings voorgoed doorzoekbaar laten. Een
                    // half opgeruimde bron die als verwijderd wordt gemeld is
                    // dezelfde fout in een ander jasje.
                    const why = purge.errors.length > 0
                        ? purge.errors[0].error
                        : 'documents remained after cleanup';
                    log.warn('[Transcriptions] filed line kept, documents remain:', row.sourceId, why);
                    errors.push({ sourceId: row.sourceId, error: why, documents: purge.errors });
                    continue;
                }
                await kbSourcesStore.remove(row.sourceId);
                removedLines += 1;
            } catch (e) {
                log.warn('[Transcriptions] filed line not removed:', e.message);
                // Dezelfde VORM als de tak hierboven: een client die straks
                // "deze documenten wilden niet" toont leest `e.documents` en
                // mag daar geen `undefined` vinden. Leeg is hier het eerlijke
                // antwoord — de opruiming is niet eens aan documenten toegekomen.
                errors.push({ sourceId: row.sourceId, error: e.message, documents: [] });
            }
        }
        res.json({ removedLines, removedDocuments, errors });
    } catch (err) {
        log.error('[Transcriptions] Unfile error:', err.message);
        res.status(500).json({ error: 'Failed to remove filed lines' });
    }
});

module.exports = router;
