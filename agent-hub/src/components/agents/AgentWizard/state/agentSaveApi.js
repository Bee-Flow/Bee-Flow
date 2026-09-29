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

import { API_BASE, authFetch, parseSaveError } from '../../../../utils/helpers';

/**
 * Het systeemprompt dat de editor moet OVERNEMEN nadat een opslag geland is,
 * of `null` voor "laat staan wat er staat".
 *
 * WAAROM DIT BESTAAT. Een persona in veldmodus is de BRON van het prompt: de
 * server rendert `agents.system_prompt` uit de velden en negeert het prompt dat
 * de client meestuurde (`resolvePersonaWrite` → `renderedPromptFor`). Neemt de
 * editor dat antwoord niet over, dan houdt hij zijn eigen tekst vast — en de
 * eerstvolgende opslag ZONDER persona schrijft die er weer overheen. Vanaf dat
 * moment beschrijft de persona-kolom een prompt dat de agent niet meer draait,
 * en dat is precies de drift die A1c's "één richting" moet voorkomen.
 *
 * Alleen na een opslag die ECHT een persona meestuurde, en alleen zolang de
 * gebruiker sindsdien niet getypt heeft: zijn toetsaanslagen leven alleen in
 * `stateRef` en zijn nergens anders terug te halen, dus die winnen altijd van
 * een antwoord dat onderweg was. Een antwoord zonder leesbaar prompt levert
 * `null` — onbekend is geen reden om iets te overschrijven.
 */
export function adoptedPromptAfterSave({ sentPersona, sentSystemPrompt, localSystemPrompt, savedSystemPrompt }) {
    if (sentPersona === undefined || sentPersona === null) return null;
    if (typeof savedSystemPrompt !== 'string') return null;
    if (localSystemPrompt !== sentSystemPrompt) return null;
    if (savedSystemPrompt === localSystemPrompt) return null;
    return savedSystemPrompt;
}

export async function saveAgent(id, snapshot, baseVersion) {
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
        let body = {};
        try { body = await res.json(); } catch { /* non-JSON body */ }
        return { ok: false, conflict: true, currentVersion: body.currentVersion, agent: body.agent };
    }

    // 403 seat/plan limit, tier_not_permitted, or any other error. parseSaveError
    // consumes the body and normalises both JSON and plain-text shapes.
    const info = await parseSaveError(res);
    if (info.isLimit) {
        return { ok: false, limit: true, message: info.message, resource: info.resource };
    }
    const err = new Error(info.message);
    err.status = res.status;
    err.code = info.code || null;
    throw err;
}
