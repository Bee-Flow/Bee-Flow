/**
 * Blueprint packaging — export a Solution so it can be installed elsewhere.
 *
 * ── Two gates, and why each is where it is ─────────────────────────────────
 *
 * LICENCE, on each ROUTE, not on the router. This subtree shares the
 * `/api/projects` mount, which already carries the `projects` gate. A second
 * gate cannot be applied at the mount without gating all of projects — but it
 * cannot be `router.use(requireFeature(...))` on THIS router either: a
 * path-less `use` runs for every request that reaches this router, and
 * routes/projects.js mounts it with `router.use('/', require('./packaging'))`
 * BEFORE routes that have nothing to do with packaging, `PUT
 * /:id/conversations` among them. Those requests matched no route in this
 * file, but the gate ran before Express got the chance to say so, so an org
 * with `projects` but not `blueprint_packaging` got 403 `feature_locked` on
 * work that never touches a Blueprint. Fixed the same way — and for the same
 * reason — as `large_datasets` inside the studio-apps mount
 * (routes/studioAppDatasets.js): the gate is now the first handler of each
 * route below, which is the same chain for these routes and none for
 * anybody else's. featureMap.js documents the pairing.
 *
 * OWNER, per route. Export reads EVERY member of the project, including apps
 * and automations belonging to other members. Editor is not enough for that: an
 * editor can file their own work in and out, which is a different thing from
 * taking a copy of everyone's. The project's owner decides whether the Solution
 * leaves.
 *
 * Bodies are checked by closed schemas in ./schemas.js (validate()).
 *
 * Mounted from routes/projects.js, mirroring the routes/automation.js +
 * routes/automation/ pair the repo already proves.
 */

'use strict';

const express = require('express');
const { requireFeature } = require('../../license/middleware');
const { requireProjectRole } = require('../../auth/projectAccess');
const { captureSolution } = require('../../projects/packaging/capture');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { contentDisposition } = require('../../core/http/contentDisposition');
const publication = require('../../projects/packaging/publication');
const S = require('./schemas');

const router = express.Router({ mergeParams: true });

// The whole subtree is a paid capability on top of `projects` — applied to
// each route below, never to the router (see the header).
const blueprintPackaging = requireFeature('blueprint_packaging');

/**
 * Packaging is for Studio Solutions. A collaborative project
 * (`kind: 'workspace'`) has no Blueprint to export, upgrade from or count
 * installs of, so every `/:id/package/*` route answers it exactly as it
 * answers a project that does not exist: 404, the same no-probing rule the
 * role gate follows. A legacy project (kind null) keeps working until its
 * owner classifies it. Runs after the role gate and the body schema, so a
 * stranger still gets the gate's 404 and a refused body never reaches a
 * store.
 *
 * A Solution STAGE (UAT or Production, `project.stage` set) answers 404 too:
 * it is a locked copy of a Dev Solution and changes only through a
 * deployment, so it is never exported, upgraded or counted on its own.
 */
async function requireSolutionProject(req, res, next) {
    const project = await require('../../stores/projectStore').getProject(req.params.id);
    if (!project || project.kind === 'workspace' || project.stage) return res.status(404).json({ error: 'Not found' });
    next();
}

/**
 * POST /:id/package/export — capture this project as a Blueprint.
 *
 * Returns the manifest as JSON rather than a download: what the caller does
 * with it (save, install elsewhere, diff against a previous version) is not
 * this route's business, and a JSON body is the only shape all three want.
 *
 * THE PUBLISH GATE IS HERE, ON THE SERVER. With `save: true` the completeness
 * aggregate runs first (projects/packaging/publication.js `releaseGate`), and
 * a blocked verdict — including "could not check" — is a 409
 * `release_blocked` carrying the findings: nothing is captured or published.
 * A plain download is never refused by the gate; it carries the verdict in
 * `_checks` so the caller can say what an installer would run into.
 */
