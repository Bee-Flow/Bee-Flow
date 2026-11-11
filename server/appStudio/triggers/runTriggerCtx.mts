/**
 * The part of a server run's step context that record triggers read (backgroundRunJob.mts
 * baseCtx): the origin of its record writes (`writeSource`, recordTriggerRule.mts rule 1) and,
 * for a run a trigger started, its `trigger` root.
 */

import type { StartInput } from '../backgroundRunParts.mts';
import { chainOriginOf } from './recordTriggerRule.mts';

type Obj = Record<string, unknown>;

/**
 * What a run adds for record triggers (triggers/recordTriggerRule.mts): where its record writes
 * come from, and for a trigger run the `trigger` root as the runner handed it (on a resume: as
 * unattendedIdentity.mts read it again). A run a person started writes as that person; a run a
 * trigger started carries the depth of its chain, which only a record trigger's own root
 * (`trigger.record`, triggers/triggerScope.mts) gives: every other kind starts a chain at 1.
 * The writes also say how the chain started when that was a stranger's write or a call from
 * outside (recordTriggerRule.mts rule 6): from the run's own trigger and from the root, both
 * handed to the run by the server.
 */
export function triggerCtx(input: StartInput): Obj {
    if (!input.unattended) return { writeSource: { kind: 'user' } };
    const trigger = input.scope.trigger;
    const record = trigger && trigger.kind === 'record' && trigger.record && typeof trigger.record === 'object' ? trigger.record as Obj : null;
    const depth = record && typeof record.depth === 'number' ? record.depth : 0;
    const triggerId = record && typeof record.triggerId === 'string' ? record.triggerId : null;
    const origin = chainOriginOf(input.unattended.start, trigger);
    return { writeSource: { kind: 'trigger', depth: depth + 1, triggerId, ...(origin ? { origin } : {}) }, ...(trigger ? { trigger } : {}) };
}
