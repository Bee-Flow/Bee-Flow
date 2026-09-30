/**
 * Contract readers for the Studio routes of a knowledge base: sources
 * (routes/knowledgeBases/sources.js mapSourceForApi — every counter already a
 * Number there), categories (kb_categories rows), system bases
 * (routes/knowledgeBases/system.js), n8n workflows (routes/knowledgeBases/n8n.js)
 * and the favourites list (routes/knowledgeBases/favorites.js, a bare array of ids).
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import type { IngestibleWorkflow, KbCategory, KbSource, KbSourceTotals, SystemKb } from '../model/types';

const readSource: (raw: unknown) => KbSource = shapeOf({
    id: field.str(''),
    kind: field.str('legacy'),
    name: field.str(''),
    config: field.record<Record<string, unknown>>({}),
    refreshMode: field.str('manual'),
    refreshCron: field.strOrNull,
    refreshTz: field.strOrNull,
    supportsModes: (value: unknown) => {
        const modes = field.strArray(value);
        return modes.length ? modes : ['manual'];
    },
    nextRefreshAt: field.strOrNull,
    lastRefreshAt: field.strOrNull,
    status: field.str('idle'),
    error: field.strOrNull,
    documentCount: field.num(0),
    processedCount: field.num(0),
    errorCount: field.num(0),
    skippedCount: field.num(0),
    redactedCount: field.num(0),
    piiFoundCount: field.num(0),
    createdByName: () => null,
});

const readTotals: (raw: unknown) => KbSourceTotals = shapeOf({
    sourceCount: field.num(0),
    autoRefreshCount: field.num(0),
    errorSourceCount: field.num(0),
    documentCount: field.num(0),
});

/** `{ sources, totals }`. `createdBy` is `{ id, name }`, flattened to its name. */
export function readSources(raw: unknown): { sources: KbSource[]; totals: KbSourceTotals } {
    const rows = pick(raw, 'sources');
    const sources = Array.isArray(rows)
        ? rows
              .filter((r) => r && typeof r === 'object')
              .map((r) => ({ ...readSource(r), createdByName: field.strOrNull(pick(pick(r, 'createdBy'), 'name')) }))
              .filter((s) => s.id)
        : [];
    return { sources, totals: readTotals(pick(raw, 'totals')) };
}

/** POST answers 201 `{ source, … }` or the bare row; either way the row. */
export function readCreatedSource(raw: unknown): KbSource | null {
    const row = pick(raw, 'source') ?? raw;
    const source = readSource(row);
    return source.id ? source : null;
}

export const readCategories: (raw: unknown) => KbCategory[] = (raw) =>
    shapeListOf({ id: field.str(''), name: field.str(''), icon: field.strOrNull })(Array.isArray(raw) ? raw : pick(raw, 'categories')).filter(
        (c) => c.id,
    );

const readSystemRow: (raw: unknown) => SystemKb = shapeOf({
    id: field.str(''),
    name: field.str(''),
    description: field.strOrNull,
    icon: field.strOrNull,
    slug: () => null,
    documentCount: field.num(0),
    totalChunks: field.num(0),
    updatedAt: field.strOrNull,
    enabledForOrg: field.bool(false),
    allowedForOrg: field.bool(false),
    superAdminBypass: field.bool(false),
});

export function readSystemKbs(raw: unknown): SystemKb[] {
    const items = pick(raw, 'items');
    if (!Array.isArray(items)) return [];
    return items
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({ ...readSystemRow(r), slug: field.strOrNull(pick(r, 'system_slug')) }))
        .filter((k) => k.id);
}

export const readWorkflows: (raw: unknown) => IngestibleWorkflow[] = (raw) =>
    shapeListOf({ id: field.str(''), name: field.str('') })(raw).filter((w) => w.id);

export const readFavoriteIds: (raw: unknown) => string[] = (raw) => field.strArray(raw).filter(Boolean);