router.post('/:id/package/export', blueprintPackaging, requireProjectRole('owner'), validate({ body: S.ExportBody }), requireSolutionProject, require('../../compliance/dataPortability/stampExport')('solutions'), async (req, res) => {
    const projectStore = require('../../stores/projectStore');
    const project = await projectStore.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });

    const save = req.body?.save === true;
    const verdict = await publication.releaseGate(project);
    if (save && verdict.blocked) {
        throw new HttpError(409, 'release_blocked',
            'This Solution has findings that block publishing. Resolve them, then publish again.',
            { findings: verdict.findings, unavailable: verdict.unavailable });
    }

    // Stamped by the caller so capture stays a pure function of the
    // database's state and two runs can be compared.
    const exportedAt = new Date().toISOString();
    // A publication names every part by its ledger ref (F1), so an
    // installed copy's stamps match the right part on the next upgrade
    // however the store orders the list. A download is not a publication
    // and leaves the ledger alone.
    const result = save
        ? await captureWithLedger(project, exportedAt)
        : await captureSolution({ project, exportedAt });
    if (!result.ok) return res.status(400).json({ error: result.errors.join(' ') });

    // `save` keeps it on the instance so another team can install it
    // without a file passing through anyone's downloads folder. Opt-in,
    // because a download is the more private default and the size ceiling
    // only applies to what is stored.
    //
    // PUBLISHING, not just saving (O4). `publishRelease` writes the gallery
    // row and the history row in one transaction — see its header for why a
    // failed history row must take the gallery row down with it, rather
    // than leaving a version that nobody can find back.
    //
    // The note comes from the server, never from the request (see
    // `releaseNotesFor`): a diff is the server's statement about two
    // manifests, and the export schema refuses a `notes` key.
    let saved = null;
    if (save) {
        try {
            const store = require('../../stores/blueprintStore');
            const notes = await publication.releaseNotesFor({
                store, project, userId: req.session.user.id, manifest: result.manifest,
            });
            const published = await store.publishRelease({
                organizationId: project.organizationId || null,
                createdBy: req.session.user.id,
                sourceProjectId: project.id,
                manifest: result.manifest,
                notes,
            });
            saved = published.blueprint;
            await publication.announcePublication(project.id, req.session.user.id);
        } catch (err) {
            // The capture succeeded; only publishing it failed. Hand back
            // the manifest anyway so the download still works, and say why.
            return res.json({ ...result.manifest, _saveError: err.message });
        }
    }

    // ── The provenance block, stamped on what the caller receives ──────
    //
    // HERE and not in `captureSolution`, for two reasons that are both
    // about order: the Blueprint id exists only once publishing succeeded,
    // and the organisation's name is nothing a capture should read — it
    // only knows the project.
    //
    // Without a publication `blueprintId` stays null. That is the honest
    // value: a downloaded file that was never published belongs to no
    // gallery row and must not point at one.
    //
    // What goes into this block is only the EXPORTING organisation's own
    // identity — no person, no reader list, no data from another project.
    // See the header of `readSource` in packaging/manifest.js.
    const source = {
        blueprintId: saved?.id || null,
        orgId: project.organizationId || null,
        orgName: await organizationNameFor(project.organizationId),
        version: saved?.version || result.manifest?.solution?.version || 1,
    };
    const { withSource } = require('../../projects/packaging/manifest');
    res.json(saved
        ? { ...withSource(saved.manifest, source), _savedAs: saved.id, _version: saved.version }
        : { ...withSource(result.manifest, source), _checks: publication.checksForDownload(verdict) });
});

/**
 * The ledger refs of a Solution's parts, for a gallery publication (F1).
 *
 * Positional refs over store order moved every ref after a part that was
 * added, removed or re-sorted, and an upgrade then REPLACED the wrong
 * installed entity. The ledger (`blueprintStore.allocateRefs`) gives a part
 * its ref once and never hands a retired one out again. The kind is the
 * manifest section with its REF_PREFIX, so a first allocation numbers parts
 * exactly as the old positional refs did. `kinds: ENTITY_KINDS`: a gallery
 * publication retires only parts of the six sections it speaks for.
 *
 * NO FALLBACK: once a Solution has ledger rows, positional refs disagree with
 * earlier releases and an upgrade writes one part over another. A ledger that
 * cannot be written refuses the publication (503 `ref_ledger_unavailable`).
 */
