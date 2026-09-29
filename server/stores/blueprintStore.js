// @typecheck
/**
 * Blueprint Store — Blueprints captured from a live Solution.
 *
 * The other half of packaging. A Blueprint can always be downloaded as a file
 * and handed to someone; this table is for the case where it should not have to
 * leave the instance at all — one team packages a Solution and another team in
 * the same organisation installs it, without a file passing through anybody's
 * downloads folder.
 *
 * Mirrors studioAppTemplateStore one level up: same visibility rule, same
 * per-org ceiling, same version-bump-on-re-save. Ids are prefixed `bp_`, so
 * provenance is unambiguous in a log line and in a project's stamp.
 *
 * VISIBILITY is the organisation. A Blueprint belongs to the org of the project
 * it came from, and any member of that org may install it. One captured from a
 * project with no organisation is private to its creator.
 *
 * VERSIONS. Re-saving under the same `solution_key` bumps the version rather
 * than silently overwriting, because installed Solutions carry the version they
 * came from and an upgrade path needs to be able to tell "newer" from
 * "different". Same contract captured app templates already have.
 *
 * THE CEILING is explicit and its message names the offender. "The Blueprint is
 * 6 MB" is not actionable; "the orders app is 5 MB of it" is — and a Solution
 * is N apps plus N routines plus webpage sources, so it reaches a ceiling far
 * more easily than a single app ever did.
 *
 * ── RELEASES (O4) ──────────────────────────────────────────────────────────
 *
 * `project_blueprints` holds ONE row per (solution_key, created_by, org) and
 * that row is OVERWRITTEN on every re-save. It is therefore a statement about
 * the present — "this is what the gallery serves today" — and it cannot answer
 * "what was v3". `project_releases` is the history: one immutable row per
 * publication, carrying the manifest as published and the note that went with
 * it. See `publishRelease` for why the two are written in ONE transaction, and
 * `_pruneReleases` for what the retention cap is not allowed to eat.
 */

'use strict';

