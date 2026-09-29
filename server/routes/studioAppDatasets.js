/**
 * App Studio v2 — LARGE DATASET upload/status router (multi-GB genome files).
 *
 * Mounted at /api/studio-apps ALONGSIDE the other studio routers (inherits the
 * app_studio capability gate at the mount); additionally gated, route by
 * route, on the `large_datasets` licence feature. Session-auth only.
 *
 * Endpoints (see the manifest store for the SQL-enforced state machine):
 *   POST   /:id/large-datasets                      — init: quotas → manifest row + multipart upload
 *   PUT    /:id/large-datasets/:datasetId/parts/:n  — one raw 32 MB part; SEQUENTIAL (409 + expected on a gap)
 *   POST   /:id/large-datasets/:datasetId/complete  — assemble; the ingest job takes it from there
 *   GET    /:id/large-datasets                      — list (status polling)
 *   GET    /:id/large-datasets/:datasetId           — single (status polling)
 *   DELETE /:id/large-datasets/:datasetId           — abort/remove + artifact cleanup
 *
 * ── SECURITY MODEL (mirrors routes/studioAppFiles.js) ────────────────
 *   • Visibility: owner always; else is_published + canReadStudioApp; every
 *     miss is a uniform 404.
 *   • Upload is a WRITE into the OWNER's storage envelope: owner, or a viewer
 *     whose role may create/update somewhere (attachmentAccess.
 *     roleMayWriteSomewhere — the same rule the attachment uploader applies).
 *   • Manifest reads are owner-scoped in SQL: a foreign datasetId can never
 *     resolve (IDOR-proof like the attachment ledger).
 *   • AV policy is parse-and-rewrite ('structural') — the head sniff here is
 *     an intake courtesy; the real gate is the ingest job, which refuses
 *     anything that does not parse as coordinate-sorted VCF.
 *
 * ── A dataset is its uploader's (appStudio/datasetAccess.js) ────────────
 * The owner's envelope holds the bytes, but a genome file is the person's who
 * uploaded it. So, route by route:
 *   • list and single: the caller's OWN uploads, for everyone, the owner
 *     included. Another person's dataset is the same 404 as a missing one.
 *   • parts and complete: the uploader only. Not the owner either: writing
 *     into someone's file changes what they will later query as their genome.
 *   • delete: the uploader, or the owner, whose storage it occupies. Removing
 *     is not reading.
 *   • query (dataset_query, the AI steps' query_genome_dataset tool): the
 *     uploader only, checked in datasetQueryStep.resolveReadyDataset against
 *     the person the step runs as.
 *   • quota: the file ceiling (MAX_FILES_PER_APP) counts the caller's own
 *     datasets in this app, because a member may delete only their own: counted
 *     per app, one member's uploads told everybody else "delete one first"
 *     about files they could neither see nor delete. The byte ceiling stays
 *     the owner's, across their apps, because it is their storage.
 * This became urgent on 2026-09-23. Until then no large dataset could exist
 * (see "Why /large-datasets" below), and the rule was owner-scoped only: once a
 * member's upload worked, every other member with a role in the app could
 * list it, poll it, pick it and query its variants.
 *
 * ── The licence gate sits on each ROUTE, not on the router ──────────────
 * It was `router.use(requireFeature('large_datasets'))`. A path-less use runs
 * for every request that REACHES this router, and this router shares the
 * /api/studio-apps mount with the ones after it in server/index.js — so
 * studioAppBrowse.js's POST /:id/actions/:actionId/step/stream answered 403
 * `feature_locked: large_datasets` to every org whose plan grants app_studio
 * but not large datasets: an AI-browse step that had nothing to do with
 * genome files could never run for them. The gate is now the first handler
 * of each route below, which is the same chain for these routes and none
 * for anybody else's.
 *
 * ── What a caller may send ──────────────────────────────────────────────
 * Every path param, query and JSON body is `.strict()`. The part upload's
 * body stays OPEN: it is the raw bytes of the part (datasetPartBody), sized
 * and sniffed by the handler. What the schemas closed, each under a 200:
 *   • `bytes: true` was Number(true) = 1 — a one-byte dataset whose single
 *     part then had to be exactly one byte; `bytes: "12"` and `[12]` passed too.
 *   • `name: {…}` made a dataset called "[object Object]", and a name was
 *     stored at any length up to the global 20 MB body cap: the JSON parser in
 *     index.js reads the body before this route's 16kb express.json() runs.
 *   • `PUT …/parts/1abc` stored part 1 — parseInt read the digits and
 *     dropped the rest.
 *   • `{"sha256": …}` on /complete was ignored, and the upload was declared
 *     'uploaded' to a client that believed it had asked for a check.
 * And one 500 is a 400 now: the manifest id column is a UUID, so any other
 * dataset id made Postgres throw and the route answer "Could not …".
 *
 * ── Why /large-datasets, and not /datasets ─────────────────────────────
 * Until 2026-09-23 these routes sat on /:id/datasets, and so did the BI
 * "saved aggregate" datasets of routes/studioAppData.js, mounted before this
 * router on the same /api/studio-apps prefix. Express answers with the first
 * route that matches, so the BI router took init, list and delete: the
 * client's init POST made an empty BI dataset named after the genome file
 * (owner) or got a 403 (viewer), came back without a datasetId, and the
 * parts and the complete then went to …/datasets/undefined/… and were
 * refused. No large dataset was ever uploaded, listed or deleted.
 *
 * One of the two had to move, and the count of callers decided which:
 *   • BI, /:id/datasets — three agent-hub files, six call sites:
 *     bi/useDatasets.js (list, create, update, delete), flow/
 *     useStepReferences.js (list, for the step pickers) and the public demo's
 *     fixture (demo/fixtures/appStudio.js). Working in production.
 *   • Large, this router — two agent-hub files, five call sites:
 *     runtime/useDatasetUpload.js (init, part, complete) and runtime/
 *     components/AppDatasetUpload.jsx (list, single); plus the key in
 *     license/featureMap.js. Never reachable end to end.
 *   • mobile/ and nextcloud-connector/ call neither, and no server code calls
 *     either over HTTP: dataset_query and /data/query read the stores.
 * Fewer callers, and none of them working: moving this side breaks nothing
 * that ran, while moving BI would have changed a live contract for a saving
 * of one call site. BI keeps /:id/datasets unchanged.
 *
 * The move changed one more gate, on purpose. requireTraining('apps') on the
 * /api/studio-apps mount locks the AUTHORING writes, and its pattern names
 * `datasets`: the BI saved datasets an author defines in the builder. On the
 * shared path it locked these uploads too, as if uploading your genome file
 * into a running app were building one. On /large-datasets they are runtime,
 * like /:id/files, and not training-gated; learning/trainingGates.test.js
 * pins both sides.
 *
 * routes/studioAppDatasets.mount.test.js mounts both routers in index.js's
 * order and reversed, and pins that each answers its own paths.
 */

