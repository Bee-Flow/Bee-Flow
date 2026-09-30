/** What every answer control is handed. */

import type { Answer, FillField, FillUploadFile, PickResults, UploadedFile } from '@/features/forms/model/fillTypes';
import type { FormLook } from '@/features/forms/model/formLook';

/**
 * The calls a page can make, supplied by the screen that knows the token, the
 * CSRF and the session. Absent in a preview, which leaves every control
 * visible but inert — the author sees the search box, not a hole where it
 * will be.
 */
export interface FillActions {
    upload?: (field: FillField, file: FillUploadFile, onProgress?: (fraction: number) => void) => Promise<UploadedFile>;
    searchApp?: (field: FillField, query: string) => Promise<PickResults>;
    shareFile?: (field: FillField) => Promise<void>;
    openInNotebooks?: (field: FillField) => Promise<void>;
}

export interface AnswerProps {
    field: FillField;
    value: Answer;
    error: string | null;
    disabled: boolean;
    onChange: (next: Answer) => void;
    /** A problem found while answering (a file too large, an upload refused). */
    onError: (message: string) => void;
    look: FormLook;
    actions: FillActions;
}

/** The question's label as a control shows it, with the required star. */
export const labelOf = (field: FillField): string => `${field.label || field.name}${field.required ? ' *' : ''}`;
