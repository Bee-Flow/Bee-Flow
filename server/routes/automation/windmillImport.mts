/**
 * Import from Windmill (PLAN B1-F, B1-W, B5), on the automation router:
 *
 *   POST /import/windmill/upload             multipart: `file` (a `wmill sync pull` zip, a flow JSON or
 *                                            flow.yaml), `mode` preview|commit, `select` (JSON list of paths)
 *   POST /import/windmill/remote             JSON: a standalone Windmill read once with a read-only token
 *   GET  /:id/import-report                  the migration report of an imported draft, its gate state
 *                                            and the "Complete with AI" briefing
 *   POST /:id/import-report/acknowledge      checklist items the person handles by hand
 *
 * The importing routes (upload, remote) need the `automation_import` licence
 * feature (Enterprise), as their FIRST handler: the /api/automation mount is
 * Community, so the gate cannot live at the mount, and an unlicensed caller
 * never has a file parsed. The report and its acknowledgement are DELIBERATELY
 * UNGATED (the drain exemption, license/featureMap.js): after a licence lapse
 * an organisation can still read what is open on the drafts it already
 * imported and mark items as handled, so no draft is stranded. They keep the
 * automation's own access check. crud.js registers these before `/:id`
 * (automation.routetable.test.js).
 *
 * Preview and commit are stateless: the commit sends the same input again and
 * the server converts it again. An import writes INACTIVE drafts only; the
 * activation gate (automation/importGate.mts) keeps one off until its
 * checklist is done and a dry run passed. The token of the remote source
 * lives in the request body of that one request: never stored, never logged,
 * never echoed (usecases/automation/windmillRemote.mts).
 */

import { createRequire } from 'node:module';
import type { NextFunction, Request, Response, Router } from 'express';
import { convertWindmill, previewOf, commitWindmill, importReportView, windmillLimits } from '../../usecases/automation/windmillImport.mts';
import type { WindmillLimits } from '../../usecases/automation/windmillImport.mts';
import { fetchWindmillExport, WindmillRemoteError } from '../../usecases/automation/windmillRemote.mts';
import type { FetchLike } from '../../usecases/automation/windmillRemote.mts';
import type { ImportContext } from '../../usecases/automation/importEnvelope.mts';
import type { ImportRow } from '../../stores/automationImportStore.mts';

/** The two import-report functions this router uses (the automationStore facade's, or a test's). */
export interface ReportStore {
    getImportForAutomation: (automationId: string) => Promise<ImportRow | null>;
    acknowledgeImportItems: (automationId: string, ids: string[]) => Promise<ImportRow | null>;
}

const nodeRequire = createRequire(import.meta.url);

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
type HttpErrorCtor = new (status: number, code: string, message: string, details?: unknown) => Error;

const { HttpError } = nodeRequire('../../core/http/errors.js') as { HttpError: HttpErrorCtor };
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => Handler };
const { z } = nodeRequire('../../utils/zod.js') as { z: typeof import('zod').z };
const { requireFeature } = nodeRequire('../../license/middleware.js') as { requireFeature: (name: string) => Handler };
const { uploadGuard } = nodeRequire('../../middleware/uploadGuard.js') as { uploadGuard: (o: { maxBytes: number; allow: readonly string[]; field: string }) => Handler };
const { perUserRateLimit } = nodeRequire('../../utils/perUserRateLimit.js') as { perUserRateLimit: (o: { windowMs: number; max: number; name: string }) => Handler };

/** What a client may upload. The client names the type by extension; the guard checks the bytes. */
export const UPLOAD_TYPES = Object.freeze(['application/zip', 'application/json', 'application/yaml', 'text/plain']);

const Mode = z.enum(['preview', 'commit'], { error: 'mode is preview or commit.' });

const UploadBody = z.object({
    mode: Mode,
    // Multipart fields are text: the selection travels as a JSON list of Windmill paths.
    select: z.string().max(500_000, 'select is too long.').optional(),
}).strict();

const RemoteBody = z.object({
    source: z.literal('windmill_api', { error: 'source is windmill_api.' }),
    baseUrl: z.string().min(1, 'baseUrl is the https:// address of the Windmill.').max(2048, 'baseUrl is too long.'),
    workspace: z.string().min(1, 'workspace is the Windmill workspace id.').max(64, 'workspace is at most 64 characters.'),
    token: z.string().min(1, 'token is a read-only Windmill token.').max(4096, 'token is too long.'),
    mode: Mode,
    select: z.array(z.string().max(1000, 'A path is at most 1000 characters.')).max(5000, 'select holds at most 5000 paths.').optional(),
}).strict();

const AcknowledgeBody = z.object({
    wmIds: z.array(z.string().min(1, 'An item id is not empty.').max(500, 'An item id is at most 500 characters.'))
        .min(1, 'wmIds lists at least one item.').max(1000, 'wmIds lists at most 1000 items.'),
}).strict();