const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const log = require('../telemetry/log');
const { validate } = require('../core/http/validate');
const router = express.Router();

const studioAppStore = require('../stores/studioAppStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const storageStore = require('../stores/storageStore');
const datasetFileStore = require('../stores/datasetFileStore');
const rlsGateway = require('../appStudio/rlsGateway');
const attachmentAccess = require('../appStudio/attachmentAccess');
const { isUploaderOf } = require('../appStudio/datasetAccess');
const { datasetPartBody, sniffDatasetHead } = require('../middleware/datasetUploadGuard');
const { requireAuth } = require('../auth/permissions');
const { requireFeature } = require('../license/middleware');
const { resolveAudienceContext } = require('../auth/audience');
const {
    datasetInitLimiter, datasetPartLimiter, datasetCompleteLimiter, datasetStatusLimiter,
} = require('./studioAppRateLimits');
const { SHARD_COUNT, shardName } = require('../core/datasets/rsidIndex');

// ── Sizing (env-tunable; a NEW quota axis, deliberately not MAX_ATTACHMENT_BYTES) ──
const PART_BYTES = parseInt(process.env.DATASET_PART_BYTES, 10) || 32 * 1024 * 1024;
const MAX_FILE_BYTES = parseInt(process.env.STUDIO_APP_DATASET_MAX_FILE_BYTES, 10) || 32 * 1024 * 1024 * 1024;
const TOTAL_BYTES_PER_OWNER = parseInt(process.env.STUDIO_APP_DATASET_TOTAL_BYTES, 10) || 64 * 1024 * 1024 * 1024;
const MAX_FILES_PER_APP = parseInt(process.env.STUDIO_APP_DATASET_MAX_FILES, 10) || 10;

// A paid capability on top of app_studio — first in every route's chain below,
// never path-less on the router (see the header).
const largeDatasets = requireFeature('large_datasets');

// ── What a caller may send ────────────────────────────────────────────
/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });
/** An object that also accepts nothing at all: no body, or a test's bare req, reads as {}. */
const partOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const APP_ID_TEXT = 'The app id is the id in the app\'s address.';
const DATASET_ID_TEXT = 'That is not a dataset id: a dataset id is a UUID.';
const PART_TEXT = 'The part number is a whole number: 0, 1, 2, …';
const NAME_TEXT = 'A dataset needs a name; the file name will do.';
const BYTES_TEXT = 'bytes is the size of the file in bytes: a whole number above 0.';

