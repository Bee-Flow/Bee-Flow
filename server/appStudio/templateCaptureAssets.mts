/**
 * The parts of a captured template that live outside its screens: its uploaded files and what
 * its report says about them, triggers and column rights. Split out of templateCapture.js,
 * which calls captureAssets before canonicalize and captureReport once the template is built.
 *
 * Files: a capture that is handed entries (portableAssets.mts) carries the ones the definition
 * refers to, decided again as an upload is, and keeps those references; every other whole
 * `asset:<id>` reference is cut, as before this existed. A capture that is handed none (a
 * template file or archive written before files travelled) is exactly the old capture: every
 * reference is cut, and the report says so.
 */

import { createRequire } from 'node:module';
import type { PortableAsset } from './portableAssets.mts';
import { readPortableAssets, referencedAssetIds, remapAssetRefs } from './portableAssets.mts';
import { portabilityReport } from './portabilityReport.mts';
import type { PortableSummary } from './portabilityReport.mts';

const nodeRequire = createRequire(import.meta.url);

export interface CapturedAssets { carried: PortableAsset[]; removed: string[]; left: string[]; asked: boolean }

/** Decide the files of a capture and cut the references to the ones that do not come along (in place on `def`). */
export function captureAssets(def: unknown, assets: unknown): CapturedAssets {
    if (!Array.isArray(assets)) {
        const { stripAssetRefs } = nodeRequire('./appAssets.mts') as { stripAssetRefs: (d: unknown) => string[] };
        return { carried: [], removed: stripAssetRefs(def), left: [], asked: false };
    }
    const read = readPortableAssets(assets, referencedAssetIds(def));
    const keep = new Map(read.assets.map((a) => [a.id, a.id]));
    const { cleared } = remapAssetRefs(def, keep);
    return { carried: read.assets, removed: cleared, left: read.dropped, asked: true };
}

/** The sentences of the report about files, triggers and column rights, and the summary (null when there is nothing to say). */
export function captureReport(files: CapturedAssets, definition: unknown, model: unknown): { summary: PortableSummary | null; warnings: string[] } {
    const out = portabilityReport(definition, model, files.asked ? { carried: files.carried.length, left: files.left } : null);
    const warnings: string[] = [];
    if (files.removed.length) {
        const where = files.removed.slice(0, 3).join(', ');
        warnings.push(`${files.removed.length} uploaded file reference(s) removed (${where}): the image, logo or font itself did not come along. Upload it again in the new app.`);
    }
    return { summary: out.summary, warnings: [...warnings, ...out.warnings] };
}
