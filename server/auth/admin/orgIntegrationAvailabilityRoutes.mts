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

import { createRequire } from 'node:module';

// Local structural types instead of `import type ... from 'express'`: the
// agent-hub typecheck reaches this file through the server's route graph and
// has no @types/express installed, so it must not name the express package.
interface AvailabilityRequest {
    params: { orgId: string };
    session?: SessionLike;
}
interface AvailabilityResponse {
    json(body: unknown): unknown;
}
/** An express handler as this router uses it (the gate and the read). */
type Handler = (req: never, res: never, next: (err?: unknown) => void) => unknown;
interface MiniRouter {
    get(path: string, ...handlers: Handler[]): unknown;
}

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as { Router: () => MiniRouter };

interface SessionLike {
    user?: { organizationId?: string | null };
}

export interface OrgIntegrationAvailabilityRouteDeps {
    /** The tagged org-admin gate over `:orgId` (requireOrgAdmin('orgId')). */
    gate: Handler;
    /** resolveOrgIntegrationAvailability(orgId, viewer). */
    resolve: (orgId: string, viewer: { organizationId: string | null }) => Promise<unknown>;
}

export function createOrgIntegrationAvailabilityRouter({ gate, resolve }: OrgIntegrationAvailabilityRouteDeps): MiniRouter {
    const router = express.Router();
    // Express 5 hands a rejection (the use case's 404 HttpError) to the error handler.
    const read = async (req: AvailabilityRequest, res: AvailabilityResponse) => {
        const viewer = { organizationId: req.session?.user?.organizationId ?? null };
        res.json(await resolve(req.params.orgId, viewer));
    };
    router.get('/organizations/:orgId/integration-availability', gate, read as Handler);
    return router;
}