const appIdParam = worded(APP_ID_TEXT).min(1, APP_ID_TEXT).max(200, APP_ID_TEXT);
const datasetIdParam = worded(DATASET_ID_TEXT).uuid(DATASET_ID_TEXT);

const NoQuery = partOf({});
const AppParams = z.object({ id: appIdParam }).strict();
const DatasetParams = z.object({ id: appIdParam, datasetId: datasetIdParam }).strict();
const PartParams = z.object({
    id: appIdParam,
    datasetId: datasetIdParam,
    // Digits only: parseInt read "1abc" as part 1. The range is the handler's,
    // because it depends on the manifest.
    n: worded(PART_TEXT).regex(/^\d{1,5}$/, PART_TEXT).transform(Number),
}).strict();

const InitBody = partOf({
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(255, 'A dataset name is at most 255 characters.'),
    bytes: z.number({ required_error: BYTES_TEXT, invalid_type_error: BYTES_TEXT })
        .int(BYTES_TEXT).positive(BYTES_TEXT).max(Number.MAX_SAFE_INTEGER, BYTES_TEXT),
    kind: z.enum(['vcf'], { errorMap: () => ({ message: 'kind is "vcf": that is the only kind of dataset so far.' }) }).optional(),
});
// The client sends `{}`; nothing in it is read, so nothing else may be in it.
const CompleteBody = partOf({});

// ── Gating helpers (the studioAppFiles idiom — each studio router carries its
// own copies; the SHARED rules live in appStudio/attachmentAccess) ────────────
async function audienceFor(req) {
    const { orgIds, userGroups } = await resolveAudienceContext(req);
    const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
    return { orgIdArr, userGroups: Array.isArray(userGroups) ? userGroups : [] };
}

async function loadVisibleApp(req, res) {
    const userId = req.session.user.id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app) { res.status(404).json({ error: 'App not found' }); return null; }
    if (app.userId !== userId) {
        const { orgIdArr, userGroups } = await audienceFor(req);
        if (!await studioAppStore.canReadStudioAppAsync(app, userId, userGroups, orgIdArr)) {
            res.status(404).json({ error: 'App not found' });
            return null;
        }
    }
    return app;
}

async function viewerRoleFor(req, app) {
    const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
    const model = meta && meta.model && typeof meta.model === 'object' ? meta.model : null;
    if (!model || !Array.isArray(model.tables)) return { model: null, role: null };
    const { userGroups } = await audienceFor(req);
    const role = await rlsGateway.resolveViewerRole(app, req.session.user.id, model, { userGroups });
    return { model, role: role || null };
}