async function galleryRefsFor(project, ENTITY_KINDS, REF_PREFIX) {
    const members = await require('../../projects/packaging/capture').loadMembers(project.id);
    const list = ENTITY_KINDS.flatMap(kind => (Array.isArray(members?.[kind]) ? members[kind] : [])
        .filter(e => e && typeof e.id === 'string' && e.id).map(e => ({ kind, entityId: e.id })));
    try {
        return await require('../../stores/blueprintStore').allocateRefs(project.id, list,
            { prefixOf: (kind) => REF_PREFIX[kind], kinds: [...ENTITY_KINDS] });
    } catch (err) {
        log.error('[Projects] Blueprint ref ledger unavailable, publication refused:', err.message);
        throw new HttpError(503, 'ref_ledger_unavailable',
            'The part references of this Solution could not be recorded, so nothing was published. Try again later.');
    }
}

/**
 * Capture for a publication, every part named by a ledger ref. Capture reads
 * the members again after the ledger did; a part added in between would get a
 * ref past the ones handed over (possibly a RETIRED one, never recorded). So
 * every captured ref must be an allocated one, else allocate and capture once
 * more; still changing: 409 `solution_changed`, nothing published.
 */
async function captureWithLedger(project, exportedAt) {
    const { ENTITY_KINDS, REF_PREFIX } = require('../../projects/packaging/manifest');
    for (let attempt = 1; ; attempt++) {
        const refs = await galleryRefsFor(project, ENTITY_KINDS, REF_PREFIX);
        const result = await captureSolution({ project, exportedAt, refs });
        const allocated = new Set(refs.values());
        const entities = result.manifest?.solution?.entities || {};
        const complete = ENTITY_KINDS.every(kind => (Array.isArray(entities[kind]) ? entities[kind] : [])
            .every(e => allocated.has(e?.ref)));
        if (!result.ok || complete) return result;
        if (attempt >= 2) throw new HttpError(409, 'solution_changed', 'This Solution changed while it was being published. Publish again.');
        log.warn(`[Projects] a part of ${project.id} arrived during publication; capturing again`);
    }
}

/**
 * The name of an organisation, or null.
 *
 * NEVER THROW: an export may not break because the organisation name could not be read. Null is moreover no loss — the name is courtesy towards the recipient, not a bearing field: the `orgId` is kept separately, and even that decides nothing.
 */
async function organizationNameFor(organizationId) {
    if (typeof organizationId !== 'string' || !organizationId) return null;
    try {
        const org = await require('../../stores/userStore').getOrganization(organizationId);
        return typeof org?.name === 'string' && org.name ? org.name : null;
    } catch (err) {
        log.warn('[Projects] could not read the organisation name for a Blueprint:', err.message);
        return null;
    }
}

/**
 * A Blueprint, from wherever the caller has one.
 *
 * Either a file they uploaded, or one saved on this instance. Resolving a saved
 * id server-side rather than letting the client hand the manifest back means
 * the bytes that were stored are the bytes that get used.
 *
 * A pipeline release (Solution stages) is never a source: it does not leave
 * the instance and reaches a stage only through a deployment, so a manifest
 * that declares `channel: 'pipeline'` is refused with 400 `pipeline_release`.
 */
async function resolveManifest(req) {
    const resolved = await resolveManifestSource(req);
    if (!resolved.error && publication.isPipelineManifest(resolved.manifest)) {
        throw new HttpError(400, 'pipeline_release',
            'A pipeline release cannot be installed or used to upgrade a Solution. Deploy it to a stage instead.');
    }
    return resolved;
}

