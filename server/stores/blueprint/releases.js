// @typecheck
/**
 * Blueprint releases: the gallery history (`publishRelease`, `listReleases`,
 * `getRelease`, with its prune) and the pipeline releases of Solution stages
 * (`cutPipelineRelease`, `listPipelineReleases`, `getReleasePayloads`, with
 * their own prune). Built by `makeReleasesStore(ctx)` over the context
 * `makeBlueprintStore` builds, plus the gallery's `_saveBlueprint`.
 */

'use strict';

const {
    MAX_RELEASES_PER_PROJECT,
    MAX_PIPELINE_RELEASES_PER_PROJECT,
    MAX_LISTED_PIPELINE_RELEASES,
    RELEASE_PAYLOAD_KINDS,
    RELEASE_CHANNELS,
    TERMINAL_DEPLOYMENT_STATUSES,
    SUCCEEDED_DEPLOYMENT_STATUSES,
    MAX_REQUEST_KEY_LENGTH,
} = require('./constants');
const {
    newReleaseId,
    isNonEmptyString,
    isPlainObject,
    storeError,
    clientHandle,
    assertManifestSize,
    normalizeNotes,
    mapReleaseRow,
    PIPELINE_RELEASE_COLUMNS,
    normalizePayloads,
    samePayloadSet,
    asJsonb,
} = require('./mappers');

/**
 * @param {import('./mappers').BlueprintStoreCtx & {
 *   _saveBlueprint: (h: import('./mappers').QueryHandle, opts: any) => Promise<any>,
 * }} ctx
 */
