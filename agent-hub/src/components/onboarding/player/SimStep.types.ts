import type { TranslateFn } from '../../../hooks/useTranslation';
import type { LessonStep, SimConfig, StepState } from '../../../api/lessons.types';

export type { LessonStep, SimConfig, TranslateFn };

export type OnState = ((state: StepState) => void) | undefined;

export interface SimStepProps {
    step: LessonStep;
    saved?: StepState | null;
    onState?: (state: StepState) => void;
}