async function viewerMayUpload(req, app) {
    if (app.userId === req.session.user.id) return true;
    const { model, role } = await viewerRoleFor(req, app);
    return attachmentAccess.roleMayWriteSomewhere(model, role);
}

// Reading dataset status: the owner, or any viewer with a mapped role — and
// then only their own datasets (isMine).
async function viewerMayRead(req, app) {
    if (app.userId === req.session.user.id) return true;
    const { role } = await viewerRoleFor(req, app);
    return role !== null;
}

// List, single, parts, complete: the person who uploaded it — see the header.
function isMine(req, ds) {
    return isUploaderOf(ds, req.session.user.id);
}

// Delete: the uploader, or the owner whose storage it occupies.
function mayDelete(req, app, ds) {
    return isMine(req, ds) || req.session.user.id === app.userId;
}

function publicDataset(ds) {
    const md = ds.metadata || {};
    return {
        id: ds.id,
        name: ds.name,
        kind: ds.kind,
        status: ds.status,
        progressPct: ds.progressPct,
        progressNote: ds.progressNote,
        error: ds.error,
        bytes: ds.dataBytes ?? ds.declaredBytes,
        variantCount: ds.variantCount,
        build: md.build || null,
        sampleCount: Array.isArray(md.samples) ? md.samples.length : null,
        contigCount: Array.isArray(md.contigs) ? md.contigs.length : null,
        createdAt: ds.createdAt,
        readyAt: ds.readyAt,
    };
}

async function deleteArtifacts(app, ds) {
    const keys = [];
    if (ds.rawKey) keys.push(ds.rawKey);
    if (ds.dataKey) keys.push(ds.dataKey);
    if (ds.indexKey) keys.push(ds.indexKey);
    if (ds.rsidPrefix) {
        for (let s = 0; s < SHARD_COUNT; s++) {
            keys.push(storageStore.buildStudioAppDatasetKey(app.userId, app.id, ds.id, `rsid/${shardName(s)}.bin`));
        }
    }
    for (const key of keys) {
        try { await storageStore.deleteFile(key); } catch (_) { /* best-effort — absent shards are normal */ }
    }
}

// ── POST /:id/large-datasets — init ──────────────────────────────────
router.post('/:id/large-datasets', largeDatasets, requireAuth, datasetInitLimiter, express.json({ limit: '16kb' }),
    validate({ params: AppParams, query: NoQuery, body: InitBody }), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        if (!(await viewerMayUpload(req, app))) {
            return res.status(404).json({ error: 'App not found' }); // uniform — never leaks
        }
        if (!storageStore.isAvailable()) {
            return res.status(503).json({ error: 'File storage is temporarily unavailable. Try again shortly.' });
        }
        const { name, bytes } = req.body;
        const kind = req.body.kind || 'vcf';
        if (bytes > MAX_FILE_BYTES) {
            return res.status(413).json({ error: `the file is ${bytes} bytes; the per-file ceiling is ${MAX_FILE_BYTES}` });
        }

        // Quotas BEFORE any bytes move. The file ceiling is per person (the
        // header says why); the byte ceiling is the owner's storage.
        const count = await datasetFileStore.countForUploader(app.id, req.session.user.id);
        if (count >= MAX_FILES_PER_APP) {
            return res.status(409).json({ error: `you already have ${count} datasets in this app (max ${MAX_FILES_PER_APP}) — delete one first` });
        }
        const used = await datasetFileStore.sumBytesForOwner(app.userId);
        if (used + bytes > TOTAL_BYTES_PER_OWNER) {
            return res.status(409).json({ error: 'dataset storage quota exceeded for this workspace' });
        }

        const datasetId = crypto.randomUUID();
        const rawKey = storageStore.buildStudioAppDatasetKey(app.userId, app.id, datasetId, 'raw');
        const { uploadId } = await storageStore.beginMultipartUpload(rawKey, 'application/octet-stream');
        const partsTotal = Math.ceil(bytes / PART_BYTES);
        const ds = await datasetFileStore.createDataset({
            id: datasetId,
            appId: app.id,
            ownerId: app.userId,
            orgId: app.organizationId || null,
            uploaderId: req.session.user.id,
            name,
            kind,
            declaredBytes: bytes,
            partSize: PART_BYTES,
            partsTotal,
            uploadState: { s3UploadId: uploadId, etags: {} },
            rawKey,
        });
        res.json({ datasetId: ds.id, partSize: PART_BYTES, partsTotal });
    } catch (err) {
        log.error('[StudioAppDatasets] init failed:', err.message);
        res.status(500).json({ error: 'Could not start the upload' });
    }
});

