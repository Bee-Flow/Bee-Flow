/**
 * A pause a dry run did not take: a headless dry run (the phone's, the AI
 * builder's, the API's) approves an approval by itself and leaves a form page
 * blank, and says so on the step's recorded output (core/automationRunner
 * runDagRecord.js stamps `_dryRunSynthesised` and `_dryRunFallback`;
 * dryPause.mts names the two fallbacks). The timeline marks such a step as
 * simulated, so nobody reads it as a person's answer.
 */

import type { TranslateFn } from '@/core/i18n';

export type SimulatedPause = 'approval' | 'form';

const FALLBACKS: ReadonlyMap<string, SimulatedPause> = new Map<string, SimulatedPause>([
    ['auto_approved', 'approval'],
    ['form_blank', 'form'],
]);

export function simulatedPauseOf(step: { output?: unknown } | null | undefined): SimulatedPause | null {
    const out = step?.output;
    if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
    const flags = out as { _dryRunSynthesised?: unknown; _dryRunFallback?: unknown };
    if (flags._dryRunSynthesised !== true || typeof flags._dryRunFallback !== 'string') return null;
    return FALLBACKS.get(flags._dryRunFallback) ?? null;
}

export function simulatedPauseText(kind: SimulatedPause, t: TranslateFn): string {
    return kind === 'approval'
        ? t('mobile.runs.simulated.approval', 'Simulated: the dry run approved this by itself.')
        : t('mobile.runs.simulated.form', 'Simulated: the dry run left this form blank.');
}