async function resolveManifestSource(req) {
    const { manifest, blueprintId } = req.body || {};
    if (blueprintId) {
        const store = require('../../stores/blueprintStore');
        const found = await store.getBlueprintById(blueprintId);
        const readable = store.canRead(found, {
            userId: req.session?.user?.id,
            organizationId: req.session?.user?.organizationId || null,
        });
        if (!found || !readable) return { status: 404, error: 'Not found' };
        // The id travels with the manifest so that an install can record where the
        // Solution came from. Only the RESOLVED one: the caller's own
        // `blueprintId` is echoed nowhere, so a project can never claim
        // provenance from a Blueprint this caller could not read.
        //
        // `blueprintOrgId` comes from the GALLERY ROW and not from the manifest: on this path
        // the server has read the source itself, which is something other than what a file claims about itself. install.provenanceOf always lets the
        // established value win over the claimed one.
        return { manifest: found.manifest, blueprintId: found.id, blueprintOrgId: found.organizationId || null };
    }
    if (!manifest) return { status: 400, error: 'No Blueprint in the request.' };
    // A file: no established provenance. What the manifest says about itself
    // is only read in the installer, and there it is treated as an assertion.
    return { manifest, blueprintId: null, blueprintOrgId: null };
}

/**
 * Which entity kinds this caller's plan allows.
 *
 * Resolved once per kind rather than per entity, by the same rule requireFeature
 * enforces — a second implementation of "does this org have X" would eventually
 * disagree with the middleware.
 */
// The licence features the installer gates entity kinds on. Exported so the
// drift test can compare it against the `ctx.can(...)` calls in the installer.
const INSTALLER_FEATURES = ['app_studio', 'webpages', 'automations'];

async function capabilityPredicate(req) {
    const { featureAllowedForRequest } = require('../../license/middleware');
    const granted = new Map();
    // EVERY feature the installer asks about must be listed here. The predicate
    // ends in `granted.get(feature) === true`, so a name that was never fetched
    // reads as DENIED — which is the safe direction, but it means a missing
    // entry silently disables a whole entity kind instead of failing loudly.
    // That is exactly what happened to datatables: install.js gates them on
    // 'automations' (the licence feature /api/datatables itself uses), the name
    // was not in this list, and every table in a Blueprint was skipped at both
    // install and upgrade with "Tables are not part of this plan."
    // packaging.capabilities.test.js keeps the two in step.
    for (const feature of INSTALLER_FEATURES) {
        try {
            granted.set(feature, (await featureAllowedForRequest(req, feature)).allowed);
        } catch { granted.set(feature, false); }
    }
    return (feature) => granted.get(feature) === true;
}

/**
 * May this Blueprint upgrade this project at all?
 *
 * Two refusals, both decided against what the server itself recorded:
 *
 *   - 409 `different_solution`: the project was installed from a Blueprint
 *     whose gallery row names another `solution_key` than this manifest. The
 *     comparison uses the row `installed_from_blueprint_id` points to (that
 *     column names a Blueprint, not a release). When that row is gone (a
 *     deleted gallery entry, or a file install that claimed none) there is
 *     nothing to compare with: the upgrade proceeds and its result carries the
 *     warning `source_unverified`.
 *   - 409 `not_newer`: the manifest's version is not above the installed one
 *     (`isNewer`). Re-applying the same version is churn, and an older one is
 *     a downgrade nobody asked for.
 *
 * Both compare against the CHECKED manifest (`checkedUpgradeManifest`), never
 * the caller's raw body: a file without a `solution` or with a version that is
 * no integer would otherwise be refused as `different_solution` or
 * `not_newer`, which names the wrong problem.
 *
 * @returns {Promise<{warnings:string[]}>}
 */