/** The `select` field of the upload: a JSON list of strings, or nothing. */
export function parseSelect(raw: string | undefined): string[] | null {
    if (raw === undefined || raw.trim() === '') return null;
    let v: unknown;
    try { v = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_body', 'select is a JSON list of Windmill paths.'); }
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new HttpError(400, 'invalid_body', 'select is a JSON list of Windmill paths.');
    return v as string[];
}

const REMOTE_STATUS: Record<string, number> = {
    invalid_address: 400, invalid_workspace: 400, unauthorized: 400, too_large: 413, unreachable: 502, not_windmill: 502,
};

export interface WindmillRouteDeps {
    store?: ReportStore;
    limits?: () => WindmillLimits;
    fetchImpl?: FetchLike;
    /** Who imports and the lookups the import pipeline needs (routes/automation/importExport.js hands it in). */
    importContextFor?: (req: Request) => Promise<ImportContext>;
    /** The automation and the caller's access to it; null once the 404 / 403 is sent. */
    load?: (req: Request, res: Response, need: 'view' | 'edit') => Promise<{ id: string; version?: number | null; definition?: Record<string, unknown> | null } | null>;
}

function defaultLoad(req: Request, res: Response, need: 'view' | 'edit') {
    const automationStore = nodeRequire('../../stores/automationStore');
    const { automationAccess } = nodeRequire('./crudContext');
    return (async () => {
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) { res.status(404).json({ error: 'Not found' }); return null; }
        if (!await automationAccess.guard(req, res, a, need)) return null;
        return a;
    })();
}

const passThrough: Handler = (_req, _res, next) => next();

export function registerWindmillImportRoutes(router: Router, deps: WindmillRouteDeps = {}): void {
    const limits = deps.limits ?? windmillLimits;
    const store = (): ReportStore => deps.store ?? (nodeRequire('../../stores/automationStore') as ReportStore);
    const load = deps.load ?? defaultLoad;
    const licensed = requireFeature('automation_import');
    const boot = limits();
    // AUTOMATION_IMPORT_WINDMILL_RPM, per user; 0 = no limit.
    const limiter = boot.rpm > 0 ? perUserRateLimit({ windowMs: 60_000, max: boot.rpm, name: 'automation-import-windmill' }) : passThrough;
    const upload = uploadGuard({ maxBytes: boot.maxBytes > 0 ? boot.maxBytes : Number.MAX_SAFE_INTEGER, allow: UPLOAD_TYPES, field: 'file' });
    const importContextFor = deps.importContextFor ?? (async () => { throw new HttpError(500, 'import.not_wired', 'The import is not available here.'); });

    type Answer = { input: unknown; mode: 'preview' | 'commit'; select: string[] | null; sourceKind: 'windmill_upload' | 'windmill_api'; notes: string[] };
    async function answer(req: Request, res: Response, { input, mode, select, sourceKind, notes }: Answer) {
        const l = limits();
        const conv = await convertWindmill(input, l, notes);
        const preview = previewOf(conv);
        if (mode === 'preview') return res.json({ mode, ...preview });
        const results = await commitWindmill(conv, { select, sourceKind, limits: l, ctx: await importContextFor(req) });
        res.json({ mode, ...preview, results });
    }

    router.post('/import/windmill/upload', licensed, limiter, upload, validate({ body: UploadBody }), async (req: Request, res: Response) => {
        const file = (req as Request & { file?: { buffer: Buffer } }).file;
        if (!file) throw new HttpError(400, 'invalid_body', 'Upload a Windmill export as `file`.');
        const buf = file.buffer;
        const input = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b
            ? { kind: 'zip', data: buf }
            : { kind: 'text', text: buf.toString('utf8'), name: 'upload' };
        await answer(req, res, { input, mode: req.body.mode, select: parseSelect(req.body.select), sourceKind: 'windmill_upload', notes: [] });
    });

    router.post('/import/windmill/remote', licensed, limiter, validate({ body: RemoteBody }), async (req: Request, res: Response) => {
        const { baseUrl, workspace, token, mode, select } = req.body as { baseUrl: string; workspace: string; token: string; mode: 'preview' | 'commit'; select?: string[] };
        const l = limits();
        let fetched;
        try {
            fetched = await fetchWindmillExport({ baseUrl, workspace, token }, { maxBytes: l.maxBytes, maxFlows: l.maxFlows }, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
        } catch (e) {
            if (e instanceof WindmillRemoteError) throw new HttpError(REMOTE_STATUS[e.code] ?? 502, `import.windmill.${e.code}`, e.message);
            throw new HttpError(502, 'import.windmill.unreachable', new WindmillRemoteError('unreachable').message);
        }
        await answer(req, res, { input: fetched.input, mode, select: select ?? null, sourceKind: 'windmill_api', notes: fetched.notes });
    });

    router.get('/:id/import-report', async (req: Request, res: Response) => {
        const a = await load(req, res, 'view');
        if (!a) return;
        const row = await store().getImportForAutomation(a.id);
        if (!row) throw new HttpError(404, 'import.report_missing', 'This automation was not imported, so it has no import report.');
        res.json(importReportView(a, row, limits()));
    });

    router.post('/:id/import-report/acknowledge', validate({ body: AcknowledgeBody }), async (req: Request, res: Response) => {
        const a = await load(req, res, 'edit');
        if (!a) return;
        const row = await store().getImportForAutomation(a.id);
        if (!row) throw new HttpError(404, 'import.report_missing', 'This automation was not imported, so it has no import report.');
        const known = new Set(((row.report?.aiChecklist ?? []) as Array<{ wmId?: unknown }>).map((i) => String(i.wmId)));
        const ids = (req.body.wmIds as string[]).filter((id) => known.has(id));
        if (!ids.length) throw new HttpError(400, 'import.unknown_items', 'None of these items is on the checklist of this import.');
        const updated = await store().acknowledgeImportItems(a.id, ids);
        res.json(importReportView(a, updated ?? row, limits()));
    });
}
