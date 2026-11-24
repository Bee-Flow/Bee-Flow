/**
 * What a step that runs once per item (./execFlow.js execForEachStep) hands on besides its output, gathered over its
 * items: the tools an AI step was not given, once per fan-out (handoff 5), and the AI step's verdict on its own work
 * (./aiStepVerdict.mts), the worst one of the items. Neither is part of the output: they ride beside it.
 */

import { worstVerdict, type Verdict } from './aiStepVerdict.mts';

interface ItemResult { toolsWithheld?: unknown; toolsWithheldReasons?: Record<string, string>; verdict?: Verdict | null }

export function fanOutExtras() {
    const withheld = new Map<string, string>();
    const verdicts: Verdict[] = [];
    return {
        /** One item's result. */
        note(r: ItemResult | null | undefined): void {
            if (r?.verdict) verdicts.push(r.verdict);
            if (!Array.isArray(r?.toolsWithheld)) return;
            for (const n of r.toolsWithheld as string[]) if (!withheld.has(n)) withheld.set(n, r.toolsWithheldReasons?.[n] || 'unavailable');
        },
        /** What the step hands on beside its output. */
        result(): { toolsWithheld?: string[]; toolsWithheldReasons?: Record<string, string>; verdict?: Verdict } {
            const verdict = worstVerdict(verdicts);
            return {
                ...(withheld.size ? { toolsWithheld: [...withheld.keys()], toolsWithheldReasons: Object.fromEntries(withheld) } : {}),
                ...(verdict ? { verdict } : {}),
            };
        },
    };
}