const crypto = require('crypto');
const { run, getOne, getAll, exec, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');

// A Solution is many entities, so this is deliberately larger than one app's
// 4 MB — but bounded, because an unbounded table of multi-megabyte JSONB blobs
// is a storage problem whatever it contains.
const MAX_BLUEPRINT_BYTES = 16 * 1024 * 1024;

// A gallery is a place you choose from. A few hundred entries is a search
// problem, not a gallery.
const MAX_BLUEPRINTS_PER_ORG = 100;

// Hoeveel publicaties per project bewaard blijven. Elke rij draagt een volledig
// manifest, dus de geschiedenis is duur; twintig is genoeg om terug te kijken
// en klein genoeg om te bewaren. LET OP: dit is een cap op de rijen die NIETS
// vasthoudt — zie `_pruneReleases`, dat de vastgehouden rijen buiten de telling
// laat en de tabel dus bewust groter laat worden dan 20.
const MAX_RELEASES_PER_PROJECT = 20;

// Een releasenotitie is een notitie, geen bijlage. Het manifest heeft zijn eigen
// (veel ruimere) plafond; zonder een eigen grens zou een notitie dat plafond
// kunnen omzeilen door in dezelfde rij mee te liften.
const MAX_NOTES_BYTES = 64 * 1024;

const initDB = makeStoreInit('BlueprintStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS project_blueprints (
            id TEXT PRIMARY KEY,
            organization_id TEXT,
            created_by TEXT NOT NULL,
            source_project_id TEXT,
            solution_key TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            icon TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            manifest JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_project_blueprints_org
            ON project_blueprints(organization_id) WHERE organization_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_project_blueprints_creator
            ON project_blueprints(created_by);
        CREATE INDEX IF NOT EXISTS idx_project_blueprints_key
            ON project_blueprints(solution_key);

        -- What an installed Solution was made of, and what each entity looked
        -- like the moment it was installed.
        --
        -- PER ENTITY, not per project, and that is the whole point: upgrade
        -- replaces the entities nobody has touched and leaves the ones somebody
        -- has, so it has to be able to tell them apart one at a time. A single
        -- project-level hash would mean one hand-edited app freezes the whole
        -- Solution.
        CREATE TABLE IF NOT EXISTS project_solution_entities (
            project_id TEXT NOT NULL,
            ref TEXT NOT NULL,
            kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            install_hash TEXT NOT NULL,
            installed_version INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (project_id, ref)
        );
        CREATE INDEX IF NOT EXISTS idx_project_solution_entities_project
            ON project_solution_entities(project_id);
    `);

    // ── De releasegeschiedenis van een project ──────────────────────────────
    //
    // Via runDdl (stores/lib/_ddl.js) en niet in de `exec()` hierboven: die twee
    // tabellen dateren van vóór U5, een NIEUWE tabel hoort in de luide ladder.
    // Eén falend statement wordt daar genoteerd in plaats van de hele init te
    // laten struikelen, en een statement-timeout leest niet meer als "bestond al".
    //
    // ZACHTE VERWIJZINGEN, geen FK — beide kanten op en om dezelfde reden als
    // `projects.installed_from_blueprint_id`:
    //   - `project_id` wijst naar een project dat verwijderd mag worden. De
    //     geschiedenis van wat er ooit gepubliceerd is, is geen bezit van dat
    //     project alleen; installaties elders leven ervan verder.
    //   - `blueprint_id` wijst naar een galerijrij die zijn maker mag
    //     weggooien. Een verwijderde Blueprint moet de geschiedenis NIET
    //     meenemen: de rij draagt zijn eigen manifest, dus "wat was v3" blijft
    //     beantwoordbaar, en het dangling id leest als ONBEKEND — nooit als
    //     "staat nog in de galerij".
    //
    // `version` is het versienummer van de Blueprint-serie waar deze publicatie
    // in landde, en die serie loopt per (solution_key, created_by, org). Twee
    // makers die hetzelfde project publiceren hebben dus elk hun eigen v2 —
    // daarom is (project_id, version) NIET uniek en draagt de rij `published_by`
    // en `blueprint_id` om ze uit elkaar te houden.
    //
    // De index draagt de volledige sorteersleutel van de lijst én van het
    // snoeien (`published_at DESC, id`), zodat beide op één index lopen.
    await runDdl('blueprintStore', [
        `CREATE TABLE IF NOT EXISTS project_releases (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            blueprint_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            manifest JSONB NOT NULL,
            notes JSONB NOT NULL DEFAULT '{}'::jsonb,
            published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            published_by TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_project_releases_project
            ON project_releases(project_id, published_at DESC, id)`,
        `CREATE INDEX IF NOT EXISTS idx_project_releases_blueprint
            ON project_releases(blueprint_id, version)`,
    ]);
}

function newId() { return `bp_${crypto.randomBytes(8).toString('hex')}`; }
function newReleaseId() { return `rel_${crypto.randomBytes(8).toString('hex')}`; }

/**
 * Eén queryhandvat, twee bronnen: de pool, of de client van een lopende
 * transactie.
 *
 * Bestaat zodat `saveBlueprint` en `publishRelease` LETTERLIJK dezelfde
 * statements draaien. Een tweede kopie van de bump-logica die "ook even" in een
 * transactie past, is een tweede kopie die uit de pas gaat lopen — en juist
 * daar mag hij dat niet, want dan verschilt het versienummer dat de galerij
 * serveert van het versienummer dat de geschiedenis noteert.
 */
function handle(client) {
    if (!client) return { one: getOne, all: getAll, run };
    return {
        one: async (sql, params) => (await client.query(sql, params)).rows?.[0] || null,
        all: async (sql, params) => (await client.query(sql, params)).rows || [],
        run: async (sql, params) => {
            const r = await client.query(sql, params);
            return { rowCount: r?.rowCount ?? 0 };
        },
    };
}

/** True for an id this store owns. */
function isBlueprintId(id) { return typeof id === 'string' && id.startsWith('bp_'); }

function mapRow(row, { includeManifest = true } = {}) {
    if (!row) return null;
    const meta = {
        id: row.id,
        solutionKey: row.solution_key,
        version: Number.isInteger(row.version) && row.version > 0 ? row.version : 1,
        name: row.name,
        description: row.description || '',
        icon: row.icon || null,
        createdBy: row.created_by,
        sourceProjectId: row.source_project_id || null,
        organizationId: row.organization_id || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (!includeManifest) return meta;
    return { ...meta, manifest: row.manifest || null };
}

/**
 * Which entity is the fat one.
 *
 * Reported rather than guessed at: the point of a size refusal is that someone
 * can act on it, and "deselect a table on the orders app" is an action where
 * "make it smaller" is not.
 */
function largestEntity(manifest) {
    const entities = manifest?.solution?.entities || {};
    let worst = null;
    for (const [kind, list] of Object.entries(entities)) {
        for (const entity of (Array.isArray(list) ? list : [])) {
            const bytes = Buffer.byteLength(JSON.stringify(entity), 'utf8');
            if (!worst || bytes > worst.bytes) {
                worst = { kind, bytes, name: entity.name || entity.title || entity.ref };
            }
        }
    }
    return worst;
}

/**
 * Save a Blueprint, or bump the version of the one with the same solution_key
 * in the same organisation.
 */
async function saveBlueprint(opts = {}) {
    await initDB();
    return _saveBlueprint(handle(null), opts);
}

/**
 * De statements van saveBlueprint, op een pool- óf transactiehandvat.
 * @param h
 * @param {{ organizationId?: string|null, createdBy?: string, sourceProjectId?: string|null, manifest?: any }} [opts]
 */
async function _saveBlueprint(h, {
    organizationId = null, createdBy, sourceProjectId = null, manifest,
} = {}) {
    if (!createdBy) throw new Error('createdBy is required');
    if (!manifest?.solution) throw new Error('manifest is required');

    const bytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
    if (bytes > MAX_BLUEPRINT_BYTES) {
        const worst = largestEntity(manifest);
        const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
        throw new Error(
            worst
                ? `This Blueprint is ${mb(bytes)}, over the ${mb(MAX_BLUEPRINT_BYTES)} limit. The largest part is the ${worst.kind.replace(/s$/, '')} "${worst.name}" at ${mb(worst.bytes)}.`
                : `This Blueprint is ${mb(bytes)}, over the ${mb(MAX_BLUEPRINT_BYTES)} limit.`,
        );
    }

    const solutionKey = manifest.solution.key;
    // FOR UPDATE, en dat is geen sierlijkheid: de UPDATE hieronder zet
    // `version = existing.version + 1` op een waarde die onder READ COMMITTED
    // al verouderd kan zijn. Twee gelijktijdige publicaties van hetzelfde
    // project door dezelfde maker (twee tabbladen, een herhaalde POST na een
    // trage export, de mobiele client naast de web-client) lazen anders allebei
    // v2 en schreven allebei v3 — en dan draagt de geschiedenis TWEE v3-rijen
    // waarvan er één een versie vastlegt die nooit installeerbaar is geweest.
    // Precies de toestand die de kop van `publishRelease` verbiedt, en zij
    // breekt bovendien de invariant waar beide snoeiwaarborgen op leunen:
    // (blueprint_id, version) is exact één release-rij.
    //
    // Op het TRANSACTIEHANDVAT houdt de rijvergrendeling tot de COMMIT, dus de
    // tweede publicatie leest pas verder als de eerste klaar is en telt door
    // vanaf het nieuwe nummer. Op het poolhandvat (`saveBlueprint`) draait dit
    // statement in zijn eigen impliciete transactie en valt het slot meteen weg
    // — daar verandert er dus niets, en dat is ook precies waarom publiceren
    // via `publishRelease` hoort te lopen en niet via `saveBlueprint`.
    //
    // NIET afgedekt, en dat is de eerlijke grens: twee EERSTE publicaties
    // tegelijk vinden geen rij, dus is er ook niets te vergrendelen. Dan
    // ontstaan er twee galerijrijen met elk hun eigen id en elk v1 — hinderlijk,
    // maar (blueprint_id, version) blijft daar wél uniek, dus de waarborgen
    // hierboven houden stand.
    const existing = await h.one(
        `SELECT id, version FROM project_blueprints
          WHERE solution_key = $1 AND created_by = $2
            AND (organization_id IS NOT DISTINCT FROM $3)
          FOR UPDATE`,
        [solutionKey, createdBy, organizationId],
    );

    if (existing) {
        const version = existing.version + 1;
        const bumped = { ...manifest, solution: { ...manifest.solution, version } };
        const row = await h.one(
            `UPDATE project_blueprints
                SET manifest = $1, version = $2, name = $3, description = $4, icon = $5, updated_at = NOW()
              WHERE id = $6 RETURNING *`,
            [JSON.stringify(bumped), version, manifest.solution.name || 'Solution',
             manifest.solution.description || '', manifest.solution.icon || null, existing.id],
        );
        return mapRow(row);
    }

    const scope = organizationId
        ? await h.one(`SELECT COUNT(*)::int AS n FROM project_blueprints WHERE organization_id = $1`, [organizationId])
        : await h.one(`SELECT COUNT(*)::int AS n FROM project_blueprints WHERE created_by = $1 AND organization_id IS NULL`, [createdBy]);
    if ((scope?.n || 0) >= MAX_BLUEPRINTS_PER_ORG) {
        throw new Error(`There are already ${MAX_BLUEPRINTS_PER_ORG} Blueprints here. Delete one before saving another.`);
    }

    const row = await h.one(
        `INSERT INTO project_blueprints
            (id, organization_id, created_by, source_project_id, solution_key, name, description, icon, version, manifest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [newId(), organizationId, createdBy, sourceProjectId, solutionKey,
         manifest.solution.name || 'Solution', manifest.solution.description || '',
         manifest.solution.icon || null, manifest.solution.version || 1, JSON.stringify(manifest)],
    );
    return mapRow(row);
}

// ── Publiceren: één galerijrij én één release-rij ────────────────────────────

/**
 * Publiceer dit project: bewaar (of bump) de Blueprint in de galerij ÉN noteer
 * de publicatie in de geschiedenis. Samen, of geen van beide.
 *
 * ── DE VOLGORDE, EN WELKE KANT WINT ─────────────────────────────────────────
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
 * half-afgemaakte toestand als een Blueprint zonder release-rij.
 *
 * @returns {Promise<{blueprint: object, release: object}>}
 * @param {{ organizationId?: string|null, createdBy?: string, sourceProjectId?: string, manifest?: any, notes?: string|null }} [opts]
 */
async function publishRelease({
    organizationId = null, createdBy, sourceProjectId, manifest, notes = null,
} = {}) {
    await initDB();
    // Geweigerd VÓÓR de transactie, dus vóór elke schrijfactie: een publicatie
    // zonder project heeft geen geschiedenis om in te staan, en een Blueprint
    // opslaan die daar niet in terechtkomt is precies wat hierboven verboden is.
    if (!sourceProjectId) throw new Error('sourceProjectId is required to publish a release');
    if (!createdBy) throw new Error('createdBy is required');
    if (!manifest?.solution) throw new Error('manifest is required');
    // Ook vóór de transactie: een notitie die niet opgeslagen kan worden mag
    // geen halve publicatie achterlaten, en de weigering moet actionabel zijn.
    const safeNotes = normalizeNotes(notes);

    return withTransaction(async (client) => {
        const h = handle(client);
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

/** Een notitie is een notitie: een plat object, en begrensd. */
function normalizeNotes(notes) {
    if (notes == null) return {};
    if (typeof notes !== 'object' || Array.isArray(notes)) {
        throw new Error('Release notes must be an object.');
    }
    let json;
    try { json = JSON.stringify(notes); } catch (_) { json = undefined; }
    if (typeof json !== 'string') throw new Error('Release notes must be plain JSON.');
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MAX_NOTES_BYTES) {
        const kb = (n) => `${Math.round(n / 1024)} KB`;
        throw new Error(`These release notes are ${kb(bytes)}, over the ${kb(MAX_NOTES_BYTES)} limit. Shorten the note — the Blueprint itself is stored separately.`);
    }
    return notes;
}

/**
 * Wat een release-rij naar buiten toe IS.
 *
 * Uit een EXPLICIETE ALLOW-LIST opgebouwd, niet door sleutels uit de rij te
 * verwijderen: een kolom die volgend jaar aan `project_releases` wordt
 * toegevoegd reist dan niet vanzelf mee. Het manifest blijft standaard THUIS —
 * een lijst van twintig releases zou anders twintig manifesten zijn.
 */
function mapReleaseRow(row, { includeManifest = false } = {}) {
    if (!row) return null;
    const meta = {
        id: row.id,
        projectId: row.project_id,
        blueprintId: row.blueprint_id,
        version: Number.isInteger(row.version) && row.version > 0 ? row.version : 1,
        notes: (row.notes && typeof row.notes === 'object' && !Array.isArray(row.notes)) ? row.notes : {},
        publishedAt: row.published_at,
        publishedBy: row.published_by,
    };
    if (!includeManifest) return meta;
    return { ...meta, manifest: row.manifest || null };
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
 * Snoei de geschiedenis van dit project terug tot de laatste twintig.
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
 * De publicatiegeschiedenis van één project, nieuwste eerst — zonder manifest.
 *
 * DEZE FUNCTIE AUTORISEERT NIETS. Zij scoopt op het project-id dat zij krijgt,
 * meer niet; de aanroeper moet dat id al hebben geautoriseerd (in de
 * packaging-router is dat `requireProjectRole('owner')`). Zelfde contract als
 * `listStamps` en `listInstalledVersions`, en dezelfde stille manier om het te
 * breken: een nieuwe aanroeper die er een id in gooit dat hij niet controleerde.
 */
async function listReleases(projectId, { limit = MAX_RELEASES_PER_PROJECT } = {}) {
    await initDB();
    if (typeof projectId !== 'string' || !projectId) return [];
    const asked = Number(limit);
    const capped = Math.min(Number.isFinite(asked) && asked > 0 ? Math.trunc(asked) : MAX_RELEASES_PER_PROJECT,
        MAX_RELEASES_PER_PROJECT);
    const rows = await getAll(
        `SELECT id, project_id, blueprint_id, version, notes, published_at, published_by
           FROM project_releases
          WHERE project_id = $1
          ORDER BY published_at DESC, id
          LIMIT $2`,
        [projectId, capped],
    );
    return (rows || []).map(r => mapReleaseRow(r));
}

/**
 * Eén release, mét het manifest zoals het gepubliceerd is.
 *
 * ALTIJD op (project, id) en nooit op id alleen: het id is de sleutel, maar het
 * project is de scope die de aanroeper heeft geautoriseerd. Een lookup op id
 * alleen zou een geraden id uit een ánder project beantwoorden.
 */
async function getRelease(projectId, releaseId) {
    await initDB();
    if (typeof projectId !== 'string' || !projectId) return null;
    if (typeof releaseId !== 'string' || !releaseId) return null;
    const row = await getOne(
        `SELECT id, project_id, blueprint_id, version, manifest, notes, published_at, published_by
           FROM project_releases
          WHERE id = $1 AND project_id = $2`,
        [releaseId, projectId],
    );
    return mapReleaseRow(row, { includeManifest: true });
}

/**
 * Blueprints this caller may install — meta only, never the manifests.
 * @param {{ userId?: string, organizationId?: string|null }} [opts]
 */
async function listBlueprintsFor({ userId, organizationId = null } = {}) {
    await initDB();
    const rows = await getAll(
        // META_COLUMNS en niet `*`. `mapRow(..., { includeManifest: false })`
        // gooide het manifest er daarna toch uit, dus elke lezer — de galerij,
        // de toegangsvraag, de installatieteller — trok tot honderd JSONB-blobs
        // van elk maximaal MAX_BLUEPRINT_BYTES door de pool en door de heap om
        // ze weg te gooien. De kolomlijst is dezelfde beslissing één laag lager.
        `SELECT ${META_COLUMNS} FROM project_blueprints
          WHERE (organization_id IS NOT NULL AND organization_id = $2)
             OR (organization_id IS NULL AND created_by = $1)
          ORDER BY updated_at DESC`,
        [userId, organizationId],
    );
    return rows.map(r => mapRow(r, { includeManifest: false }));
}

/**
 * De kolommen van een galerijrij MINUS het manifest.
 *
 * Bestaat zodat een lezer die alleen de meta nodig heeft (de toegangsvraag, een
 * teller) geen meerdere megabytes JSONB door de pool sleept om hem weg te
 * gooien. `mapRow(..., { includeManifest: false })` levert al dezelfde vorm; dit
 * is dezelfde beslissing één laag lager.
 */
const META_COLUMNS = `id, organization_id, created_by, source_project_id, solution_key,
                      name, description, icon, version, created_at, updated_at`;

async function getBlueprintById(id, { includeManifest = true } = {}) {
    await initDB();
    const row = await getOne(
        `SELECT ${includeManifest ? '*' : META_COLUMNS} FROM project_blueprints WHERE id = $1`,
        [id],
    );
    return mapRow(row, { includeManifest });
}

/**
 * Hoe vaak deze Blueprints OP DEZE INSTANTIE zijn geïnstalleerd: hier, en elders.
 *
 * ── Wat deze twee getallen wél zijn ────────────────────────────────────────
 *
 * Projectrijen in deze database waarvan `installed_from_blueprint_id` in de
 * meegegeven lijst staat, gesplitst op organisatie: `here` is de organisatie
 * van de Blueprint zelf, `elsewhere` is al het andere OP DEZE INSTANTIE. Dat
 * tweede getal is de hele reden dat deze functie bestaat — een Blueprint wordt
 * juist gedeeld met een ander team — en tegelijk het enige antwoord in deze
 * store dat over de org-grens heen kijkt. De partiële index
 * `idx_projects_installed_from` (stores/projectStore.js) is er precies voor.
 *
 * ── De valkuil in de vergelijking ──────────────────────────────────────────
 *
 * `projects.organization_id` is `TEXT DEFAULT ''` (createProject schrijft
 * `organizationId || ''`), terwijl `project_blueprints.organization_id` NULL
 * mag zijn. Een naïeve `=` tussen die twee matcht org-loze rijen NOOIT, en dan
 * telt elke persoonlijke installatie stilzwijgend als "elders". Vandaar aan
 * beide kanten een expliciete `COALESCE(..., '')`: leeg en NULL zijn hier
 * hetzelfde ding, namelijk "geen organisatie".
 *
 * ── Wat het NIET is, en waarom het scherm dat moet zeggen ───────────────────
 *
 * Een ONDERGRENS, nooit een totaal: een andere instantie ziet deze database
 * niet, dus wie het bestand doorstuurt naar een eigen self-host telt hier per
 * definitie niet mee. Het scherm zegt daarom "minstens n", nooit "n".
 *
 * ── Tenancy ────────────────────────────────────────────────────────────────
 *
 * DEZE FUNCTIE AUTORISEERT NIETS. Zij telt de id's die zij krijgt; de aanroeper
 * moet die al hebben geautoriseerd — zelfde contract als `listStamps`,
 * `listInstalledVersions` en `listReleases`, en dezelfde stille manier om het te
 * breken. Wat zij WEL garandeert is dat er niets anders uit kan komen dan twee
 * getallen: één COUNT-rij, geen project-id, geen naam, geen eigenaar, geen
 * organisatie, geen tijdstip. Er is hier dus geen rij om per ongeluk door te
 * geven, en geen kolom die volgend jaar aan `projects` wordt toegevoegd kan
 * meeliften. Ook geen uitsplitsing PER organisatie: bij n=1 is een aggregaat
 * over één organisatie geen aggregaat meer.
 *
 * `null` = niet te lezen. Nul installaties is een antwoord; "de telling
 * mislukte" is er geen, en die twee mogen op geen enkel scherm hetzelfde worden.
 *
 * @returns {Promise<{here:number, elsewhere:number}|null>}
 */
async function countInstallsFor(blueprintIds, { organizationId = null } = {}) {
    await initDB();
    const ids = (Array.isArray(blueprintIds) ? blueprintIds : [])
        .filter(id => typeof id === 'string' && id);
    // Geen Blueprint om op te tellen. Nul is hier een ANTWOORD en geen gat: uit
    // een id dat niet bestaat kan niemand iets geïnstalleerd hebben.
    if (!ids.length) return { here: 0, elsewhere: 0 };

    const row = await getOne(
        `SELECT COUNT(*) FILTER (WHERE COALESCE(organization_id, '') = COALESCE($2, ''))::int AS here,
                COUNT(*) FILTER (WHERE COALESCE(organization_id, '') <> COALESCE($2, ''))::int AS elsewhere
           FROM projects
          WHERE installed_from_blueprint_id = ANY($1::text[])`,
        [ids, organizationId || ''],
    );
    // GEEN kale `Number(row?.here)`: dat maakt van een ontbrekende rij en van
    // NULL allebei een keurige 0, en dan is "niemand heeft dit geïnstalleerd"
    // niet meer te onderscheiden van "de telling kwam niet terug".
    const here = asCount(row?.here);
    const elsewhere = asCount(row?.elsewhere);
    return here === null || elsewhere === null ? null : { here, elsewhere };
}

/** Een tellerwaarde, of null als het er geen is. Nooit een stilzwijgende 0. */
function asCount(raw) {
    const n = typeof raw === 'number' ? raw
        : (typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

// ── Installed-entity stamps ─────────────────────────────────────────

/** Record what an entity looked like at install time. */
async function stampEntity({ projectId, ref, kind, entityId, installHash, installedVersion = 1 }) {
    await initDB();
    await run(
        `INSERT INTO project_solution_entities (project_id, ref, kind, entity_id, install_hash, installed_version)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (project_id, ref) DO UPDATE
            SET entity_id = EXCLUDED.entity_id,
                install_hash = EXCLUDED.install_hash,
                installed_version = EXCLUDED.installed_version`,
        [projectId, ref, kind, entityId, installHash, installedVersion],
    );
}

/** Every stamp for a project, keyed by bundle-local ref. */
async function listStamps(projectId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM project_solution_entities WHERE project_id = $1`, [projectId],
    );
    return new Map(rows.map(r => [r.ref, {
        ref: r.ref, kind: r.kind, entityId: r.entity_id,
        installHash: r.install_hash, installedVersion: r.installed_version,
    }]));
}

/**
 * The version each of these Solutions has been brought to, from its own entity
 * stamps — Map(projectId → version). One query for the whole overview.
 *
 * MAX, not MIN. An upgrade re-stamps only the entities it actually replaced, so
 * a Solution installed at v3 and upgraded to v5 with one hand-edited app left
 * alone carries both numbers. The question the overview asks is "is there
 * something newer than what this has been brought to", and that is the highest.
 * MIN would answer "yes, forever" for any Solution holding one entity the
 * upgrade planner will always skip.
 *
 * A project with no stamps is ABSENT rather than 0: never installed from a
 * Blueprint, or installed by a version of this code that could not stamp. Both
 * mean "we do not know what version this is", and the overview must render that
 * as unknown — never as "up to date".
 *
 * O4 replaces this with `projects.installed_version`; the stamps are what the
 * database can already answer today, and the shape of the answer is the same.
 */
async function listInstalledVersions(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, MAX(installed_version)::int AS version
           FROM project_solution_entities
          WHERE project_id = ANY($1)
          GROUP BY project_id`,
        [ids],
    );
    return new Map((rows || [])
        .filter(r => Number.isFinite(Number(r.version)))
        .map(r => [r.project_id, Number(r.version)]));
}

/**
 * Org members may install; only the creator may delete.
 *
 * ONE RULE, AND IT IS `listBlueprintsFor`'s. That query answers: an org
 * blueprint belongs to the organisation, a personal one (org NULL) to whoever
 * captured it. This predicate used to answer something wider — it returned true
 * for `createdBy === userId` BEFORE looking at the organisation at all — and the
 * gap between the two was reachable: someone who captured a Blueprint for org A
 * and has since moved to org B could no longer see it in any list, but could
 * still read and install it by id. A permission that the list and the fetch
 * disagree about is decided by whichever one the caller happens to use.
 *
 * So the creator clause now lives where the list puts it: on personal
 * Blueprints only. A creator still inside the owning org keeps access through
 * the org clause, which is the same access every colleague has.
 * @param blueprint
 * @param {{ userId?: string, organizationId?: string|null }} [opts]
 */
function canRead(blueprint, { userId, organizationId = null } = {}) {
    if (!blueprint) return false;
    return blueprint.organizationId
        ? blueprint.organizationId === organizationId
        : blueprint.createdBy === userId;
}

async function deleteBlueprint(id, userId) {
    await initDB();
    const { rowCount } = await run(
        `DELETE FROM project_blueprints WHERE id = $1 AND created_by = $2`, [id, userId],
    );
    return rowCount > 0;
}

module.exports = {
    initDB,
    saveBlueprint,
    publishRelease,
    listReleases,
    getRelease,
    listBlueprintsFor,
    getBlueprintById,
    countInstallsFor,
    deleteBlueprint,
    canRead,
    isBlueprintId,
    stampEntity,
    listStamps,
    listInstalledVersions,
    largestEntity,
    MAX_BLUEPRINT_BYTES,
    MAX_BLUEPRINTS_PER_ORG,
    MAX_RELEASES_PER_PROJECT,
    MAX_NOTES_BYTES,
};