// ── PUT /:id/large-datasets/:datasetId/parts/:n — one raw part ──────
// The params are checked BEFORE the raw body is read: a malformed part number
// is refused without buffering up to a part's worth of bytes first.
router.put('/:id/large-datasets/:datasetId/parts/:n', largeDatasets, requireAuth, datasetPartLimiter,
    validate({ params: PartParams, query: NoQuery }), datasetPartBody(PART_BYTES), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        const ds = await datasetFileStore.getDataset(req.params.datasetId, app.id, app.userId);
        if (!ds || !isMine(req, ds)) return res.status(404).json({ error: 'Dataset not found' });
        if (ds.status !== 'uploading') return res.status(409).json({ error: `the upload is ${ds.status}, not accepting parts` });

        const { n } = req.params;
        if (n >= ds.partsTotal) {
            return res.status(400).json({ error: `part number must be 0..${ds.partsTotal - 1}` });
        }
        // Cheap sequence pre-check so a gap/duplicate is refused BEFORE the
        // bytes hit storage. Advisory only — the authoritative arbiter is the
        // conditional UPDATE in recordPart below (two concurrent same-n
        // requests both pass here; exactly one wins the ledger).
        if (n !== ds.partsDone) {
            return res.status(409).json({ error: 'part out of sequence', expected: ds.partsDone });
        }
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'empty part body' });
        const expectedSize = n === ds.partsTotal - 1
            ? ds.declaredBytes - PART_BYTES * (ds.partsTotal - 1)
            : PART_BYTES;
        if (body.length !== expectedSize) {
            return res.status(400).json({ error: `part ${n} must be exactly ${expectedSize} bytes (got ${body.length})` });
        }

        // Part 0 carries the head — the only part whose CONTENT is inspected here.
        if (n === 0) {
            const sniff = sniffDatasetHead(body);
            if (!sniff.ok) {
                await storageStore.abortMultipartUpload(ds.rawKey, ds.uploadState?.s3UploadId).catch(() => {});
                await datasetFileStore.deleteDataset(ds.id, app.id, app.userId).catch(() => {});
                return res.status(415).json({ error: sniff.reason });
            }
        }

        const { etag } = await storageStore.uploadPartBuffer(ds.rawKey, ds.uploadState?.s3UploadId, n + 1, body);
        const recorded = await datasetFileStore.recordPart(ds.id, app.id, app.userId, n, etag, body.length);
        if (!recorded.ok) {
            // Out-of-order or duplicate — tell the client where to resume.
            return res.status(409).json({ error: 'part out of sequence', expected: recorded.expected });
        }
        res.json({ ok: true, partsDone: recorded.partsDone });
    } catch (err) {
        log.error('[StudioAppDatasets] part failed:', err.message);
        res.status(500).json({ error: 'Could not store the part' });
    }
});

