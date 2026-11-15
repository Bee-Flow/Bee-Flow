/**
 * GET /api/automation/import/windmill/inventory: the Windmill flows that
 * listen to this organisation's Nextcloud (PLAN B1-N1), for the Windmill
 * import dialog.
 *
 *   { available: boolean, generation?: 'flow_exapp' | 'standalone', flows: [{ path, summary, events: string[], active: boolean }] }
 *
 * `available: false` for an organisation without a Nextcloud, without a
 * paired connector, or with a connector too old to answer (the dialog then
 * says to update the Bee Flow app in Nextcloud; the upload still works). An
 * unreachable connector is a 502.
 *
 * Organisation admins only (requirePrimaryOrgAdmin; a platform admin names
 * the organisation with `?orgId`): the rows behind the list are the whole
 * organisation's, and `manage_automations` only grants the org's run log.
 * Licence feature `automation_import`. The connector call is service-level
 * (automation/importers/windmill/sources/ncInventory.mts): no user is
 * impersonated and no row content but the allow-listed summary reaches the
 * server.
 */

import { createRequire } from 'node:module';
import type { NextFunction, Request, Response } from 'express';
import { fetchWindmillInventory, toInventoryResponse } from '../../automation/importers/windmill/sources/ncInventory.mts';
import type { InventoryOutcome } from '../../automation/importers/windmill/sources/ncInventory.mts';

const nodeRequire = createRequire(import.meta.url);

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

const express = nodeRequire('express') as typeof import('express');
const { HttpError } = nodeRequire('../../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const { requirePrimaryOrgAdmin } = nodeRequire('../../auth/permissions.js') as { requirePrimaryOrgAdmin: () => Handler };
const { requireFeature } = nodeRequire('../../license/middleware.js') as { requireFeature: (feature: string) => Handler };
const { validate } = nodeRequire('../../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => Handler };
const { z, onUnknownKeys } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const log = nodeRequire('../../telemetry/log.js') as { info: (...a: unknown[]) => void, warn: (...a: unknown[]) => void };

export const LICENSE_FEATURE = 'automation_import';

// `orgId` is the organisation a platform admin chose in the admin dashboard;
// requirePrimaryOrgAdmin reads it (and refuses it from anyone else).
const ORG_QUERY = z.object({ orgId: z.string().optional() }, { error: onUnknownKeys('This route takes only the orgId query parameter.') }).strict();

export interface InventoryRouteDeps {
    isNcOrg: (orgId: string) => Promise<boolean>;
    fetchInventory: (orgId: string) => Promise<InventoryOutcome>;
}

function defaultDeps(): InventoryRouteDeps {
    const { isNcOrg } = nodeRequire('../../auth/ncAudience.js') as { isNcOrg: (orgId: string) => Promise<boolean> };
    return { isNcOrg, fetchInventory: (orgId) => fetchWindmillInventory(orgId) };
}

const UNAVAILABLE = Object.freeze({ available: false, flows: [] });

export function makeWindmillInventoryRouter(given: Partial<InventoryRouteDeps> = {}) {
    const router = express.Router();
    router.get('/import/windmill/inventory', requirePrimaryOrgAdmin(), requireFeature(LICENSE_FEATURE), validate({ query: ORG_QUERY }), async (req: Request, res: Response) => {
        const deps = { ...defaultDeps(), ...given };
        const orgId = String((req as Request & { primaryOrgId?: string }).primaryOrgId || '');
        res.set('Cache-Control', 'no-store');
        if (!orgId || !(await deps.isNcOrg(orgId))) return res.json(UNAVAILABLE);
        const out = await deps.fetchInventory(orgId);
        log.info(`[automation/windmill-inventory] org=${orgId} outcome=${out.outcome}${'items' in out ? ` items=${out.items.length}` : ''}`);
        if (out.outcome === 'ok') return res.json(toInventoryResponse(out.items));
        if (out.outcome === 'no_listeners') return res.json({ available: true, flows: [] });
        if (out.outcome === 'unreachable') {
            log.warn(`[automation/windmill-inventory] org=${orgId} connector unreachable: ${out.detail ?? ''}`);
            throw new HttpError(502, 'nextcloud_connector_unreachable', 'The Bee Flow app in Nextcloud did not answer. Try again in a moment.');
        }
        return res.json(UNAVAILABLE);
    });
    return router;
}
