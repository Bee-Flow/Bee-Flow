/**
 * Plain words for how a plan is wired and how it went, worked out from what the server sent. Pure: no fetching, no
 * React.
 *
 *   - triedLines: the try-out of a plan on its card ("Tried once: 'List meetings' read 5 items, the AI wrote its
 *     answer. Nothing was changed or sent."), or honestly what still fails (server usecases/coworkPlannerTry.mts);
 *   - failureLine: a run that failed at a step, on the Overview, as a sentence about the plan's own steps ("'A week
 *     ago' could not read the date from 'Now'."). The runner's own message stays under Advanced → Runs.
 */
import type { PlanTried, PlanTrySummary } from '@/api/coworkPlan.types';
import type { CoworkRunFailure } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

/** What the try-out did, in one run of words: each read with its count, then the AI. */
function didWhat(summary: PlanTrySummary | null, t: TranslateFn): string {
    const parts: string[] = [];
    for (const read of summary?.reads ?? []) {
        if (read.items === null) parts.push(t('cowork_wiring.tried.read', "'{step}' read its data", { step: read.title }));
        else if (read.items === 1) parts.push(t('cowork_wiring.tried.read_one', "'{step}' read 1 item", { step: read.title }));
        else parts.push(t('cowork_wiring.tried.read_items', "'{step}' read {count} items", { step: read.title, count: read.items }));
    }
    const ai = summary?.ai ?? 0;
    if (ai === 1) parts.push(t('cowork_wiring.tried.ai_one', 'the AI wrote its answer'));
    else if (ai > 1) parts.push(t('cowork_wiring.tried.ai_many', '{count} AI steps wrote their answers', { count: ai }));
    return parts.join(', ') || t('cowork_wiring.tried.nothing', 'it ran');
}

/** The lines of a plan's try-out: a heading sentence, and the problems under it when it did not pass. */
export interface TriedLines { line: string; problems: string[]; tone: 'ok' | 'warning' | 'error' }

/** What the card says about the plan's last try-out; null when there is nothing to say. */
export function triedLines(tried: PlanTried | null | undefined, t: TranslateFn): TriedLines | null {
    if (!tried) return null;
    if (tried.status === 'running') return { line: t('cowork_wiring.tried.running', 'A try-out is running.'), problems: [], tone: 'ok' };
    if (!tried.current) {
        return tried.required ? { line: t('cowork_wiring.tried.stale', 'The plan changed since its try-out. Try it again before you approve it.'), problems: [], tone: 'warning' } : null;
    }
    if (tried.status === 'passed') {
        const what = didWhat(tried.summary, t);
        return tried.rounds > 1
            ? { line: t('cowork_wiring.tried.passed_rounds', 'Tried {count} times until it worked: {what}. Nothing was changed or sent.', { count: tried.rounds, what }), problems: [], tone: 'ok' }
            : { line: t('cowork_wiring.tried.passed', 'Tried once: {what}. Nothing was changed or sent.', { what }), problems: [], tone: 'ok' };
    }
    if (tried.status === 'untried') return { line: t('cowork_wiring.tried.untried', 'Not tried yet, because it cannot run as it is:'), problems: tried.problems, tone: 'warning' };
    return { line: t('cowork_wiring.tried.failed', 'Tried, and it does not work yet. It cannot be approved until a try-out passes:'), problems: tried.problems, tone: 'error' };
}

/** A step's title by its id; null when the plan has no such step. */
export type TitleOf = (stepId: string) => string | null;

/** The sentence of a run that failed at a step; null when the run did not fail at one. */
export function failureLine(failure: CoworkRunFailure | null | undefined, titleOf: TitleOf, t: TranslateFn): string | null {
    if (!failure) return null;
    const step = titleOf(failure.stepId);
    if (!step) return null;
    const source = failure.sourceStepId ? titleOf(failure.sourceStepId) : null;
    if (failure.errorClass === 'datetime_unresolved_input') {
        if (failure.sourceStepId && !source) return t('cowork_wiring.failure.date_missing', "'{step}' could not read the date: it reads from a step that is not in the plan.", { step });
        return source
            ? t('cowork_wiring.failure.date', "'{step}' could not read the date from '{source}'.", { step, source })
            : t('cowork_wiring.failure.date_alone', "'{step}' could not read a date.", { step });
    }
    return source
        ? t('cowork_wiring.failure.step_from', "'{step}' could not work with what '{source}' gave it.", { step, source })
        : t('cowork_wiring.failure.step', "'{step}' did not work.", { step });
}