// ── POST /:id/large-datasets/:datasetId/complete ────────────────────
router.post('/:id/large-datasets/:datasetId/complete', largeDatasets, requireAuth, datasetCompleteLimiter, express.json({ limit: '4kb' }),
    validate({ params: DatasetParams, query: NoQuery, body: CompleteBody }), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        const ds = await datasetFileStore.getDataset(req.params.datasetId, app.id, app.userId);
        if (!ds || !isMine(req, ds)) return res.status(404).json({ error: 'Dataset not found' });
        if (ds.status !== 'uploading') return res.status(409).json({ error: `the upload is already ${ds.status}` });
        if (ds.partsDone !== ds.partsTotal) {
            return res.status(409).json({ error: `only ${ds.partsDone} of ${ds.partsTotal} parts have arrived`, partsDone: ds.partsDone });
        }

        const etags = ds.uploadState?.etags || {};
        const parts = Array.from({ length: ds.partsTotal }, (_, i) => ({ partNumber: i + 1, etag: etags[String(i)] }));
        if (parts.some((p) => !p.etag)) {
            return res.status(409).json({ error: 'the part ledger is incomplete — restart the upload' });
        }
        await storageStore.completeMultipartUpload(ds.rawKey, ds.uploadState?.s3UploadId, parts);
        await datasetFileStore.markUploaded(ds.id, app.id, app.userId);
        res.json({ ok: true, status: 'uploaded' });
    } catch (err) {
        log.error('[StudioAppDatasets] complete failed:', err.message);
        res.status(500).json({ error: 'Could not finish the upload' });
    }
});

// ── GET /:id/large-datasets — list (polling target) ──────────────────
router.get('/:id/large-datasets', largeDatasets, requireAuth, datasetStatusLimiter, validate({ params: AppParams, query: NoQuery }), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        if (!(await viewerMayRead(req, app))) return res.status(404).json({ error: 'App not found' });
        const list = await datasetFileStore.listDatasets(app.id, app.userId);
        res.json({ datasets: list.filter((ds) => isMine(req, ds)).map(publicDataset) });
    } catch (err) {
        log.error('[StudioAppDatasets] list failed:', err.message);
        res.status(500).json({ error: 'Could not list datasets' });
    }
});

// ── GET /:id/large-datasets/:datasetId — single (polling target) ────
router.get('/:id/large-datasets/:datasetId', largeDatasets, requireAuth, datasetStatusLimiter, validate({ params: DatasetParams, query: NoQuery }), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        if (!(await viewerMayRead(req, app))) return res.status(404).json({ error: 'App not found' });
        const ds = await datasetFileStore.getDataset(req.params.datasetId, app.id, app.userId);
        if (!ds || !isMine(req, ds)) return res.status(404).json({ error: 'Dataset not found' });
        res.json(publicDataset(ds));
    } catch (err) {
        log.error('[StudioAppDatasets] get failed:', err.message);
        res.status(500).json({ error: 'Could not read the dataset' });
    }
});

// ── DELETE /:id/large-datasets/:datasetId ────────────────────────────
router.delete('/:id/large-datasets/:datasetId', largeDatasets, requireAuth, datasetCompleteLimiter, validate({ params: DatasetParams, query: NoQuery }), async (req, res) => {
    try {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        const ds = await datasetFileStore.getDataset(req.params.datasetId, app.id, app.userId);
        if (!ds || !mayDelete(req, app, ds)) return res.status(404).json({ error: 'Dataset not found' });

        if (ds.status === 'uploading' && ds.uploadState?.s3UploadId) {
            await storageStore.abortMultipartUpload(ds.rawKey, ds.uploadState.s3UploadId).catch(() => {});
        }
        await deleteArtifacts(app, ds);
        await datasetFileStore.deleteDataset(ds.id, app.id, app.userId);
        res.json({ ok: true });
    } catch (err) {
        log.error('[StudioAppDatasets] delete failed:', err.message);
        res.status(500).json({ error: 'Could not delete the dataset' });
    }
});

module.exports = router;
module.exports._internals = { PART_BYTES, MAX_FILE_BYTES, TOTAL_BYTES_PER_OWNER, MAX_FILES_PER_APP, publicDataset };
