/**
 * Arming after a Solution stage changed an app's published copy or its publish state: a deploy
 * (projects/stages/converge.js, for every app the commit flipped or retired) and a stage's
 * on/off of an app part (routes/projects/stages/settingsRoutes.js). Both write the published
 * copy without PATCH /:id/publish, so without this their triggers would stay as the previous
 * copy armed them, and the next fire would disarm a trigger that changed.
 *
 * The conditions are the publish route's:
 *   - only the PUBLISHED copy arms (syncAppTriggers; an unpublished app is disarmed);
 *   - the owner's account is active and the owner has App Studio (licence and module), as a
 *     publish by the owner would require. When either is missing nothing is written: the rows
 *     stay as they were and the fire's own rules hold them back (unattendedIdentity.mts).
 * A disarm (the app is not published) needs neither: removing rows is always allowed.
 *
 * A stage prepare, a draft save, a template or Blueprint install and a version restore write
 * the working copy only and never call this; a draft has no rows.
 *
 * Safe to repeat and on two instances: syncAppTriggers compares and writes the app's rows in one
 * locked transaction. `synced: null` means the sync failed and the rows are as they were; the
 * caller tries again (converge retries a task that throws).
 */

import { createRequire } from 'node:module';
import type { SyncResult } from '../../stores/studioAppData/triggers.mts';
import { syncAppTriggers } from './triggerSync.mts';
import type { SyncDeps } from './triggerSync.mts';
import type { UnattendedDeps } from './unattendedIdentity.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export type DeploySyncDeps = {
    readers: Pick<UnattendedDeps, 'getApp' | 'getUser' | 'isActiveAccount' | 'hasAppStudio'>;
    sync: Partial<SyncDeps>;
};

export type DeploySyncOutcome = { synced: SyncResult | null } | { skipped: 'owner_inactive' | 'capability_off' };

function readers(): DeploySyncDeps['readers'] {
    return (nodeRequire('./unattendedIdentity.mts') as { unattendedReaders: () => UnattendedDeps }).unattendedReaders();
}

/** Make the app's armed rows follow its published copy after a stage wrote it, under the publish route's conditions. */
export async function syncAfterStageChange(appId: string, given: Partial<DeploySyncDeps> = {}): Promise<DeploySyncOutcome> {
    const read = { ...readers(), ...given.readers };
    const sync = { getApp: read.getApp, ...given.sync };
    try {
        const app = await read.getApp(appId);
        if (app && app.isPublished && isObject(app.publishedDefinition)) {
            const owner = await read.getUser(app.userId);
            if (!owner || !read.isActiveAccount(owner)) return { skipped: 'owner_inactive' };
            if (!(await read.hasAppStudio({ userId: owner.id, orgId: app.organizationId || null }))) return { skipped: 'capability_off' };
        }
    } catch {
        return { synced: null };
    }
    return { synced: await syncAppTriggers(appId, sync) };
}
