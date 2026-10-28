import type { Step } from './skillModel.types';
import type { SkillTestStepResult, SkillTestRun } from '@/api/skillsApi';
import type { RelativeTimeInput } from '@/hooks/useRelativeTime';
import type { TranslateFn } from '@/hooks/useTranslation';

export interface TestTabProps {
    skillId: string;
    steps?: Step[];
    readOnly?: boolean;
    onNavigate?: ((to: string) => void) | null;
}

export interface StepRowProps {
    row: SkillTestStepResult;
    index: number;
}

export interface RunRowProps {
    run: SkillTestRun;
    rel: (dateLike: RelativeTimeInput) => string;
    t: TranslateFn;
}
