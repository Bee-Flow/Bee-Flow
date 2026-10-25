/**
 * Agent Studio — compare-and-swap save over PUT /agents/:id.
 *
 * Mirrors studioAppsApi.saveDefinition: the 409 (optimistic-concurrency
 * conflict) and 403 (plan/seat limit) responses are EXPECTED flows returned as
 * values, not thrown. Any other non-2xx throws an Error with .status/.code so
 * the caller can surface it in the save indicator.
 *
 *   { ok:true,  updated, version, warnings }              // 200 — version is the new `rev`
 *   { ok:false, conflict:true, currentVersion, agent }    // 409 — server's fresh copy to reconcile
 *   { ok:false, limit:true, message, resource }           // 403 limit_reached
 */

import { API_BASE, authFetch, parseSaveError } from '../utils/helpers';
import type { EditorSnapshot } from './agentSaveTypes';
import { logger } from '../utils/logger';

/** The agent row `PUT /agents/:id` answers with; the editor reads these fields only. */
export interface SavedAgent {
    rev?: number;
    warnings?: unknown[];
    system_prompt?: string;
    [key: string]: unknown;
}

/** What `saveAgent` resolves to: the 200 and the two expected refusals. A real failure throws. */
export type SaveResult =
    | { ok: true; updated: SavedAgent; version: number | undefined; warnings: unknown[]; conflict?: undefined; limit?: undefined }
    | { ok: false; conflict: true; currentVersion: unknown; agent: unknown; limit?: undefined }
    | { ok: false; limit: true; message: string; resource: unknown; conflict?: undefined };

/** The error `saveAgent` throws for any other non-2xx answer. */
interface SaveRequestError extends Error {
    status?: number;
    code?: string | null;
}

/**
 * The system prompt that the editor must ADOPT after a save has landed, or `null` for
 * "keep what is there".
 *
 * WHY THIS EXISTS. A persona in field mode is the SOURCE of the prompt: the server
 * renders `agents.system_prompt` from the fields and ignores the prompt that the client
 * sent (`resolvePersonaWrite` → `renderedPromptFor`). If the editor does not adopt
 * that answer, it keeps its own text, and the next save WITHOUT a persona writes that
 * over it again. From that moment the persona column describes a prompt that the agent
 * no longer runs, and that is precisely the drift that A1c's "one direction" must
 * prevent.
 *
 * Only after a save that REALLY sent a persona, and only as long as the user has not
 * typed since. His keystrokes live only in `stateRef` and cannot be recovered anywhere
 * else, so those always win over an answer that was on its way. An answer without a
 * readable prompt yields `null`: unknown is no reason to overwrite anything.
 */
export function adoptedPromptAfterSave({ sentPersona, sentSystemPrompt, localSystemPrompt, savedSystemPrompt }: {
    sentPersona: unknown;
    sentSystemPrompt: string | undefined;
    localSystemPrompt: string | undefined;
    savedSystemPrompt: unknown;
}): string | null {
    if (sentPersona === undefined || sentPersona === null) return null;
    if (typeof savedSystemPrompt !== 'string') return null;
    if (localSystemPrompt !== sentSystemPrompt) return null;
    if (savedSystemPrompt === localSystemPrompt) return null;
    return savedSystemPrompt;
}

export async function saveAgent(id: string | number | null | undefined, snapshot: EditorSnapshot, baseVersion: number | null): Promise<SaveResult> {
    const res = await authFetch(`${API_BASE}/agents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...snapshot, baseVersion }),
    });

    if (res.ok) {
        const updated = await res.json();
        return { ok: true, updated, version: updated.rev, warnings: updated.warnings || [] };
    }

    if (res.status === 409) {
        let body: { currentVersion?: unknown; agent?: unknown } = {};
        try { body = await res.json(); } catch (err) { logger.debug('non-JSON body', err); }
        return { ok: false, conflict: true, currentVersion: body.currentVersion, agent: body.agent };
    }

    // 403 seat/plan limit, tier_not_permitted, or any other error. parseSaveError
    // consumes the body and normalises both JSON and plain-text shapes.
    const info = await parseSaveError(res);
    if (info.isLimit) {
        return { ok: false, limit: true, message: info.message, resource: info.resource };
    }
    const err: SaveRequestError = new Error(info.message);
    err.status = res.status;
    err.code = info.code || null;
    throw err;
}
