// @typecheck
'use strict';

/**
 * Knowledge Store — INGETROKKEN (Track Z, Z5). Bewust een lege stub.
 *
 * (a) De tabel `knowledge_metadata` (per-agent kennis) is ingetrokken. De REST-router
 *     die er als enige naar schreef — server/routes/knowledge.js, gemount op
 *     /agents/:id/knowledge — is verwijderd, samen met zijn twee testbestanden en de
 *     mountregel in server/index.js. Niets in het product las die tabel ooit: de
 *     agent-runtime doet retrieval over knowledge_bases/documents/chunks
 *     (core/agentRuntime/knowledgeSearch.js, core/kb/*), de frontend en de mobiele
 *     app praten uitsluitend met /api/kb. Wat hier werd opgeslagen bereikte dus nooit
 *     een prompt — het werd wel geëmbed, betaald en bewaard.
 *
 *     Meegenomen defecten die met dit bestand de codebase verlaten: een ongescopete
 *     verwijder-query (op id, zonder agent_id — een BOLA: agent A kon een item van
 *     agent B raken), een fail-open entitlementcheck (`.length` op een Promise → altijd
 *     0 → de limiet beet nooit) en leespaden die sinds de pgvector-herschrijving `{}`
 *     teruggaven omdat er niet geawait werd.
 *
 *     Ook de tabeldefinitie is geschrapt, niet alleen de CRUD: zou de DDL hier blijven
 *     staan, dan maakt de migratieladder de tabel na de drop hieronder stil opnieuw aan.
 *
 * (b) Bestaande rijen worden NIET door deze code aangeraakt. Ze bevatten door gebruikers
 *     geüploade documenttekst en opgehaalde webpagina's — potentieel persoonsgegevens,
 *     die het verwijderen van een agent overleven en via geen enkel scherm meer wisbaar
 *     zijn. De EIGENAAR exporteert of wist ze als onderdeel van het bewaartermijnbeleid
 *     (per omgeving eerst tellen: aantal rijen en aantal distinct agent_id) en dropt de
 *     tabel daarna.
 *
 * (c) Pas ná die drop mogen de laatste twee regels weg: de STORE_MODULES-entry
 *     `{ name: 'knowledgeStore', file: './stores/knowledgeStore' }` in
 *     server/migrateDb.js (regel 54) en dit bestand zelf. Die entry blijft tot dan staan
 *     omdat migrateDb.registration.test.js eist dat elk geregistreerd bestand bestaat en
 *     een awaitbare initDB exporteert; daarom staat hieronder een no-op initDB.
 *
 * De guard-tests bij dit bestand staan in stores/knowledgeStore.test.js.
 */

/**
 * No-op. Er is geen schema meer om aan te maken; de migratierunner mag hem awaiten.
 */
async function initDB() {}

module.exports = { initDB };
