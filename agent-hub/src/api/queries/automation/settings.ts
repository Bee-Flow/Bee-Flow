// Automation Settings page (Studio → Automations, handoff 5): the ONLY place that
// knows the wire contracts the Settings sections call directly. Saves of the
// automation row itself (title, description, icon, folder, definition) go through
// the builder's `onSave`, never through here, so the shell keeps one saving
// state machine.
//
// `authFetch` rather than `apiClient`, like the other automation reads: the
// callers render a failure as a sentence, and the tests mock `authFetch`.

import { useMutation, useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';

const BASE = `${API_BASE}/api/automation`;
const enc = encodeURIComponent;

export const automationSettingsKeys = {
    folders: ['automation', 'folders'] as const,
    catalog: ['automation', 'catalog'] as const,
    schedulePreview: (cron: string, tz: string, skipHolidays: boolean) =>
        ['automation', 'schedule-preview', cron, tz, skipHolidays] as const,
};

/** A failed request, with the status and machine code the caller may branch on. */
export class SettingsRequestError extends Error {
    status: number;
    code: string | null;
    constructor(message: string, status: number, code: string | null = null) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

async function failure(res: Response, fallback: string): Promise<SettingsRequestError> {
    let message = fallback;
    let code: string | null = null;
    try {
        const body = await res.json();
        if (body && typeof body.error === 'string' && body.error) message = body.error;
        if (body && typeof body.code === 'string') code = body.code;
    } catch { /* not JSON: keep the fallback */ }
    return new SettingsRequestError(message, res.status, code);
}

async function postJson(path: string, body: unknown, fallback: string): Promise<unknown> {
    const res = await authFetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw await failure(res, fallback);
    return res.json().catch(() => null);
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

// ── Folders ────────────────────────────────────────────────────────────────

export interface AutomationFolder { id: string; name: string }

export function parseFolders(body: unknown): AutomationFolder[] {
    const raw = obj(body);
    const rows = Array.isArray(raw.folders) ? raw.folders : Array.isArray(body) ? body as unknown[] : [];
    const out: AutomationFolder[] = [];
    for (const r of rows) {
        const row = obj(r);
        const id = text(row.id);
        if (id) out.push({ id, name: text(row.name) || '' });
    }
    return out;
}

export function useAutomationFoldersQuery({ enabled = true }: { enabled?: boolean } = {}) {
    return useQuery<AutomationFolder[], Error>({
        queryKey: automationSettingsKeys.folders,
        queryFn: async ({ signal }) => {
            const res = await authFetch(`${BASE}/folders`, { signal });
            if (!res.ok) throw await failure(res, 'Could not read the folders.');
            return parseFolders(await res.json());
        },
        enabled,
        staleTime: 30_000,
    });
}

// ── Description suggestion ─────────────────────────────────────────────────

/** `language` is the reading language ('nl', 'en-GB'); the server writes the proposal in it. */
export async function suggestDescription(id: string, language?: string | null): Promise<string> {
    const lang = (language || '').trim();
    const body = /^[a-z]{2}(-[A-Za-z]{2})?$/.test(lang) ? { language: lang } : {};
    const res = obj(await postJson(`/${enc(id)}/suggest-description`, body, 'Bee could not suggest a description.'));
    return text(res.description) || '';
}

export function useSuggestDescriptionMutation(language?: string | null) {
    return useMutation<string, Error, string>({ mutationFn: (id) => suggestDescription(id, language) });
}

// ── Whole-automation actions ──────────────────────────────────────────────────

export async function saveAsTemplate(id: string, input: { title?: string; description?: string } = {}): Promise<void> {
    // The template body is strict: a title of 1..120 and a description of at
    // most 500 characters. An automation may hold more, so trim to fit.
    const title = (input.title || '').trim().slice(0, 120);
    const description = (input.description || '').trim().slice(0, 500);
    const body = { ...(title ? { title } : {}), ...(description ? { description } : {}) };
    await postJson(`/${enc(id)}/save-as-template`, body, 'Could not save this as a template.');
}

/**
 * DELETE /:id moves the automation into the trash (30 days; runs stay). The
 * answer carries the row as it now is (deletedAt set, isActive false).
 */
export async function trashAutomation(id: string): Promise<{ purgeAt: string | null; automation: Record<string, unknown> | null }> {
    const res = await authFetch(`${BASE}/${enc(id)}`, { method: 'DELETE' });
    if (!res.ok) throw await failure(res, 'Could not move this automation to the trash.');
    const body = obj(await res.json().catch(() => null));
    const row = obj(body.automation);
    return { purgeAt: text(body.purgeAt), automation: text(row.id) ? row : null };
}

/** The portable export envelope (GET /:id/export), downloaded as a file. */
export async function downloadAutomationExport(id: string, title: string): Promise<string[]> {
    const res = await authFetch(`${BASE}/${enc(id)}/export`);
    if (!res.ok) throw await failure(res, 'Could not export this automation.');
    const body = obj(await res.json());
    const blob = new Blob([JSON.stringify(body.envelope ?? null, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(title || 'automation').replace(/[^a-z0-9-_]+/gi, '_')}.json`;
    link.click();
    // Chrome needs the object URL to outlive the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [];
}

// ── Schedule preview ───────────────────────────────────────────────────────

export interface SchedulePreview { valid: boolean; next: string[]; error: string | null }

export function parseSchedulePreview(body: unknown): SchedulePreview {
    const raw = obj(body);
    const next = Array.isArray(raw.next) ? raw.next.filter((s): s is string => typeof s === 'string') : [];
    return { valid: raw.valid !== false, next, error: text(raw.error) };
}

export async function fetchSchedulePreview(cron: string, tz: string, skipHolidays: boolean): Promise<SchedulePreview> {
    // `skipHolidays` only travels when set: the preview body is strict, so a
    // server without the holiday calendar keeps answering the plain case.
    const body: Record<string, unknown> = { cron, tz, count: 3 };
    if (skipHolidays) body.skipHolidays = true;
    return parseSchedulePreview(await postJson('/_schedule/preview', body, 'Could not preview this schedule.'));
}

export function useSchedulePreviewQuery(cron: string, tz: string, skipHolidays: boolean, { enabled = true } = {}) {
    return useQuery<SchedulePreview, Error>({
        queryKey: automationSettingsKeys.schedulePreview(cron, tz, skipHolidays),
        queryFn: () => fetchSchedulePreview(cron, tz, skipHolidays),
        enabled: enabled && !!cron,
        staleTime: 60_000,
    });
}

// ── App-event catalog (which e-mail app can start an automation) ──────────────

export interface TriggerProvider { id: string; label: string; events: string[] }

export function parseTriggerProviders(body: unknown): TriggerProvider[] {
    const triggers = Array.isArray(obj(body).triggers) ? obj(body).triggers as unknown[] : [];
    const appEvent = triggers.map(obj).find((t) => t.kind === 'app_event');
    const providers = Array.isArray(appEvent?.providers) ? appEvent.providers as unknown[] : [];
    return providers.map((p) => {
        if (typeof p === 'string') return { id: p, label: p, events: [] };
        const row = obj(p);
        const events = Array.isArray(row.events) ? row.events.map((e) => text(obj(e).id)).filter((e): e is string => !!e) : [];
        return { id: text(row.id) || '', label: text(row.label) || text(row.id) || '', events };
    }).filter((p) => p.id);
}

export function useTriggerProvidersQuery({ enabled = true }: { enabled?: boolean } = {}) {
    return useQuery<TriggerProvider[], Error>({
        queryKey: automationSettingsKeys.catalog,
        queryFn: async ({ signal }) => {
            const res = await authFetch(`${BASE}/catalog`, { signal });
            if (!res.ok) throw await failure(res, 'Could not read the catalog.');
            return parseTriggerProviders(await res.json());
        },
        enabled,
        staleTime: 5 * 60_000,
    });
}
