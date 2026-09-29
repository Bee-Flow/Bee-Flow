// Where the last run's error points (round 4, artboard 4a). The server names
// the culprit setting in runStep.errorInfo.settingKey (utils/stepErrorInfo.js):
// 'inputs.<name>', 'connection', 'tool', 'modelTier' or 'prompt'. Column 2
// rings that setting red and says what went wrong with it, and the error
// card's "Open the setting" scrolls to the ring (`data-problem`).
import type { ReactNode } from 'react';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { ProblemNote } from '../../mapping/toolInput/ParamExtras';

/** A failed row, whether or not an error branch caught it afterwards. */
export const FAILED_STATUSES = new Set(['error', 'failed', 'handled_error']);

interface ErrorInfoLike {
    settingKey?: unknown;
    title?: string | null;
    titleKey?: string | null;
    cause?: string | null;
    params?: Record<string, unknown> | null;
}

export interface RunProblem {
    /** The server's setting key, e.g. 'inputs.path' or 'prompt'. */
    settingKey: string;
    /** What went wrong, in the reader's language. */
    text: string;
}

/** The setting the last failed run blames, or null. */
export function runStepProblem(
    runStep: { status?: unknown; errorInfo?: ErrorInfoLike | null } | null | undefined,
    t: TranslateFn,
): RunProblem | null {
    const info = FAILED_STATUSES.has(String(runStep?.status ?? '')) ? runStep?.errorInfo : null;
    const settingKey = typeof info?.settingKey === 'string' && info.settingKey ? info.settingKey : null;
    if (!info || !settingKey) return null;
    const title = info.titleKey ? t(info.titleKey, info.title || '', info.params || {}) : info.title;
    return {
        settingKey,
        text: title || info.cause || t('routines.ndv.setting_problem', 'The last run failed on this setting'),
    };
}

const RING = 'rounded-lg p-2 -m-2 border-[1.5px] border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_5%,transparent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--error)_14%,transparent)]';

/** Rings one setting red with the problem under it; renders the children bare otherwise. */
export function ProblemRing({ problem, children }: { problem: string | null; children: ReactNode }) {
    if (!problem) return <>{children}</>;
    return (
        <div data-problem="true" className={`space-y-1.5 ${RING}`}>
            {children}
            <ProblemNote text={problem} />
        </div>
    );
}
