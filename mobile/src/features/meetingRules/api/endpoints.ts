/**
 * The rules' three calls, all on /api/automation (behind the automations
 * module, licence feature and training gate — a 402/403 here is a licence
 * answer, which the screen words as such).
 *
 *   GET  /?triggerProvider=meeting-notes  the READER's own routines with a
 *        meeting-notes app_event trigger (routes/automation/crud.js; the list
 *        is `getAutomationsForUser`, so a colleague sees theirs, not these).
 *   GET  /_runs/facets?range=24&mode=live  the reader's run counts per routine
 *        (routes/automation/runs.js), `{ facets, rangeHours }`; the server
 *        clamps `range`, so the window comes from the answer.
 *   POST /  a draft with the meeting-notes trigger; answers `{ automation }`.
 */

import { api } from '@/core/api/client';

import { readCreated, readFacets, readRules, type RunFacets } from './readers';
import { newRuleDefinition, RULE_TRIGGER_PROVIDER } from '../model/rules';
import type { MeetingRule } from '../model/types';

/** A rolling day, as the web counts it ("in the last 24 hours", never "today"). */
export const RANGE_HOURS = 24;

export async function listMeetingRules(signal?: AbortSignal): Promise<MeetingRule[]> {
    return readRules(await api.get<unknown>('/api/automation', { signal, query: { triggerProvider: RULE_TRIGGER_PROVIDER } }));
}

/** Live runs only: a dry run is not something that "runs by itself". */
export async function getRunFacets(signal?: AbortSignal): Promise<RunFacets> {
    const res = await api.get<unknown>('/api/automation/_runs/facets', {
        signal,
        query: { range: RANGE_HOURS, mode: 'live' },
    });
    return readFacets(res, RANGE_HOURS);
}

/** Create the draft "+ Rule" makes; answers its id so the editor can open it. */
export async function createMeetingRule(title: string, description: string): Promise<string | null> {
    const res = await api.post<unknown>(
        '/api/automation',
        { title, description, triggerType: 'app_event', definition: newRuleDefinition() },
        { retry: false },
    );
    return readCreated(res);
}
