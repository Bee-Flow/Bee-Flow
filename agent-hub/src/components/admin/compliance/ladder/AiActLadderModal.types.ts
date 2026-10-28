import type { outcome as computeOutcome, DomainAnswers } from './ladderOutcome';
import type { TranslateParams } from '@/hooks/useTranslation';
import type { LadderSubject, LadderData, LadderSignals } from './useAiActAssessment';
import type React from 'react';
import type { LucideIcon } from 'lucide-react';

export type Verdict = ReturnType<typeof computeOutcome>;

export type Translate = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;

export interface LadderModalViewProps {
    open?: boolean;
    kind?: string;
    target?: LadderSubject | null;
    zIndex?: number;
    onClose: () => void;
    data?: Partial<LadderData> | null;
    onRecorded?: (row: unknown) => void;
    now?: string | number | Date;
}

export interface StepProps {
    n: number;
    state: string;
    title: string;
    meta: string;
    verdict: string | null;
    children?: React.ReactNode;
    testId: string;
}

/**
 * The ten Annex III questions. Each row is one question, its point of the
 * annex, and a Yes/No pair that starts on neither — `null` is a real state
 * here and must stay visible, because "we have not answered this" and "no"
 * are different things to a regulator and the product used to store them the
 * same way.
 *
 * A `hint` puts the question at the top and says the automation's own wording
 * mentions it. It never presses a button. Same rule the RoPA follows for the
 * lawful basis: a pre-selected legal position is the product taking one.
 */
export interface AnnexQuestionsProps {
    questions: { id: string; key: string; en: string; }[];
    answers: DomainAnswers;
    hints: Set<string>;
    onAnswer: (id: string, value: string) => void;
    t: Translate;
}

export interface ChipRowProps {
    chips: readonly { id: string; key: string; en: string; }[];
    denied: Set<string>;
    onToggle: (id: string) => void;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    testId: string;
}

export interface ContainsAiBannerProps {
    containsAi: boolean;
    aiSteps: { label: string }[];
    signals: LadderSignals | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface SubCardProps {
    icon: LucideIcon;
    tone: string;
    title: string;
    detail: string;
    children?: React.ReactNode;
    testId: string;
}

export interface DisclosureCardProps {
    signals: LadderSignals | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface MarkingCardProps {
    signals: LadderSignals | null;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    locale: string;
    now?: string | number | Date;
    busy: boolean;
    onEnable: (() => Promise<void>) | null;
}

export interface OutcomeBoxProps {
    verdict: Verdict;
    containsAi: boolean;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}
