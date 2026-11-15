/**
 * The organisation switch "images to AI in automations"
 * (core/automationRunner/imageAiSetting.mts holds the storage and the rule;
 * this router only reads and writes it).
 *
 * GET /:orgId   any member of the organisation   `{ enabled, configured }`
 *               (503 when the setting cannot be read: never a default shown as saved)
 * PUT /:orgId   an admin of that organisation    `{ enabled }` -> the same shape
 *
 * Mounted at /api/org-automation-image-ai, next to /api/org-collab. The body
 * is closed and the switch is required: a misspelled key or the STRING
 * "false" is a 400, never a silent "saved". Off by default; the Privacy
 * Shield, the model's vision support and the per-step caps still decide per
 * run (core/automationRunner/aiStepImages.mts).
 *
 * Built by a factory so the test hands in the gates and the store; the
 * default instance uses the real ones, required lazily.
 */

import { createRequire } from 'node:module';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { ImageAiSetting } from '../core/automationRunner/imageAiSetting.mts';

const nodeRequire = createRequire(import.meta.url);
const express = nodeRequire('express') as typeof import('express');

type HttpErrorFactory = (code: string, message: string) => Error;
const { forbidden, unavailable } = nodeRequire('../core/http/errors') as { forbidden: HttpErrorFactory; unavailable: HttpErrorFactory };
const { validate } = nodeRequire('../core/http/validate') as { validate: (schemas: Record<string, unknown>) => RequestHandler };
const { bodyOf } = nodeRequire('../core/http/schemaParts') as { bodyOf: (shape: Record<string, unknown>, subject?: string) => unknown };
const { z } = nodeRequire('../utils/zod') as { z: typeof import('zod').z };
const log = nodeRequire('../telemetry/log') as { info: (msg: string) => void };

const SWITCH_TEXT = 'enabled is true or false: may automations show images to an AI model that can see them?';

const ImageAiBody = bodyOf({
    enabled: z.boolean({ error: SWITCH_TEXT }),
}, 'The images-to-AI setting');

export interface ImageAiSettingStore {
    readImageAiSetting: (orgId: string) => Promise<ImageAiSetting>;
    saveImageAiSetting: (orgId: string, enabled: boolean, updatedBy: string | null) => Promise<ImageAiSetting>;
}

export interface OrgImageAiRouterDeps {
    requireAuth?: RequestHandler;
    /** The caller's organisations; null = every organisation (a super admin). */
    resolveUserOrgIds?: (req: Request) => Set<string> | null | Promise<Set<string> | null>;
    isOrgAdmin?: (req: Request, orgId: string) => boolean | Promise<boolean>;
    store?: ImageAiSettingStore;
}

function realStore(): ImageAiSettingStore {
    return nodeRequire('../core/automationRunner/imageAiSetting.mts') as ImageAiSettingStore;
}

export function makeOrgAutomationImageAiRouter(deps: OrgImageAiRouterDeps = {}): Router {
    const router = express.Router();
    // The real, tagged gate (auth/gateMeta.js), so the route contract reads it as `auth`.
    const requireAuth: RequestHandler = deps.requireAuth || (nodeRequire('../auth/permissions') as { requireAuth: RequestHandler }).requireAuth;
    const resolveUserOrgIds = deps.resolveUserOrgIds
        || ((req: Request) => (nodeRequire('../auth') as { resolveUserOrgIds: (r: Request) => Promise<Set<string> | null> }).resolveUserOrgIds(req));
    const isOrgAdmin = deps.isOrgAdmin
        || ((req: Request, orgId: string) => (nodeRequire('../auth/permissions') as { isOrgAdminForOrg: (r: Request, o: string) => Promise<boolean> }).isOrgAdminForOrg(req, orgId));
    const store = (): ImageAiSettingStore => deps.store || realStore();

    /** The organisation's members may read its switch; a stranger may not learn it exists. */
    async function assertMember(req: Request, orgId: string): Promise<void> {
        const orgIds = await resolveUserOrgIds(req);
        const member = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!member) throw forbidden('not_org_member', 'You are not a member of this organisation.');
    }

    router.get('/:orgId', requireAuth, async (req: Request<{ orgId: string }>, res: Response) => {
        const { orgId } = req.params;
        await assertMember(req, orgId);
        let setting: ImageAiSetting;
        try {
            setting = await store().readImageAiSetting(orgId);
        } catch {
            throw unavailable('image_ai_setting_unavailable', 'The images-to-AI setting could not be read. Try again in a moment.');
        }
        res.json(setting);
    });

    router.put('/:orgId', requireAuth, validate({ body: ImageAiBody }), async (req: Request<{ orgId: string }>, res: Response) => {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) {
            throw forbidden('not_org_admin', 'Only an admin of this organisation can change whether automations show images to AI.');
        }
        const enabled = (req.body as { enabled: boolean }).enabled;
        const userId = (req.session as { user?: { id?: string } } | undefined)?.user?.id || null;
        const saved = await store().saveImageAiSetting(orgId, enabled, userId);
        log.info(`[OrgAutomationImageAi] org ${orgId}: images to AI in automations ${enabled ? 'ON' : 'off'}`);
        res.json(saved);
    });

    return router;
}

export const orgAutomationImageAiRouter: Router = makeOrgAutomationImageAiRouter();
