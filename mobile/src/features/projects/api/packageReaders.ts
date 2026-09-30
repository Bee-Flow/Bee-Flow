/**
 * Contract readers for Blueprint packaging (routes/projects/packaging.js):
 * the gallery, a Solution's release history and install count, and what an
 * install, an upgrade and a publish report.
 *
 * Each is an explicit allow-list, as the web's releaseModel.js is: a column
 * added to `project_releases` next year does not reach the screen by itself.
 */

import { asCount, field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type {
    BlueprintMeta,
    InstallCounts,
    InstallReport,
    NoteRow,
    PublishResult,
    Release,
    ReleaseNotes,
    UpgradePlan,
} from '../model/package';
import { planRows } from '../model/upgrade';

export const readBlueprints: (raw: unknown) => BlueprintMeta[] = (raw) =>
    shapeListOf({
        id: field.str(''),
        name: field.str('Untitled Blueprint'),
        description: field.str(''),
        icon: field.strOrNull,
        version: field.num(1),
        solutionKey: field.str(''),
        createdBy: field.str(''),
        sourceProjectId: field.strOrNull,
        updatedAt: field.strOrNull,
    })(pick(raw, 'blueprints')).filter((b) => b.id !== '');

/** A version the server counts: a whole number above zero, else null. */
const versionOrNull = (v: unknown): number | null => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);

/** A whole, non-negative count, or null — null stays null, never 0. */
function countOrNull(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const n = Math.trunc(v);
    return n >= 0 ? n : null;
}

function readNoteRow(raw: unknown): NoteRow {
    const row = shapeOf({
        kind: field.str(''),
        entityId: field.str(''),
        name: field.str(''),
        change: field.str(''),
        text: field.str(''),
    })(raw);
    const text = row.text.trim() || null;
    return {
        kind: row.kind,
        ref: row.entityId,
        name: row.name.trim() || row.entityId,
        change: row.change,
        text,
        // Changed with no sentence = "we could not write it down" — the
        // opposite of `unchanged`, and never shown as it.
        summaryMissing: row.change === 'changed' && !text,
    };
}

/** No `entities` list = no diff was recorded for this version. */
function readNotes(raw: unknown): ReleaseNotes {
    const entities = pick(raw, 'entities');
    return {
        entities: Array.isArray(entities)
            ? entities.filter((e) => e !== null && typeof e === 'object').map(readNoteRow)
            : null,
        omitted: countOrNull(pick(raw, 'omitted')) ?? 0,
        textsDropped: pick(raw, 'textsDropped') === true,
    };
}

/**
 * GET /:id/package/releases. A body without a `releases` array is not "never
 * published" — it throws, and the tab says the history could not be read.
 */
export function readReleases(raw: unknown): Release[] {
    const list = pick(raw, 'releases');
    if (!Array.isArray(list)) throw new Error('The release history could not be read.');
    return shapeListOf({
        id: field.str(''),
        version: versionOrNull,
        publishedAt: field.strOrNull,
        notes: readNotes,
    })(list).filter((r) => r.id !== '');
}

/**
 * GET /:id/package/installs: two numbers and nothing else. A successful answer
 * in which neither is a number is not zero installs — it throws.
 */
export function readInstallCounts(raw: unknown): InstallCounts {
    const here = countOrNull(pick(raw, 'installsHere'));
    const elsewhere = countOrNull(pick(raw, 'installsElsewhere'));
    if (here === null && elsewhere === null) throw new Error('The install count could not be read.');
    return { here, elsewhere };
}

/** POST /:id/package/upgrade/plan — only an answer that says `ok: true` is a plan. */
export function readUpgradePlan(raw: unknown): UpgradePlan {
    if (pick(raw, 'ok') !== true) throw new Error('What this update would change could not be worked out.');
    return { rows: planRows(raw), toVersion: versionOrNull(pick(raw, 'toVersion')) };
}

/** POST /package/install — the new Solution's id and the report, from an allow-list. */
export function readInstallReport(raw: unknown): InstallReport {
    const projectId = field.str('')(pick(raw, 'projectId'));
    if (!projectId) throw new Error('The install did not report a Solution.');
    const report = pick(raw, 'report');
    const installed = pick(report, 'installed');
    const total =
        installed && typeof installed === 'object'
            ? Object.values(installed).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
            : 0;
    return {
        projectId,
        installed: total,
        skipped: shapeListOf({ ref: field.str(''), kind: field.str(''), why: field.str('') })(pick(report, 'skipped')),
        warnings: field.strArray(pick(report, 'warnings')).filter(Boolean),
    };
}

/** POST /:id/package/export with `save: true` — the manifest travels too, and is not read. */
export function readPublishResult(raw: unknown): PublishResult {
    return {
        blueprintId: field.strOrNull(pick(raw, '_savedAs')),
        version: asCount(pick(raw, '_version')),
        saveError: field.strOrNull(pick(raw, '_saveError')),
    };
}
