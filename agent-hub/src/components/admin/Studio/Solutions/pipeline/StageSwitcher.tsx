import { FlaskConical, Hammer, Rocket, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import type { StageName } from './stagesApi';

/**
 * What the three stages look like and are called: the dot, the ink and the border
 * each wears (StageRail, the Pipeline columns and the Status tab all read these)
 * and the label hook.
 *
 * Each stage wears its accent through the theme variables `--stage-uat` and
 * `--stage-prd`; the fallbacks are the status tokens every theme already has,
 * so a theme that does not define the new variables still shows a distinct dot.
 */

export const STAGE_DOT: Record<StageName, string> = {
    dev: 'bg-[var(--text-tertiary)]',
    uat: 'bg-[var(--stage-uat,var(--warning))]',
    prd: 'bg-[var(--stage-prd,var(--success))]',
};

/** The accent a stage's text and borders wear. */
export const STAGE_INK: Record<StageName, string> = {
    dev: 'text-[var(--text-secondary)]',
    uat: 'text-[var(--stage-uat,var(--warning))]',
    prd: 'text-[var(--stage-prd,var(--success))]',
};

export const STAGE_BORDER: Record<StageName, string> = {
    dev: 'border-[var(--border-default)]',
    uat: 'border-[var(--stage-uat,var(--warning))]',
    prd: 'border-[var(--stage-prd,var(--success))]',
};

/** The soft background a current or active stage wears (dev stays neutral). */
export const STAGE_TINT: Record<StageName, string> = {
    dev: 'bg-[var(--bg-tertiary)]',
    uat: 'bg-[color-mix(in_srgb,var(--stage-uat,var(--warning))_10%,transparent)]',
    prd: 'bg-[color-mix(in_srgb,var(--stage-prd,var(--success))_10%,transparent)]',
};

/** The 2px rule along the top edge of an active stage. */
export const STAGE_RULE: Record<StageName, string> = {
    dev: 'border-t-[var(--text-tertiary)]',
    uat: 'border-t-[var(--stage-uat,var(--warning))]',
    prd: 'border-t-[var(--stage-prd,var(--success))]',
};

/** One icon per stage: Dev = Hammer, UAT = FlaskConical, PRD = Rocket. */
export const STAGE_ICON: Record<StageName, LucideIcon> = {
    dev: Hammer,
    uat: FlaskConical,
    prd: Rocket,
};

export function useStageLabel(): (stage: StageName) => string {
    const { t } = useTranslation();
    return (stage) => {
        if (stage === 'dev') return t('solution_stages.stage_dev', 'Dev');
        if (stage === 'uat') return t('solution_stages.stage_uat', 'UAT');
        return t('solution_stages.stage_prd', 'Production');
    };
}
