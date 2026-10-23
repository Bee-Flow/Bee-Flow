import type { FormRecord } from './formState/types';
import type { SampleRootGroup } from '../../mapping/realOutputs';
import type { OnFocusField } from '../../mapping/focusField.types';

/** One extraction row of the step. */
export interface ParseField { name: string; path: string; description?: string; fallback?: unknown }

/** What the AI mapping endpoint answers: grouping it verified, and the rows it proposes. */
export interface MapJsonFieldsResult {
    itemsRef?: string;
    fields?: Array<{ name?: string; path?: unknown; description?: string; verified?: boolean }>;
}

export interface ParseJsonFieldsProps {
    step: { id: string };
    draft: FormRecord;
    set: (key: string, value: unknown) => void;
    groups?: SampleRootGroup[];
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    errorSections?: Set<string>;
}
