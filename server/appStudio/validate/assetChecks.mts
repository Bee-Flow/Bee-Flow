/**
 * App Studio validator: the uploaded files a definition refers to (`asset:<id>`,
 * appAssets.mts) against the app's asset store.
 *
 * Only when the caller passes the list (opts.assetIds: the save and publish routes, through
 * routes/studioApps/appHelpers.js loadDataRefs). Without a list nothing is said: a missing
 * list is "not checked", not "no assets". A missing asset is a warning on save and publish
 * alike: the image or logo shows its neutral placeholder, nothing else breaks.
 */

import { collectAssetRefs } from '../appAssets.mts';
import type { Finding } from '../definitionKeyRegistry.mts';

type PushFinding = (finding: Finding) => void;

function idSet(assetIds: unknown): Set<string> | null {
    if (assetIds instanceof Set) return new Set([...assetIds].map(String));
    if (Array.isArray(assetIds)) return new Set(assetIds.map(String));
    return null;
}

export function checkAssetRefs(def: unknown, assetIds: unknown, pushW: PushFinding): void {
    const known = idSet(assetIds);
    if (!known) return;
    for (const [id, paths] of collectAssetRefs(def)) {
        if (known.has(id)) continue;
        pushW({
            code: 'asset.missing', severity: 'warning', path: paths[0] || '',
            message: `The uploaded file asset:${id} is not in this app's files${paths.length > 1 ? ` (used in ${paths.length} places)` : ''}; it shows as an empty placeholder.`,
            hint: 'Pick a file from the app\'s uploaded files, upload it again, or use an https URL.',
        });
    }
}
