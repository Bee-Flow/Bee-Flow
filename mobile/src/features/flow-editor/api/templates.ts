/**
 * Starting a routine from something that is not a blank canvas: a curated
 * template (automation/templates.js), or a file exported from another
 * installation (automation/portability.js).
 *
 * Installing a template is what the web gallery does: fetch the whole
 * template, then create a routine from its definition — a draft, so the
 * gaps a template leaves (which inbox, which folder) come back as warnings,
 * not refusals.
 */

import { api } from '@/core/api/client';

import { createFlow, flowPath } from './definition';
import { readExport, readSaveResult } from './readers';
import { readTemplateList, readTemplateResponse } from './templateReaders';
import type { FlowExport, FlowTemplate, FlowTemplateList, SaveResult } from './types';

export async function listTemplates(signal?: AbortSignal): Promise<FlowTemplateList> {
    return readTemplateList(await api.get<unknown>('/api/automation/templates', { signal }));
}

export async function getTemplate(templateId: string, signal?: AbortSignal): Promise<FlowTemplate | null> {
    return readTemplateResponse(await api.get<unknown>(`/api/automation/templates/${encodeURIComponent(templateId)}`, { signal }));
}

/** Install a template as a new draft routine; null when the template is gone. */
export async function createFromTemplate(templateId: string): Promise<SaveResult | null> {
    const template = await getTemplate(templateId);
    if (!template) return null;
    return createFlow({
        title: template.title,
        description: template.description || null,
        definition: template.definition,
    });
}

/**
 * The portable envelope of a routine: its definition with pinned samples,
 * environment references and app back-pointers removed (each removal named
 * in `warnings`). Owner only.
 */
export async function exportFlow(id: string, signal?: AbortSignal): Promise<FlowExport> {
    return readExport(await api.get<unknown>(`${flowPath(id)}/export`, { signal }));
}

/**
 * Import an envelope as a NEW inactive draft with fresh step ids. A file the
 * server cannot read is a 400 `Invalid import file` whose details are
 * sentences; everything the catalog-aware pass flags lands as a warning.
 * Rate-limited (10 a minute) and never retried.
 */
export async function importFlow(envelope: Record<string, unknown>): Promise<SaveResult> {
    return readSaveResult(await api.post<unknown>('/api/automation/import', envelope, { retry: false }));
}
