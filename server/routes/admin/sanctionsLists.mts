/**
 * The imported sanctions lists, for the platform admin (super admin only).
 *
 *   GET  /api/admin/sanctions-lists          per list: label, publisher, status, entries, names,
 *                                            last attempt, last success, last error; whether a
 *                                            refresh runs now, and the PEP function list version
 *   POST /api/admin/sanctions-lists/refresh  start a refresh pass now (202 { started: true }), or
 *                                            { started: false, reason: 'running' } while one runs
 *
 * Public list data and download errors only: nothing about a screening, an organisation or a
 * user is read or returned. Not gated on the licence: the operator sees the import whatever the
 * organisations bought (license/featureMap.js says so). The refresh itself is
 * jobs/sanctionsListRefresh.mts.
 *
 * Built by a factory so the test hands in the gate, the store and the job.
 */

import { createRequire } from 'node:module';
import type { RequestHandler, Response, Router } from 'express';
import type { ListStatusRow } from '../../stores/sanctionsStore.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');
const { validate } = nodeRequire('../../core/http/validate') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../../core/http/schemaParts') as { bodyOf: (shape: Record<string, unknown>, subject?: string) => unknown };
const { unavailable } = nodeRequire('../../core/http/errors') as { unavailable: (code: string, message: string) => Error };

type Sources = typeof import('../../core/sanctions/sources.mts');
type Job = Pick<typeof import('../../jobs/sanctionsListRefresh.mts'), 'runOnce' | 'isRunning' | 'settings'>;

const NoBody = bodyOf({}, 'Refreshing the sanctions lists');

export interface SanctionsAdminDeps {
    requireSuperAdmin?: RequestHandler;
    listStatus?: () => Promise<ListStatusRow[]>;
    job?: () => Job;
    pepVersion?: () => string;
}

export function makeSanctionsListsRouter(deps: SanctionsAdminDeps = {}): Router {
    const router = express.Router();
    const gate: RequestHandler = deps.requireSuperAdmin || (nodeRequire('../../auth/permissions') as { requireSuperAdmin: RequestHandler }).requireSuperAdmin;
    const listStatus = deps.listStatus || (() => (nodeRequire('../../stores/sanctionsStore.mts') as typeof import('../../stores/sanctionsStore.mts')).sanctionsStore().listStatus());
    const job = deps.job || ((): Job => nodeRequire('../../jobs/sanctionsListRefresh.mts') as Job);
    const pepVersion = deps.pepVersion || (() => (nodeRequire('../../core/sanctions/pepFunctions.mts') as typeof import('../../core/sanctions/pepFunctions.mts')).pepData().version);
    const { LIST_SOURCES } = nodeRequire('../../core/sanctions/sources.mts') as Sources;

    router.get('/', gate, async (_req, res: Response) => {
        let rows: ListStatusRow[];
        try {
            rows = await listStatus();
        } catch {
            throw unavailable('sanctions_status_unavailable', 'The status of the sanctions lists could not be read. Try again in a moment.');
        }
        const byId = new Map(rows.map((r) => [r.id, r]));
        const lists = LIST_SOURCES.map((s) => {
            const r = byId.get(s.id);
            return {
                id: s.id, label: s.label, publisher: s.publisher, infoUrl: s.infoUrl,
                status: r?.status ?? 'never', entityCount: r?.entityCount ?? 0, nameCount: r?.nameCount ?? 0,
                lastAttemptAt: r?.lastAttemptAt ?? null, lastSuccessAt: r?.lastSuccessAt ?? null,
                replacedAt: r?.replacedAt ?? null, lastError: r?.lastError ?? null,
            };
        });
        const j = job();
        res.json({ lists, refreshing: j.isRunning(), intervalHours: j.settings().intervalHours, pepFunctionsVersion: pepVersion() });
    });

    router.post('/refresh', gate, validate({ body: NoBody }), (_req, res: Response) => {
        const j = job();
        if (j.isRunning()) {
            res.json({ started: false, reason: 'running' });
            return;
        }
        // The pass takes minutes (five downloads, tens of MB): it runs on, the page polls GET.
        void j.runOnce({ force: true });
        res.status(202).json({ started: true });
    });

    return router;
}

export const sanctionsListsRouter: Router = makeSanctionsListsRouter();
