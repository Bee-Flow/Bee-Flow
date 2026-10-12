/**
 * Contract readers for an automation's version history
 * (routes/automation/versions.js over stores/automationStore/versions.js).
 */

import { field, nullable, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type { FlowVersion, FlowVersionDiff, FlowVersionSummary, VersionDescriptionEntry } from './types';
import { asDefinition } from '../model/normalize';

/** Text with something in it, else null (a blank name is no milestone). */
function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

/** The change codes: a list, or one entry on its own; entries without a code dropped. */
function readDescriptionJson(value: unknown): VersionDescriptionEntry[] {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list.flatMap((item) => {
        const code = text(pick(item, 'code'));
        return code ? [{ code, params: field.record<Record<string, unknown>>({})(pick(item, 'params')) }] : [];
    });
}

function readRuns(value: unknown): { total: number; failed: number } | null {
    return field.recordOrNull(value) ? { total: field.num(0)(pick(value, 'total')), failed: field.num(0)(pick(value, 'failed')) } : null;
}

/** listVersions: metadata only, newest first — the body is a second read. */
export const readVersionRows: (raw: unknown) => FlowVersionSummary[] = shapeListOf({
    id: field.str(''),
    automationId: field.str(''),
    version: field.num(0),
    savedByUserId: field.strOrNull,
    savedAt: field.strOrNull,
    changeSummary: field.strOrNull,
    savedByName: field.strOrNull,
    name: text,
    description: text,
    descriptionJson: readDescriptionJson,
    isLive: field.bool(false),
    liveSince: text,
    isEditing: field.bool(false),
    runs: readRuns,
});

export function readVersionList(raw: unknown): FlowVersionSummary[] {
    return readVersionRows(pick(raw, 'versions')).filter((v) => v.id !== '');
}

/** getVersion: one stored definition, normalised like the live one. */
export const readVersion: (raw: unknown) => FlowVersion = shapeOf({
    id: field.str(''),
    automationId: field.str(''),
    version: field.num(0),
    definition: asDefinition,
    savedByUserId: field.strOrNull,
    savedAt: field.strOrNull,
});

const readVersionOrNull = nullable(readVersion);

export function readVersionResponse(raw: unknown): FlowVersion | null {
    return readVersionOrNull(pick(raw, 'version'));
}

const readStepChanges = shapeOf({
    added: field.strArray,
    removed: field.strArray,
    changed: field.strArray,
});

const readDiffSummary = shapeOf({
    steps: readStepChanges,
    edgesChanged: field.bool(false),
    triggerChanged: field.bool(false),
});

/** GET /:id/versions/:a/diff/:b — both bodies and the server's coarse summary. */
export function readVersionDiff(raw: unknown): FlowVersionDiff {
    return {
        a: readVersionOrNull(pick(raw, 'a')),
        b: readVersionOrNull(pick(raw, 'b')),
        summary: readDiffSummary(pick(raw, 'summary')),
    };
}
