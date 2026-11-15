/**
 * GET /auth/organizations/:orgId/integration-availability: which integrations
 * are available to the CHOSEN organisation (server configured, in its ceiling,
 * bound where that matters), so an admin dashboard shows a setting only for an
 * integration the organisation can actually use. The answer is built by
 * usecases/integrations/orgIntegrationAvailability.mts: booleans and ids only.
 *
 * Gate: the one GET /auth/organizations/:orgId/org-availability carries,
 * requireOrgAdmin('orgId') (auth/admin/orgAdminGuards.js): an organisation
 * admin of :orgId, or a platform admin. An admin of another organisation gets
 * its 403.
 *
 * Mounted by auth/admin/featureAccessRoutes.js, which hands in the gate and the
 * use case: this file sits in auth/ (platform) and so requires neither the
 * application layer nor core/ itself (server/layering.test.js).
 */

import type { Request, RequestHandler, Response, Router } from 'express';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');

interface SessionLike {
    user?: { organizationId?: string | null };
}

export interface OrgIntegrationAvailabilityRouteDeps {
    /** The tagged org-admin gate over `:orgId` (requireOrgAdmin('orgId')). */
    gate: RequestHandler;
    /** resolveOrgIntegrationAvailability(orgId, viewer). */
    resolve: (orgId: string, viewer: { organizationId: string | null }) => Promise<unknown>;
}

export function createOrgIntegrationAvailabilityRouter({ gate, resolve }: OrgIntegrationAvailabilityRouteDeps): Router {
    const router = express.Router();
    // Express 5 hands a rejection (the use case's 404 HttpError) to the error handler.
    router.get('/organizations/:orgId/integration-availability', gate, async (req: Request<{ orgId: string }>, res: Response) => {
        const session = (req as unknown as { session?: SessionLike }).session;
        const viewer = { organizationId: session?.user?.organizationId ?? null };
        res.json(await resolve(req.params.orgId, viewer));
    });
    return router;
}