async function checkUpgradeSource(projectId, manifest) {
    const project = await require('../../stores/projectStore').getProject(projectId);
    if (!project) throw new HttpError(404, 'not_found', 'Not found');

    const warnings = [];
    const sourceId = project.installedFromBlueprintId || null;
    const source = sourceId
        ? await require('../../stores/blueprintStore').getBlueprintById(sourceId, { includeManifest: false })
        : null;
    if (!source) {
        warnings.push('source_unverified');
    } else if (source.solutionKey !== manifest?.solution?.key) {
        throw new HttpError(409, 'different_solution',
            'This Blueprint is a different Solution from the one this project was installed from.');
    }

    const { isNewer } = require('../../projects/packaging/upgrade');
    const blueprintVersion = Number(manifest?.solution?.version);
    const installedVersion = Number.isInteger(project.installedVersion) ? project.installedVersion : null;
    if (!isNewer({ installedVersion, blueprintVersion })) {
        throw new HttpError(409, 'not_newer',
            'This Blueprint is not newer than the version this Solution runs.',
            { installedVersion, blueprintVersion: Number.isFinite(blueprintVersion) ? blueprintVersion : null });
    }
    return { warnings };
}

/**
 * The manifest as the upgrade engine will read it, or a 400 that says what is
 * wrong with the file.
 *
 * The same `sanitizeManifest` planUpgrade/applyUpgrade run, run FIRST so the
 * source and version checks never reason about a file that is not a Blueprint.
 * The engines sanitise again on their own input; that is idempotent.
 */
function checkedUpgradeManifest(manifest) {
    const { sanitizeManifest } = require('../../projects/packaging/manifest');
    const checked = sanitizeManifest(manifest);
    if (!checked.ok) throw new HttpError(400, 'invalid_blueprint', checked.errors.join(' '));
    return checked.manifest;
}

/** The result with the source check's warnings added, when there are any. */
function withSourceWarnings(result, { warnings }) {
    if (!warnings.length) return result;
    return { ...result, warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), ...warnings] };
}

/**
 * POST /:id/package/upgrade/plan — what a newer Blueprint would change here.
 *
 * Separate from applying, and deliberately: "3 will be updated, 1 you have
 * edited will be left alone" is a decision, and an upgrade that only tells you
 * afterwards is not offering one. Owner, like every packaging action on a
 * project — an upgrade rewrites other members' entities.
 */
router.post('/:id/package/upgrade/plan', blueprintPackaging, requireProjectRole('owner'), validate({ body: S.UpgradeBody }), requireSolutionProject, async (req, res) => {
    const resolved = await resolveManifest(req);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const checked = await checkUpgradeSource(req.params.id, checkedUpgradeManifest(resolved.manifest));

    const { planUpgrade } = require('../../projects/packaging/upgrade');
    const result = await planUpgrade({ projectId: req.params.id, manifest: resolved.manifest });
    if (!result.ok) return res.status(400).json({ error: result.errors.join(' ') });
    res.json(withSourceWarnings(result, checked));
});

/** POST /:id/package/upgrade — apply it. Replaces the untouched, keeps the rest. */
router.post('/:id/package/upgrade', blueprintPackaging, requireProjectRole('owner'), validate({ body: S.UpgradeBody }), requireSolutionProject, async (req, res) => {
    const resolved = await resolveManifest(req);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const checked = await checkUpgradeSource(req.params.id, checkedUpgradeManifest(resolved.manifest));

    const { applyUpgrade } = require('../../projects/packaging/upgrade');
    const result = await applyUpgrade({
        projectId: req.params.id,
        manifest: resolved.manifest,
        ownerId: req.session.user.id,
        organizationId: req.session?.user?.organizationId || null,
        can: await capabilityPredicate(req),
        // Only the knowledge-base kind reads this, and only to ask "may
        // this person read this base" before it is linked into a project.
        req,
    });
    if (!result.ok) return res.status(400).json({ error: result.errors.join(' ') });
    res.json(withSourceWarnings(result, checked));
});

