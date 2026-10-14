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
    RELEASE_CHANNELS,
} = require('./constants');
const {
    newReleaseId,
    clientHandle,
    normalizeNotes,
    mapReleaseRow,
} = require('./mappers');
const { makePipelineReleasesStore } = require('./pipelineReleases');

/** Write one gallery release row, inside the caller's handle. */
async function _insertRelease(h, { projectId, blueprintId, version, manifest, notes, publishedBy }) {
    // RETURNING without the manifest: it was just written and the caller
    // already has it; dragging it back through the driver is pure transfer.
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
 * Prune this project's gallery history back to the newest twenty.
 *
 * THREE things hold this query together, and each closes a way the prune
 * could remove a row something points at:
 *
 *   1. `, id` AS THE TIEBREAKER. `published_at` defaults to NOW(), which in
 *      Postgres is TRANSACTION time: rows written in one transaction carry the
 *      same timestamp and their relative order is undefined. OFFSET over an
 *      unstable sort drops an arbitrary row at each n, not necessarily the
 *      oldest. Same reason, same fix as webpage/versions.js and
 *      studioAppStore.writeVersionSnapshot.
 *   2. WHAT AN INSTALL POINTS AT. An install points at the Blueprint with
 *      `projects.installed_from_blueprint_id` and at the number it carries
 *      with `project_solution_entities.installed_version`; together those two
 *      are exactly one release row. Such a row does not count against the cap
 *      and is never deleted. THIS IS NOT THEORY: publishing 25 times while
 *      someone stays on v1 pushes v1 out of the window of the newest twenty,
 *      and then the very install that most needs an answer ("what is v1, and
 *      what changed since") could no longer get one. A partly updated install
 *      holds both numbers, by the way: every stamp pins its own release row,
 *      so also the v3 row of the one app that was never replaced.
 *
 *      ONLY INSTALLS IN THE SOURCE'S ORGANISATION HOLD ROWS, and that is a
 *      deliberate narrowing. Reason 1, who can reach the row: a release row
 *      only leaves through `listReleases`/`getRelease`, which sit behind
 *      `requireProjectRole('owner')` on the SOURCE project; fetching a
 *      Blueprint by id (the upgrade) goes through `canRead`, which is
 *      org-scoped. An install outside that organisation can therefore read the
 *      row it would hold through no door at all; it would freeze a manifest of
 *      up to MAX_BLUEPRINT_BYTES that nobody can fetch. Reason 2, who decides
 *      the input: on a file install both the claimed Blueprint id and
 *      `installed_version` come from a file the installer edits. Without this
 *      narrowing, one forwarded file could switch off another project's cap by
 *      creating installs that claim versions 21..300, and the source
 *      organisation would have no button to remove those foreign "installs".
 *      Such installs still COUNT (`countInstallsFor` splits exactly on that
 *      line); they do not freeze another organisation's history.
 *   3. WHAT THE GALLERY SERVES NOW. `project_blueprints.version` is the number
 *      installable today; that row may never go, or the gallery serves a
 *      version that does not exist in the history. Also reachable and not
 *      theoretical: the series runs per maker, so twenty publishes by
 *      colleague B push colleague A's current v3 out of the window while A's
 *      Blueprint still offers it.
 *
 * The held rows sit OUTSIDE the candidate list and so do not count against the
 * twenty: the same choice as `source <> 'published'` in W2. The table may grow
 * beyond the cap because of that; that is the safe side, bounded by the number
 * of installs and never at the cost of a row something points at.
 *
 * WHAT GUARD 2 CANNOT SEE, and that is the honest limit: stamping is
 * best-effort (install.js says so in as many words), so there are installs
 * that point at the Blueprint with `installed_from_blueprint_id` and carry no
 * stamp at all. For such an install it cannot be established which version it
 * is on, so it holds no row either. That is the narrow side: holding the whole
 * history because one install could not stamp would switch the cap off for
 * good, and that install cannot be updated anyway, because the upgrade runs on
 * stamps too.
 *
 * THE CHANNEL. `AND r.channel = 'gallery'`: a pipeline row has no
 * `blueprint_id`, so both NOT EXISTS guards are true for it, and without this
 * condition one gallery publish would prune the releases a UAT or PRD stage
 * runs on. `_prunePipelineReleases` prunes pipeline rows, with guards of its
 * own.
 *
 * TENANCY. This query READS `projects` but returns nothing of it: the result is
 * a list of ids of this project's release rows, and that list goes to a
 * DELETE, not to a caller. No project name, no owner, no org: no payload is
 * created here that could leak. `projects` is another store's table;
 * publishing always follows a project lookup, so it exists. Should it ever not
 * exist, this statement fails loudly and the publish rolls back: never a quiet
 * prune without guard 2.
 *
 * Only ids come back, so a caller that wants to know what went can see it
 * without the rows themselves travelling any further.
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
    // Only the ids this query returned. A DELETE with a predicate of its own
    // ("everything older than") would bypass the three guards above.
    await h.run(`DELETE FROM project_releases WHERE id = ANY($1::text[])`, [ids]);
    return ids;
}

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

    return {
        publishRelease,
        listReleases,
        getRelease,
        // Pipeline releases of Solution stages (./pipelineReleases.js).
        ...makePipelineReleasesStore({ ready, handle, inTransaction }),
    };
}

module.exports = { makeReleasesStore };
