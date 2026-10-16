import type { TranslateParams } from '../../../../hooks/useTranslation';
import type { Binding, ForEachConfig } from './itemRefs';
import type { ListShape } from './listShape';

/** One way to fix a value that does not fit its slot. */
export interface Remedy {
    id: string;
    binding: Binding;
    labelKey: string;
    labelEn: string;
    labelParams?: TranslateParams;
    preview: string | null;
    forEach?: ForEachConfig;
    itemVar?: string;
    disabled?: boolean;
}

/** The choices offered for one mismatch: the main ones and the "more" fold. */
export interface Remedies {
    shape: ListShape | null;
    count: number;
    primary: Remedy[];
    more: Remedy[];
    defaultId: string;
}

export interface Mismatch {
    code: string;
    actual: string;
    expected: string;
}

export type SlotOptions = { slot?: string | null; expectedKind?: string | null };