/**
 * GET /:id/package/releases — the publication history of this Solution.
 *
 * The gallery row (`project_blueprints`) is OVERWRITTEN with every publication and is therefore a statement about the present: "this is what can be installed
 * today". `project_releases` is the history, one immutable row per publication, and this is the only route that brings it outward.
 *
 * OWNER, and not lower. That is not the gate of "who may see this project" but of "who may see what this project has ever issued": a release row
 * states per entity what changed, so whoever reads the history reads a table of contents of every version that has ever existed — including entities that are no longer in it. The same role as exporting, for the same reason.
 * The header of `listReleases` in stores/blueprintStore.js names this gate explicitly: that function authorises nothing itself.
 *
 * ── THE MANIFEST STAYS AT HOME ──────────────────────────────────────────
 *
 * `listReleases` already returns the rows without the manifest, and this route narrows them further to the four fields that the screen reads. Written out by hand,
 * not with keys-removed: a column that is added to `project_releases` next year will not reach the client automatically that way.
 *
 * `publishedBy` deliberately falls outside that. It is a user id, the screen shows no names (it does not load the member list, see SolutionDetail), and an
 * id to which nobody can attach a name is just an id that travels around.
 *
 * `notes` DOES go along and is the point of this route: that is where the boolean diff per entity sits, plus — if the model was able to write it — one line per
 * changed entity. The diff is always there; the line may be missing, and the Versions tab keeps those two apart.
 */
router.get('/:id/package/releases', blueprintPackaging, requireProjectRole('owner'), requireSolutionProject, async (req, res) => {
    // A failed read rejects to a 500, never `{ releases: [] }`: an empty list
    // reads as "this Solution was never published".
    const releases = await require('../../stores/blueprintStore').listReleases(req.params.id);
    res.json({
        releases: (releases || []).map(r => ({
            id: r.id,
            version: r.version,
            notes: r.notes,
            publishedAt: r.publishedAt,
        })),
    });
});

/**
 * GET /:id/package/releases/:releaseId — one published version, manifest and
 * all; `?download=1` hands the manifest over as a Blueprint file.
 *
 * Owner, like the history it is one row of. Looked up on (project, release)
 * through `getRelease`, never on the release id alone, so a guessed id from
 * another project answers 404.
 *
 * A PIPELINE release (Solution stages) answers 404 as if it did not exist: it
 * never leaves the instance (it reaches a stage only through a deployment).
 *
 * The answer is an allow-list, like the history listing: no `publishedBy`, no
 * `blueprintId`, and nothing a future column would add on its own. The
 * DOWNLOAD is a Blueprint file and carries the provenance block the export
 * route stamps (Blueprint id, exporting organisation, version), so an install
 * from it can be tied back to its gallery row.
 */
router.get('/:id/package/releases/:releaseId', blueprintPackaging, requireProjectRole('owner'), validate({ query: S.ReleaseQuery }), requireSolutionProject, async (req, res) => {
    // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- the response is a JSON attachment (application/json), never HTML
    const release = await require('../../stores/blueprintStore').getRelease(req.params.id, req.params.releaseId);
    if (!release || release.channel === 'pipeline') throw new HttpError(404, 'not_found', 'Not found');

    if (req.query.download === '1') {
        const name = String(release.manifest?.solution?.name || 'solution')
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'solution';
        // The provenance block, stamped exactly as the export route stamps it:
        // without `source.blueprintId` a file installed elsewhere records no
        // `installed_from_blueprint_id`, and every later upgrade of it skips
        // the different_solution check (source_unverified). The Blueprint id
        // travels only in the FILE; the JSON answer below keeps it out.
        // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- builds a JSON attachment (application/json), never HTML
        const project = await require('../../stores/projectStore').getProject(req.params.id);
        const { withSource } = require('../../projects/packaging/manifest');
        const file = withSource(release.manifest ?? null, {
            blueprintId: release.blueprintId || null,
            orgId: project?.organizationId || null,
            orgName: await organizationNameFor(project?.organizationId),
            version: release.version,
        });
        // Quoted filename (+ RFC 5987 filename*) like every other download route;
        // res.attachment() stopped quoting token-safe names with Express 5.3.
        res.setHeader('Content-Disposition', contentDisposition(`${name}-v${release.version}.blueprint.json`));
        res.type('application/json');
        // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- a JSON file sent as an attachment with an application/json type; nothing is rendered as HTML
        return res.send(JSON.stringify(file, null, 2));
    }
    res.json({
        release: {
            id: release.id,
            version: release.version,
            notes: release.notes,
            publishedAt: release.publishedAt,
            manifest: release.manifest ?? null,
        },
    });
});

