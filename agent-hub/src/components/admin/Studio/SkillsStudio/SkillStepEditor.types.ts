import type { RefObject } from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { Step, StepRef } from './skillModel.types';

export type { Step, StepRef };
import type { ListStatus } from './useSkillPickerData';

/** One pickable thing of a kind; `title` is how automations name themselves. */
export interface RefOption { id: string; name?: string | number; title?: string }

/** The pickers' options by ref kind (`automation`, `kb`, `table`). */
export type RefOptions = Record<string, RefOption[]>;

export interface SkillStepEditorProps {
    steps?: Step[] | null;
    onChange: (steps: Step[]) => void;
    readOnly?: boolean;
    refOptions?: RefOptions | null;
    listStatus?: ListStatus | null;
    onOpenRef?: ((ref: StepRef) => void) | null;
}

export interface StepCardProps {
    step: Step;
    index: number;
    readOnly: boolean;
    refOptions?: RefOptions | null;
    listStatus?: ListStatus | null;
    onOpenRef?: ((ref: StepRef) => void) | null;
    onText: (text: string) => void;
    onRefs: (refs: StepRef[]) => void;
    onRemove: () => void;
    t: TranslateFn;
}

export interface RefPillsProps {
    refs?: StepRef[] | null;
    readOnly: boolean;
    refOptions?: RefOptions | null;
    listStatus?: ListStatus | null;
    onOpenRef?: ((ref: StepRef) => void) | null;
    onRefs: (refs: StepRef[]) => void;
    t: TranslateFn;
}

export interface RefMenuProps {
    open: boolean;
    onClose: () => void;
    anchorRef: RefObject<HTMLButtonElement | null>;
    refOptions?: RefOptions | null;
    listStatus?: ListStatus | null;
    taken?: StepRef[] | null;
    onPick: (kind: string, id: string) => void;
    t: TranslateFn;
}