function makeReleasesStore({ db, ready, handle, inTransaction, _saveBlueprint }) {
    // ── Publiceren: één galerijrij én één release-rij ────────────────────────

    /**
     * Publiceer dit project: bewaar (of bump) de Blueprint in de galerij ÉN noteer
     * de publicatie in de geschiedenis. Samen, of geen van beide.
     *
     * ── DE VOLGORDE, EN WELKE KANT WINT ─────────────────────────────────────
     *
     * De volgorde BINNEN de transactie ligt vast en is niet de interessante vraag:
     * de release-rij draagt `blueprint_id` en het definitieve versienummer, dus de
     * galerijrij moet eerst geschreven zijn. De interessante vraag is wat er
     * gebeurt als de tweede schrijfactie faalt, en daar wint DE RELEASE-RIJ: dan is
     * er niets gepubliceerd — geen Blueprint, en geen verbruikt versienummer.
     *
     * Waarom die kant, en niet "de Blueprint staat er dan tenminste":
     *
     *   1. DEZELFDE VORM ALS DE W2-BEVINDING. Daar werd de zichtbaarheidsvlag vóór
     *      de pin gezet, en een mislukte publicatie serveerde het ongepubliceerde
     *      werk. Hier is de galerijrij de zichtbaarheid — hij is meteen
     *      installeerbaar door de hele org — en de release-rij is de pin: het
     *      vastgelegde "dit is wat v3 was". Zichtbaar zonder pin is precies de
     *      toestand die daar fout was.
     *   2. DE BUMP VERBRUIKT EEN NUMMER. Slaagt de UPDATE en faalt de release-rij,
     *      dan serveert de galerij v3 terwijl de geschiedenis bij v2 ophoudt en de
     *      vólgende publicatie v4 wordt. v3 bestaat dan voorgoed als de versie die
     *      niemand kan terugvinden — en installaties dragen dat nummer mee in hun
     *      stempels, dus het is niet alleen een gat in een lijstje.
     *   3. DE OMGEKEERDE FOUT is met deze volgorde niet te maken: een release-rij
     *      die naar een Blueprint wijst die er niet is, kan niet ontstaan omdat het
     *      id pas bestaat nadat de INSERT/UPDATE geslaagd is — en beide committen
     *      samen. Zonder transactie zou juist die kant onherstelbaar zijn: een
     *      losse release-rij verwijst dan naar een id dat nooit heeft bestaan.
     *
     * Daarom draait het geheel in ÉÉN transactie, met exact dezelfde statements als
     * `saveBlueprint` (zie `handle`) — een tweede kopie van de bump-logica zou juist
     * hier uit de pas gaan lopen.
     *
     * HET SNOEIEN ZIT ER BEWUST IN. Publiceren is één handeling: een geschiedenis
     * die over zijn cap heen groeit omdat de DELETE stilletjes faalde, is dezelfde
     * half-afgemaakte toestand als een Blueprint zonder release-rij. Een
     * galerijpublicatie snoeit alleen het galerijkanaal; pipeline-rijen hebben
     * hun eigen cap en hun eigen waarborgen.
     *
     * @returns {Promise<{blueprint: any, release: any}>}
     * @param {{ organizationId?: string|null, createdBy?: string, sourceProjectId?: string, manifest?: any, notes?: any }} [opts]
     */
    async function publishRelease({
        organizationId = null, createdBy, sourceProjectId, manifest, notes = null,
    } = {}) {
        await ready();
        // Geweigerd VÓÓR de transactie, dus vóór elke schrijfactie: een publicatie
        // zonder project heeft geen geschiedenis om in te staan, en een Blueprint
        // opslaan die daar niet in terechtkomt is precies wat hierboven verboden is.
        if (!sourceProjectId) throw new Error('sourceProjectId is required to publish a release');
        if (!createdBy) throw new Error('createdBy is required');
        if (!manifest?.solution) throw new Error('manifest is required');
        // Ook vóór de transactie: een notitie die niet opgeslagen kan worden mag
        // geen halve publicatie achterlaten, en de weigering moet actionabel zijn.
        const safeNotes = normalizeNotes(notes);

        return db.withTransaction(async (client) => {
            const h = clientHandle(client);
            const blueprint = await _saveBlueprint(h, { organizationId, createdBy, sourceProjectId, manifest });
            // GEEN RIJ TERUG = er is geen galerijrij. Bereikbaar: alleen de maker
            // mag verwijderen, en hij mag dat doen terwijl een collega publiceert —
            // dan vindt de lookup nog een rij en raakt de UPDATE er nul. Zou de
            // release-rij dan tóch geschreven worden, dan wijst zij naar een
            // Blueprint die er niet is; precies de andere helft van de belofte
            // hierboven. Dus afbreken, en de hele publicatie draait terug.
            if (!blueprint?.id) throw new Error('The Blueprint could not be saved, so nothing was published.');
            const release = await _insertRelease(h, {
                projectId: sourceProjectId,
                blueprintId: blueprint.id,
                // Het nummer dat de galerij ná deze publicatie serveert — hetzelfde
                // nummer dat installaties in hun stempels meekrijgen.
                version: blueprint.version,
                // Het manifest ZOALS OPGESLAGEN: op het bump-pad is `solution.version`
                // herschreven, en de geschiedenis moet vastleggen wat er werkelijk is
                // gepubliceerd, niet wat de aanroeper aanbood.
                manifest: blueprint.manifest,
                notes: safeNotes,
                publishedBy: createdBy,
            });
            await _pruneReleases(h, sourceProjectId);
            return { blueprint, release };
        });
    }

    async function _insertRelease(h, { projectId, blueprintId, version, manifest, notes, publishedBy }) {
        // RETURNING zonder het manifest: het is net geschreven en de aanroeper heeft
        // het al — het door de driver terugslepen is puur overdracht.
        const row = await h.one(
            `INSERT INTO project_releases
                (id, project_id, blueprint_id, version, manifest, notes, published_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING id, project_id, blueprint_id, version, notes, published_at, published_by`,
            [newReleaseId(), projectId, blueprintId, version,
             JSON.stringify(manifest ?? {}), JSON.stringify(notes ?? {}), publishedBy],
        );
        return mapReleaseRow(row);
    }

    /**
     * Snoei de galerijgeschiedenis van dit project terug tot de laatste twintig.
     *
     * DRIE dingen houden deze query bij elkaar, en elk sluit een manier waarop het
     * snoeien een rij zou weghalen waar iets naar wijst:
     *
     *   1. `, id` ALS TIEBREAKER. `published_at` valt terug op NOW(), en dat is in
     *      Postgres TRANSACTIETIJD: rijen die in één transactie geschreven worden
     *      dragen dezelfde tijdstempel en hun onderlinge volgorde is dan
     *      ongedefinieerd. OFFSET over een onstabiele sortering laat op elk n een
     *      willekeurige rij vallen — niet per se de oudste. Zelfde reden, zelfde
     *      oplossing als webpage/versions.js en studioAppStore.writeVersionSnapshot.
     *   2. WAAR EEN INSTALLATIE NAAR WIJST. Een installatie wijst met
     *      `projects.installed_from_blueprint_id` naar de Blueprint en met
     *      `project_solution_entities.installed_version` naar het nummer dat zij
     *      draagt; samen zijn die twee precies één release-rij. Zo'n rij telt niet
     *      mee tegen de cap en wordt nooit verwijderd. DIT IS GEEN THEORIE: wie 25
     *      keer publiceert terwijl iemand op v1 blijft zitten, duwt v1 uit het
     *      venster van de laatste twintig — en dan zou juist de installatie die het
     *      hardst een antwoord nodig heeft ("wat is v1, en wat is er sindsdien
     *      veranderd") het niet meer kunnen krijgen. Een deels bijgewerkte
     *      installatie houdt trouwens beide nummers vast: elk stempel pint zijn
     *      eigen release-rij, dus ook de v3-rij van de ene app die nooit is
     *      vervangen.
     *
     *      ALLEEN INSTALLATIES IN DE ORGANISATIE VAN DE BRON HOUDEN VAST, en dat
     *      is een bewuste versmalling. Reden 1 — wie de rij kan bereiken: een
     *      release-rij komt uitsluitend naar buiten via `listReleases`/`getRelease`
     *      en die staan achter `requireProjectRole('owner')` op het BRONproject;
     *      een Blueprint bij id opvragen (de upgrade) loopt door `canRead`, dat
     *      org-gescoopt is. Een installatie buiten die organisatie kan de rij die
     *      zij zou vasthouden dus door geen enkele deur lezen — zij bevriest een
     *      manifest van maximaal MAX_BLUEPRINT_BYTES dat niemand kan opvragen.
     *      Reden 2 — wie de invoer bepaalt: bij een bestandsinstallatie komt zowel
     *      het beweerde Blueprint-id als `installed_version` uit een bestand dat de
     *      installateur zelf bewerkt. Zonder deze versmalling kon iemand met één
     *      doorgestuurd bestand de cap van een ander project uitzetten door
     *      installaties te maken die versies 21..300 claimen, en had de
     *      bron-organisatie geen knop om die vreemde "installaties" weg te halen.
     *      MEETELLEN doen zulke installaties nog steeds — `countInstallsFor`
     *      splitst juist op die grens — de geschiedenis van een andere organisatie
     *      bevriezen niet.
     *   3. WAT DE GALERIJ NU SERVEERT. `project_blueprints.version` is het nummer
     *      dat vandaag installeerbaar is; die rij mag nooit weg, anders serveert de
     *      galerij een versie die in de geschiedenis niet bestaat. Ook bereikbaar
     *      en niet theoretisch: de serie loopt per maker, dus twintig publicaties
     *      door collega B duwen de huidige v3 van collega A uit het venster terwijl
     *      A's Blueprint hem nog steeds aanbiedt.
     *
     * De vastgehouden rijen staan BUITEN de kandidatenlijst en tellen dus niet mee
     * tegen de twintig — dezelfde keuze als `source <> 'published'` in W2. De tabel
     * mag daardoor groter worden dan de cap; dat is de veilige kant, begrensd door
     * het aantal installaties en nooit ten koste van een rij waar iets naar wijst.
     *
     * WAT WAARBORG 2 NIET KAN ZIEN, en dat is de eerlijke grens: stempelen is
     * best-effort (install.js zegt dat met zoveel woorden), dus er bestaan
     * installaties die met `installed_from_blueprint_id` naar de Blueprint wijzen
     * en géén enkel stempel hebben. Van zo'n installatie is niet vast te stellen op
     * welke versie zij staat, dus houdt zij ook geen rij vast. Dat is de smalle
     * kant: de hele geschiedenis vasthouden omdat één installatie niet kon
     * stempelen, zou de cap voorgoed uitschakelen — en die installatie kan sowieso
     * niet worden bijgewerkt, want de upgrade draait óók op stempels.
     *
     * HET KANAAL. `AND r.channel = 'gallery'`: een pipeline-rij heeft geen
     * `blueprint_id`, dus beide NOT EXISTS-waarborgen zijn voor haar waar, en
     * zonder deze voorwaarde zou één galerijpublicatie de releases snoeien waar
     * een UAT- of PRD-stage op draait. Pipeline-rijen snoeit
     * `_prunePipelineReleases`, met eigen waarborgen.
     *
     * TENANCY. Deze query LEEST `projects` maar levert er niets van op: het
     * resultaat is een lijst id's van release-rijen van dít project, en die lijst
     * gaat naar een DELETE, niet naar een aanroeper. Geen projectnaam, geen
     * eigenaar, geen org — er ontstaat hier geen payload om te lekken. `projects`
     * is wel de tabel van een ándere store; publiceren volgt altijd op een
     * projectlookup, dus zij bestaat. Zou zij ooit niet bestaan, dan faalt dit
     * statement luid en draait de publicatie terug — nooit stilzwijgend snoeien
     * zonder waarborg 2.
     *
     * Alleen id's terug, zodat een aanroeper die wil weten wat er verdween dat kan
     * zien zonder dat de rijen zelf nog rondreizen.
     */
    async function _pruneReleases(h, projectId) {
        const doomed = await h.all(
            `SELECT id FROM project_releases r
              WHERE r.project_id = $1
                AND NOT EXISTS (
                    SELECT 1 FROM project_blueprints b
                     WHERE b.id = r.blueprint_id AND b.version = r.version)
                AND NOT EXISTS (
                    SELECT 1 FROM projects p
                      JOIN project_solution_entities e ON e.project_id = p.id
                      JOIN projects src ON src.id = r.project_id
                     WHERE p.installed_from_blueprint_id = r.blueprint_id
                       AND e.installed_version = r.version
                       AND COALESCE(p.organization_id, '') = COALESCE(src.organization_id, ''))
                AND r.channel = 'gallery'
              ORDER BY r.published_at DESC, r.id
              OFFSET $2`,
            [projectId, MAX_RELEASES_PER_PROJECT],
        );
        const ids = (doomed || []).map(r => r?.id).filter(id => typeof id === 'string' && id);
        if (!ids.length) return [];
        // Uitsluitend op de id's die deze query teruggaf. Een DELETE met een eigen
        // predicaat ("alles ouder dan") zou de drie waarborgen hierboven omzeilen.
        await h.run(`DELETE FROM project_releases WHERE id = ANY($1::text[])`, [ids]);
        return ids;
    }

    /**
     * Prune this Solution's pipeline releases back to the newest 50 that nothing
     * holds.
     *
     * A row is HELD, outside the count and never deleted, when it is:
     *   (a) the current or previous release of a stage (what runs, and what a
     *       rollback goes back to);
     *   (b) the release of a deployment that is not finished (awaiting
     *       approval, queued, running, compensating, or any status added later);
     *   (c) the release of a succeeded UAT deployment whose seq is above the PRD
     *       stage's current release: tested, and still waiting to be promoted
     *       (with no PRD stage yet, every UAT-tested release waits);
     *   (d) the release of any succeeded PRD deployment: a rollback target.
     *
     * The stage tables belong to solutionStageStore, which boots AFTER this
     * store. Without them the guards cannot be evaluated, and pruning without
     * them could delete what a stage runs, so this then prunes nothing.
     *
     * The pruned rows' payloads go in the same handle, before the rows.
     */
    async function _prunePipelineReleases(h, projectId) {
        const tables = await h.one(
            `SELECT to_regclass('solution_stages') IS NOT NULL AS stages,
                    to_regclass('solution_deployments') IS NOT NULL AS deployments`,
            [],
        );
        if (!tables?.stages || !tables?.deployments) return [];
        const doomed = await h.all(
            `SELECT r.id FROM project_releases r
              WHERE r.project_id = $1
                AND r.channel = 'pipeline'
                AND NOT EXISTS (
                    SELECT 1 FROM solution_stages s
                     WHERE s.current_release_id = r.id OR s.previous_release_id = r.id)
                AND NOT EXISTS (
                    SELECT 1 FROM solution_deployments d
                     WHERE d.release_id = r.id
                       AND d.status <> ALL($3::text[]))
                AND NOT EXISTS (
                    SELECT 1 FROM solution_deployments d
                     WHERE d.solution_id = r.project_id
                       AND d.release_id = r.id
                       AND d.status = ANY($4::text[])
                       AND (d.stage = 'prd'
                            OR (d.stage = 'uat' AND r.seq > COALESCE((
                                SELECT MAX(ps.current_release_seq) FROM solution_stages ps
                                 WHERE ps.solution_id = r.project_id AND ps.stage = 'prd'), 0))))
              ORDER BY r.seq DESC NULLS LAST, r.published_at DESC, r.id
              OFFSET $2`,
            [projectId, MAX_PIPELINE_RELEASES_PER_PROJECT,
             [...TERMINAL_DEPLOYMENT_STATUSES], [...SUCCEEDED_DEPLOYMENT_STATUSES]],
        );
        const ids = (doomed || []).map(r => r?.id).filter(id => typeof id === 'string' && id);
        if (!ids.length) return [];
        await h.run(`DELETE FROM solution_release_payloads WHERE release_id = ANY($1::text[])`, [ids]);
        await h.run(`DELETE FROM project_releases WHERE id = ANY($1::text[]) AND channel = 'pipeline'`, [ids]);
        return ids;
    }

    /**
     * De publicatiegeschiedenis van één project, nieuwste eerst — zonder manifest.
     *
     * DEZE FUNCTIE AUTORISEERT NIETS. Zij scoopt op het project-id dat zij krijgt,
     * meer niet; de aanroeper moet dat id al hebben geautoriseerd (in de
     * packaging-router is dat `requireProjectRole('owner')`). Zelfde contract als
     * `listStamps` en `listInstalledVersions`, en dezelfde stille manier om het te
     * breken: een nieuwe aanroeper die er een id in gooit dat hij niet controleerde.
     *
     * One channel at a time, 'gallery' by default, so the Versions tab and the
     * installs counter never see a pipeline row (`listPipelineReleases` is the
     * reader for those).
     */
    async function listReleases(projectId, { limit = MAX_RELEASES_PER_PROJECT, channel = 'gallery' } = {}) {
        await ready();
        if (!RELEASE_CHANNELS.includes(channel)) throw new TypeError(`Unknown release channel '${channel}'`);
        if (typeof projectId !== 'string' || !projectId) return [];
        const asked = Number(limit);
        const capped = Math.min(Number.isFinite(asked) && asked > 0 ? Math.trunc(asked) : MAX_RELEASES_PER_PROJECT,
            MAX_RELEASES_PER_PROJECT);
        const rows = await db.getAll(
            `SELECT id, project_id, blueprint_id, version, notes, published_at, published_by
               FROM project_releases
              WHERE project_id = $1 AND channel = $3
              ORDER BY published_at DESC, id
              LIMIT $2`,
            [projectId, capped, channel],
        );
        return (rows || []).map(r => mapReleaseRow(r));
    }

    /**
     * Eén release, mét het manifest zoals het gepubliceerd is, and with its
     * stage fields (seq, channel, gate, contentHash).
     *
     * ALTIJD op (project, id) en nooit op id alleen: het id is de sleutel, maar het
     * project is de scope die de aanroeper heeft geautoriseerd. Een lookup op id
     * alleen zou een geraden id uit een ánder project beantwoorden.
     */
    async function getRelease(projectId, releaseId, { client = null } = {}) {
        await ready();
        if (typeof projectId !== 'string' || !projectId) return null;
        if (typeof releaseId !== 'string' || !releaseId) return null;
        const row = await handle(client).one(
            `SELECT id, project_id, blueprint_id, version, manifest, notes, published_at, published_by,
                    seq, channel, gate, content_hash
               FROM project_releases
              WHERE id = $1 AND project_id = $2`,
            [releaseId, projectId],
        );
        return mapReleaseRow(row, { includeManifest: true, withPipeline: true });
    }

    // ── Pipeline releases (Solution stages) ──────────────────────────────────

    /**
     * Cut a pipeline release of a Solution's Dev project: one immutable,
     * numbered row (`channel = 'pipeline'`, no gallery row) plus its payloads,
     * in one transaction.
     *
     * - The Dev project row is locked first (`FOR UPDATE`), so two cuts never
     *   compute the same `seq`; `uq_project_releases_seq` is the backstop.
     * - Idempotent by `requestKey` (kept in `notes.requestKey`): a replay
     *   answers the row the first call wrote, `replayed: true`.
     * - The same `contentHash` as the latest pipeline release, with the same
     *   payloads (ref, kind, contentHash), writes nothing and answers that
     *   release, `reused: true` ("no changes since Release 6"). Changed
     *   reference rows or KB listings alone still cut the next seq.
     * - `version = seq` and `published_by = createdBy`, because both columns
     *   are NOT NULL and a pipeline row belongs to no Blueprint series.
     * - The pipeline prune runs in the same transaction.
     *
     * Authorises nothing: the caller has checked that `createdBy` owns the
     * Solution. `client` joins a transaction the caller already holds.
     *
     * @param {{ projectId?: string, manifest?: any, contentHash?: string, gate?: any, sourceCut?: any,
     *   notes?: any, createdBy?: string, requestKey?: string|null, payloads?: any[], client?: any }} [opts]
     * @returns {Promise<{ release: any, reused: boolean, replayed: boolean }>}
     */
    async function cutPipelineRelease({
        projectId, manifest, contentHash, gate = null, sourceCut = null, notes = null,
        createdBy, requestKey = null, payloads = [], client = null,
    } = {}) {
        await ready();
        if (!isNonEmptyString(projectId)) throw new Error('projectId is required to cut a release');
        if (!isNonEmptyString(createdBy)) throw new Error('createdBy is required');
        if (!manifest?.solution) throw new Error('manifest is required');
        if (!isNonEmptyString(contentHash)) throw new Error('contentHash is required');
        if (gate != null && !isPlainObject(gate)) throw new TypeError('gate must be an object');
        if (sourceCut != null && !isPlainObject(sourceCut)) throw new TypeError('sourceCut must be an object');
        if (requestKey != null && (!isNonEmptyString(requestKey) || requestKey.length > MAX_REQUEST_KEY_LENGTH)) {
            throw new TypeError('requestKey must be a short string');
        }
        assertManifestSize(manifest);
        const baseNotes = normalizeNotes(notes);
        const safeNotes = requestKey ? normalizeNotes({ ...baseNotes, requestKey }) : baseNotes;
        const rows = normalizePayloads(payloads);

        return inTransaction(client, async (h) => {
            const project = await h.one(`SELECT id FROM projects WHERE id = $1 FOR UPDATE`, [projectId]);
            if (!project) throw storeError(404, 'project_not_found', 'This Solution no longer exists.');

            if (requestKey) {
                const replay = await h.one(
                    `SELECT ${PIPELINE_RELEASE_COLUMNS} FROM project_releases
                      WHERE project_id = $1 AND channel = 'pipeline' AND notes->>'requestKey' = $2
                      ORDER BY seq DESC LIMIT 1`,
                    [projectId, requestKey],
                );
                if (replay) return { release: mapReleaseRow(replay, { withPipeline: true }), reused: false, replayed: true };
            }

            const latest = await h.one(
                `SELECT ${PIPELINE_RELEASE_COLUMNS} FROM project_releases
                  WHERE project_id = $1 AND channel = 'pipeline'
                  ORDER BY seq DESC NULLS LAST, published_at DESC, id
                  LIMIT 1`,
                [projectId],
            );
            if (latest && latest.content_hash === contentHash) {
                // The content hash covers the manifest entities only; reference
                // rows and KB listings travel as payloads (D20). A changed payload
                // is a new release even when no definition changed.
                const stored = await h.all(
                    `SELECT ref, kind, content_hash FROM solution_release_payloads WHERE release_id = $1`,
                    [latest.id],
                );
                if (samePayloadSet(stored || [], rows)) {
                    return { release: mapReleaseRow(latest, { withPipeline: true }), reused: true, replayed: false };
                }
            }

            const next = await h.one(
                `SELECT COALESCE(MAX(seq), 0)::int + 1 AS seq FROM project_releases WHERE project_id = $1`,
                [projectId],
            );
            const seq = Number(next?.seq) > 0 ? Number(next.seq) : 1;
            const row = await h.one(
                `INSERT INTO project_releases
                    (id, project_id, blueprint_id, version, manifest, notes, published_by,
                     seq, channel, content_hash, gate, source_cut)
                 VALUES ($1,$2,NULL,$3,$4,$5,$6,$3,'pipeline',$7,$8,$9)
                 RETURNING ${PIPELINE_RELEASE_COLUMNS}`,
                [newReleaseId(), projectId, seq, JSON.stringify(manifest), JSON.stringify(safeNotes),
                 createdBy, contentHash, asJsonb(gate), asJsonb(sourceCut)],
            );
            for (const p of rows) {
                await h.run(
                    `INSERT INTO solution_release_payloads
                        (release_id, ref, kind, source_entity_id, payload, content_hash)
                     VALUES ($1,$2,$3,$4,$5,$6)`,
                    [row.id, p.ref, p.kind, p.sourceEntityId, p.json, p.contentHash],
                );
            }
            await _prunePipelineReleases(h, projectId);
            return { release: mapReleaseRow(row, { withPipeline: true }), reused: false, replayed: false };
        });
    }

    /**
     * A Solution's pipeline releases, newest first, without manifests.
     * Authorises nothing (same contract as `listReleases`).
     */
    async function listPipelineReleases(projectId, { limit = MAX_PIPELINE_RELEASES_PER_PROJECT, client = null } = {}) {
        await ready();
        if (!isNonEmptyString(projectId)) return [];
        const asked = Number(limit);
        const capped = Math.min(
            Number.isFinite(asked) && asked > 0 ? Math.trunc(asked) : MAX_PIPELINE_RELEASES_PER_PROJECT,
            MAX_LISTED_PIPELINE_RELEASES,
        );
        const rows = await handle(client).all(
            `SELECT ${PIPELINE_RELEASE_COLUMNS} FROM project_releases
              WHERE project_id = $1 AND channel = 'pipeline'
              ORDER BY seq DESC NULLS LAST, published_at DESC, id
              LIMIT $2`,
            [projectId, capped],
        );
        return (rows || []).map(r => mapReleaseRow(r, { withPipeline: true }));
    }

    /**
     * The payloads stored with one release (reference rows, KB listings),
     * optionally of one kind, ordered by ref. Authorises nothing: the caller has
     * read the release through `getRelease(projectId, releaseId)` first.
     */
    async function getReleasePayloads(releaseId, { kind = null, client = null } = {}) {
        await ready();
        if (!isNonEmptyString(releaseId)) return [];
        if (kind != null && !RELEASE_PAYLOAD_KINDS.includes(kind)) throw new TypeError(`Unknown payload kind '${kind}'`);
        const rows = await handle(client).all(
            `SELECT ref, kind, source_entity_id, payload, content_hash
               FROM solution_release_payloads
              WHERE release_id = $1 AND ($2::text IS NULL OR kind = $2)
              ORDER BY ref, kind`,
            [releaseId, kind],
        );
        return (rows || []).map(r => ({
            ref: r.ref,
            kind: r.kind,
            sourceEntityId: r.source_entity_id,
            payload: isPlainObject(r.payload) ? r.payload : {},
            contentHash: r.content_hash,
        }));
    }

    return {
        publishRelease,
        listReleases,
        getRelease,
        cutPipelineRelease,
        listPipelineReleases,
        getReleasePayloads,
    };
}

module.exports = { makeReleasesStore };