/**
 * GET /:id/package/installs — how often this Solution has been installed.
 *
 * Two numbers: in the own organisation, and elsewhere on this instance. Nothing
 * else.
 *
 * ── The only exception to the org scoping, and how narrow it is ──────────
 *
 * Blueprints are strictly org-scoped. This is the only answer that looks across that boundary, because a Blueprint is shared precisely with another team and the maker is entitled to know THAT something is being done with it. The exception is therefore made so small that nothing else can come out of it:
 *
 *   • ONLY THE SOURCE. `requireProjectRole('owner')` on the project where the Blueprint was made — the same gate as exporting, and therefore by definition
 *     someone from the source organisation. An installer elsewhere cannot reach this route for that Blueprint: he is not an owner of this project.
 *   • WHICH BLUEPRINTS BELONG HERE comes from `listBlueprintsFor` — the ONE org-scoping query of the store (see the header of `canRead`). There is no second reading here that
 *     could disagree with that query; what the reader does not see in his gallery, he does not count here either.
 *   • THE PAYLOAD IS AN ALLOW-LIST of two numbers. No project id, no name, no owner, no
 *     organisation name, no timestamp, and no breakdown per organisation — with n=1 an aggregate over one organisation is no longer an aggregate.
 *
 * ── What this number CANNOT see, and that is the honest limit ───────────
 *
 * Only this database. A file that someone installs on his own self-host is by definition invisible, so the screen says "at least n" and
 * never "n" (SolutionInstallsTab.jsx adds that sentence unconditionally).
 *
 * WHICH IDS COUNT — and why the gallery alone is not enough. If the maker throws away his Blueprint, it disappears from `listBlueprintsFor` while the
 * projects installed from it simply keep existing, with their `installed_from_blueprint_id`. With the gallery list alone it would say, firmly, "nobody has installed this" —
 * the answer on which someone decides to throw away a Solution. That is why the ids come from the gallery AND from the project's own publication history
 * (`listReleases`, scoped to exactly the project id that the gate above has authorised). Both sources already belong to this reader; no id is added from another
 * organisation.
 *
 * The limit of that is honest and stays on the safe side: the history keeps the last twenty publications, so a deleted Blueprint of which
 * ALL release rows have also been pruned falls out of the count after all. That makes the number lower, never higher — and the screen says "at least".
 *
 * ZERO REMAINS AN ANSWER THEREBY: no gallery row and not a single release row means that this project has never been published, and then "zero installs"
 * is not a gap but a fact. A failed read is not that, and that one ends in the 500 below — the screen then says "not readable", not "zero".
 */
router.get('/:id/package/installs', blueprintPackaging, requireProjectRole('owner'), requireSolutionProject, async (req, res) => {
    const projectStore = require('../../stores/projectStore');
    const project = await projectStore.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });

    const store = require('../../stores/blueprintStore');
    const readable = await store.listBlueprintsFor({
        userId: req.session?.user?.id,
        organizationId: req.session?.user?.organizationId || null,
    });
    // De Blueprints die uit DIT project komen. `solution_key` is
    // `sol_<projectId>` (packaging/manifest.buildManifest), en de serie loopt
    // per maker — twee collega's die hetzelfde project publiceren hebben elk
    // hun eigen rij, en beide tellen mee.
    const ids = new Set((readable || [])
        .filter(b => b?.solutionKey === `sol_${project.id}`)
        .map(b => b.id));

    // …plus every Blueprint under which this project has ever been published.
    // Without this second source a deleted gallery row would read as "zero
    // installs". NO catch: if the history cannot be read, the count is unknown and that should
    // reach the screen as a 500, not as zero.
    for (const release of (await store.listReleases(project.id)) || []) {
        if (typeof release?.blueprintId === 'string' && release.blueprintId) ids.add(release.blueprintId);
    }

    // "Here" is the organisation of the Blueprint itself, and that is that of the
    // project it comes from — not that of the session. For the owner of this project those are the
    // same, except when the project has at some point changed organisation; then the question "how many here" is a
    // question about where the Solution belongs NOW.
    const counted = await store.countInstallsFor([...ids], { organizationId: project.organizationId || null });

    // Twee velden, met de hand opgeschreven. Niets van een projectrij en
    // niets van een galerijrij reist mee.
    res.json({
        installsHere: counted ? counted.here : null,
        installsElsewhere: counted ? counted.elsewhere : null,
    });
});

