// The one request behind the automation builder's app-reference label
// (components/automation/Builder/flow/appRefLabel.ts keeps the 60s module cache,
// the in-flight dedupe and the session-clear hook around it).
// authFetch stays here, in the api layer; the tests mock it.

import { API_BASE, authFetch } from '../../utils/helpers';

/** GET the server's answer for one reference. null on a non-ok answer; rejects on a network failure. */
export async function fetchAppRefRecord<T>(ref: { appId: string; screenId: string; nodeId?: string | null }): Promise<T | null> {
    const qs = new URLSearchParams({ screenId: ref.screenId, ...(ref.nodeId ? { nodeId: ref.nodeId } : {}) });
    const res = await authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(ref.appId)}/ref?${qs}`);
    return res.ok ? res.json() : null;
}

/** The latest builder-session snapshot of an automation (restores the chat and draft after a refresh). Null when the server has none or refuses. */
export async function fetchBuilderSessionSnapshot<T>(automationId: string): Promise<T | null> {
    const r = await authFetch(`${API_BASE}/api/automation/builder/session/${automationId}`);
    if (!r.ok) return null;
    const j: { snapshot?: T } | null = await r.json();
    return j?.snapshot ?? null;
}
