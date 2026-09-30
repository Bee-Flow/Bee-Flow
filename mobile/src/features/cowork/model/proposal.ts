/**
 * The brief-to-schedule derivation behind the composer's confirm sheet: this
 * is where "every Monday morning" either becomes next Monday 09:00 or quietly
 * becomes now, so it is kept pure and tested (cowork.test.ts).
 */

import { buildCoworkPayload, describeSchedule, nextOccurrence, titleFromBrief } from './schedule';
import type { ComposedCowork } from './types';

/** Everything the confirm sheet needs to show, and the payload it would send. */
export interface Proposal {
    title: string;
    prompt: string;
    scheduleSentence: string;
    repeat: string | null;
    payload: ReturnType<typeof buildCoworkPayload>;
}

/** The composer's answer with every gap filled: the brief's own words, no repeat, no agent. */
function settle(brief: string, spec: ComposedCowork | null) {
    return {
        title: spec?.title || titleFromBrief(brief),
        prompt: spec?.prompt || brief,
        repeat: spec?.repeatInterval || null,
        days: spec?.daysOfWeek ?? null,
        timeOfDay: spec?.timeOfDay ?? null,
        agentId: spec?.agentId ?? null,
    };
}

/** Turn a brief + the composer's answer into the create payload, mirroring the web's submit step. */
export function proposalFrom(brief: string, spec: ComposedCowork | null): Proposal {
    const { title, prompt, repeat, days, timeOfDay, agentId } = settle(brief, spec);
    const runAt = timeOfDay ? nextOccurrence(timeOfDay, days) : null;

    const payload = buildCoworkPayload({
        title,
        prompt,
        // With no composed time the work runs now — and, when it repeats, the
        // series is scheduled from the next interval (buildCoworkPayload's
        // startNow rule), so the user gets a result immediately without the
        // series drifting.
        presetId: 'now',
        runAt,
        repeatInterval: repeat,
        daysOfWeek: days,
        timeOfDay,
        // The phone offers no tier picker here; an agent brings its own model
        // and agent-less work resolves server-side.
        modelTier: 'auto',
        agentId,
    });

    return {
        title,
        prompt,
        scheduleSentence: describeSchedule({ presetId: runAt ? '' : 'now', runAt, repeatInterval: repeat }),
        repeat,
        payload,
    };
}
