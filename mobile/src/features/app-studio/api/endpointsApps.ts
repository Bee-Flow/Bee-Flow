/**
 * App Studio management: the catalog, the template gallery and app CRUD
 * (server/routes/studioApps.js). Writes are gated server-side on the
 * `manage_apps` permission, so a 403 on create/save/delete is an ordinary
 * answer for a plain member.
 */

import { api } from '@/core/api/client';
import { field, pick } from '@/core/api/contract';

import { appPath, STUDIO_BASE } from './paths';
import {
    readAppDetail,
    readAppRow,
    readAppRows,
    readCatalog,
    readDataInstall,
    readMyApps,
    readTemplate,
    readTemplates,
} from './readersApps';
import type {
    CreateAppInput,
    CreateAppResult,
    ImportAppResult,
    MyStudioApp,
    OpenRecord,
    StudioAppDetail,
    StudioAppRow,
    StudioCatalog,
    StudioTemplate,
    StudioTemplateMeta,
    TemplateUpgradeResult,
    UpdateAppInput,
} from '../model/apiTypes';

/** The component/theme/action vocabulary. Static per server build. */
export async function getCatalog(signal?: AbortSignal): Promise<StudioCatalog> {
    return readCatalog(await api.get<unknown>(`${STUDIO_BASE}/catalog`, { signal }));
}

/** Built-in starters plus the organisation's captured templates (meta only). */
export async function listTemplates(signal?: AbortSignal): Promise<StudioTemplateMeta[]> {
    return readTemplates(await api.get<unknown>(`${STUDIO_BASE}/templates`, { signal }));
}

/** One template with its definition; null when it is gone or not visible. */
export async function getTemplate(templateId: string, signal?: AbortSignal): Promise<StudioTemplate | null> {
    const path = `${STUDIO_BASE}/templates/${encodeURIComponent(templateId)}`;
    return readTemplate(await api.get<unknown>(path, { signal }));
}

/** Apps the caller may open (own, org- and group-published, project). */
export async function listAccessibleApps(signal?: AbortSignal): Promise<StudioAppRow[]> {
    return readAppRows(await api.get<unknown>(STUDIO_BASE, { signal }));
}

/** Apps the caller owns, with storage use and template-upgrade availability. */
export async function listMyApps(signal?: AbortSignal): Promise<MyStudioApp[]> {
    return readMyApps(await api.get<unknown>(`${STUDIO_BASE}/mine`, { signal }));
}

/**
 * Create an app: blank, or from `templateId`. A data-backed template installs
 * its tables best-effort; `dataInstall.ok === false` says the app exists but
 * its data did not land.
 */
export async function createApp(input: CreateAppInput = {}): Promise<CreateAppResult> {
    const res = await api.post<unknown>(STUDIO_BASE, input);
    return { app: readAppRow(pick(res, 'app')), dataInstall: readDataInstall(pick(res, 'dataInstall')) };
}

/**
 * Stand up an app archive (`beeflow.app`, parsed JSON) as a live app. `name`
 * overrides the file's. Refusals: 400 `invalid_archive` (`body.details`), 422
 * `model_install_failed`, 409 `app_limit`. Never retried: one call writes
 * thousands of rows, and the server rate-limits it at 3/min.
 */
export async function importApp(envelope: unknown, name?: string): Promise<ImportAppResult> {
    const res = await api.post<unknown>(
        `${STUDIO_BASE}/import`,
        { envelope, ...(name ? { name } : {}) },
        { retry: false, timeoutMs: 120_000 },
    );
    return {
        app: readAppRow(pick(res, 'app')),
        report: field.record<OpenRecord>({})(pick(res, 'report')),
        warnings: field.strArray(pick(res, 'warnings')),
    };
}

/** Owner: the full row with the draft. Reader: meta + the published copy. */
export async function getApp(id: string, signal?: AbortSignal): Promise<StudioAppDetail | null> {
    return readAppDetail(await api.get<unknown>(appPath(id), { signal }));
}

/** Metadata only (the definition has its own CAS route). */
export async function updateApp(id: string, input: UpdateAppInput): Promise<StudioAppRow> {
    return readAppRow(pick(await api.put<unknown>(appPath(id), input), 'app'));
}

export async function deleteApp(id: string): Promise<void> {
    await api.delete<unknown>(appPath(id));
}

/**
 * Upgrade a pristine created-from-template app to the template's newer
 * version. 409s carry a code: not_from_template, template_missing,
 * no_newer_version, not_pristine.
 */
export async function upgradeTemplate(id: string): Promise<TemplateUpgradeResult> {
    const res = await api.post<unknown>(`${appPath(id)}/template-upgrade`, undefined, { retry: false });
    return {
        fromVersion: field.numOrNull(pick(res, 'fromVersion')),
        toVersion: field.numOrNull(pick(res, 'toVersion')),
        version: field.num(0)(pick(res, 'version')),
        dataInstall: readDataInstall(pick(res, 'dataInstall')),
    };
}