/**
 * POST /package/install — install a Blueprint as a NEW Solution.
 *
 * Not under `/:id`: installing creates a project rather than acting on one, so
 * there is no project to hold a role on. The licence gate above still applies,
 * and the caller must be able to create a project at all — which the
 * `/api/projects` mount's own gate already decides.
 *
 * Capabilities are passed to the installer as a predicate rather than checked
 * up front, because a Blueprint carrying apps must still install its automations
 * on a plan without App Studio. Refusing the whole thing would make a
 * partly-usable Solution unusable.
 */
router.post('/package/install', blueprintPackaging, validate({ body: S.InstallBody }), async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const resolved = await resolveManifest(req);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { manifest, blueprintId, blueprintOrgId } = resolved;
    const { name, resolutions } = req.body || {};

    const { installBlueprint } = require('../../projects/packaging/install');
    const organizationId = req.session?.user?.organizationId || null;
    const can = await capabilityPredicate(req);

    const result = await installBlueprint({
        // What the install wizard's Connect step collected: which table a
        // step should use, which HTTP credential, who approves. Handed
        // over raw — projects/packaging/resolutions.js is the one place
        // that decides what a resolutions body may contain, so a second
        // shape check here could only disagree with it.
        manifest, ownerId: userId, organizationId, name, blueprintId, blueprintOrgId,
        can, req, resolutions,
    });
    if (!result.ok) return res.status(400).json({ error: result.errors.join(' ') });

    res.json({ projectId: result.projectId, report: result.report });
});

/**
 * GET /package/blueprints — the Blueprints this caller could install.
 *
 * Meta only. A gallery is a list of things to choose from; the manifests are
 * multi-megabyte JSONB and nothing on the list screen reads them.
 */
router.get('/package/blueprints', blueprintPackaging, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const blueprints = await require('../../stores/blueprintStore').listBlueprintsFor({
        userId, organizationId: req.session?.user?.organizationId || null,
    });
    res.json({ blueprints });
});

/**
 * GET /package/blueprints/:blueprintId — one Blueprint, manifest and all.
 *
 * The listing above is meta only, which is right for a gallery and wrong for
 * the install wizard: its first step says what is in the file and its second
 * says what the recipient has to connect, and both of those are read off the
 * manifest. Without this route a gallery install had to be a leap of faith
 * while a file install got the whole preview — the same act, two honesty
 * levels, decided by where the bytes happened to be.
 *
 * Gated by `canRead`, the same predicate resolveManifest uses before it will
 * install one: same-org, or the creator of a personal one. Reading a Blueprint
 * you may install is not a wider permission than installing it.
 */
router.get('/package/blueprints/:blueprintId', blueprintPackaging, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const store = require('../../stores/blueprintStore');
    const found = await store.getBlueprintById(req.params.blueprintId);
    const readable = store.canRead(found, {
        userId, organizationId: req.session?.user?.organizationId || null,
    });
    // One answer for "no such Blueprint" and "not yours to read", so this
    // route cannot be used to discover which ids exist in other orgs.
    if (!found || !readable) return res.status(404).json({ error: 'Not found' });

    res.json({ blueprint: found });
});

/** DELETE /package/blueprints/:blueprintId — creator only. */
router.delete('/package/blueprints/:blueprintId', blueprintPackaging, async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const ok = await require('../../stores/blueprintStore').deleteBlueprint(req.params.blueprintId, userId);
    if (!ok) return res.status(404).json({ error: 'Not found, or not yours to delete' });
    res.json({ success: true });
});

module.exports = router;
module.exports.INSTALLER_FEATURES = INSTALLER_FEATURES;
