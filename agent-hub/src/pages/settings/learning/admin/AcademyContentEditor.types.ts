import type { TranslateParams } from '../../../../hooks/useTranslation';
import type React from 'react';

export type TFn = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;

export interface Choice { id: string; label: string; correct: boolean; }

export interface SlideStep { type: 'slide'; id: string; icon: string; title: string; bodyMd: string; }

export interface QuizStep {
    type: 'quiz'; id: string; icon: string; title: string; question: string; multi: boolean;
    choices: Choice[]; explanation: string;
}

export interface ExerciseStep {
    type: 'exercise'; id: string; icon: string; title: string; instruction: string; placeholder: string;
    maxAttempts: number | string; task: string; criteria: string[]; passScore: number | string; guidance: string;
}

export type Step = SlideStep | QuizStep | ExerciseStep;

export type StepPatch = Partial<Omit<SlideStep, 'type'>> | Partial<Omit<QuizStep, 'type'>> | Partial<Omit<ExerciseStep, 'type'>>;

export interface Lesson { id: string; title: string; desc: string; icon: string; estMinutes: number | string; steps: Step[]; }

export interface Course {
    id: string | null; title: string; desc: string; icon: string; level: string; lessonIds: string[];
    badgeTitle: string; badgeIcon: string;
}

export interface CourseEntry { courseId: string; title: string; status: string; updatedAt?: string | number; }

export interface ServerChoice { id: string; label?: string; labelFallback?: string; correct?: boolean; }

export interface ServerStep {
    type: string; id: string; icon: string;
    title?: string; titleFallback?: string; bodyMd?: string; bodyMdFallback?: string;
    question?: string; questionFallback?: string; multi?: boolean; choices?: ServerChoice[];
    explanation?: string; explanationFallback?: string; instruction?: string; instructionFallback?: string;
    placeholder?: string; placeholderFallback?: string; maxAttempts?: number; task?: string;
    criteria?: string[]; passScore?: number; guidance?: string;
    rubric?: { task?: string; criteria?: string[]; passScore?: number; guidance?: string };
}

export interface ServerLesson {
    id: string; title?: string; desc?: string; icon?: string; estMinutes?: number; steps?: ServerStep[];
}

export interface FieldProps {
    label?: React.ReactNode;
    hint?: React.ReactNode;
    children?: React.ReactNode;
}

export interface ErrorTextProps {
    children?: React.ReactNode;
}

export interface IconBtnProps {
    title: string;
    disabled?: boolean;
    onClick: React.MouseEventHandler<HTMLButtonElement>;
    children?: React.ReactNode;
}

export interface EmojiRowProps {
    value: string;
    onChange: (emoji: string) => void;
    emojis: string[];
}

export interface StatusChipProps {
    status: string;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface SlideFormProps {
    step: SlideStep;
    onChange: (patch: Partial<Omit<SlideStep, 'type'>>) => void;
    t: TFn;
}

export interface QuizFormProps {
    step: QuizStep;
    onChange: (patch: Partial<Omit<QuizStep, 'type'>>) => void;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface ExerciseFormProps {
    step: ExerciseStep;
    onChange: (patch: Partial<Omit<ExerciseStep, 'type'>>) => void;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface StepEditorProps {
    step: Step;
    index: number;
    count: number;
    onChange: (patch: StepPatch) => void;
    onMove: (idx: number, dir: number) => void;
    onDelete: (idx: number) => void;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface LessonEditorProps {
    lesson: Lesson;
    onChange: (lesson: Lesson) => void;
    error: string | null;
    notice: string | null;
    onSave: () => Promise<void>;
    onBack: () => void;
    busy: boolean;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}
