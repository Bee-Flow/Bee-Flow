import type { FormDetail, FormAnswers } from './form/useFormDetail';
import type { TranslateFn } from '../../../../hooks/useTranslation';

/** A form as the directory lists it: the form page's detail, plus what only a list row carries. */
export interface FormListRow extends FormDetail {
    url?: string;
    live?: boolean;
    description?: string | null;
    submissions?: number;
    lastSeenAt?: string | null;
    audience?: FormAudienceLike | null;
    answers?: (FormAnswers & { rowCount?: number }) | null;
}

/** Who can fill a form in: everyone, or the people and groups it is shared with. */
export interface FormAudienceLike {
    mode: string;
    groups: string[];
    users: string[];
}

/** A message for the banner; `retry` says whether re-reading the list could fix it. */
export interface StudioError {
    text: string;
    retry: boolean;
}

export interface StatusPillProps {
    form: FormListRow;
    t: TranslateFn;
}

export interface CopyLinkButtonProps {
    form: FormListRow;
    t: TranslateFn;
    onError: (error: StudioError | null) => void;
}

export interface FormRowProps {
    form: FormListRow;
    onNavigate?: ((path: string) => void) | null;
    onOpen?: ((automationId: string, tab: string | null) => void) | null;
    onError: (error: StudioError | null) => void;
}

/**
 * The three mutually exclusive bodies, in the order they can occur:
 * spinner while nothing has arrived, the empty placard, the rows.
 *
 * `forms` is null until a list arrives, so a first read that FAILED renders
 * nothing here at all — the error banner above is then the whole answer, and
 * "No forms yet" is never shown over a list nobody could read.
 */
export interface FormsBodyProps {
    t: TranslateFn;
    forms: FormListRow[] | null;
    loading: boolean;
    isEmpty: boolean;
    onNavigate?: ((path: string) => void) | null;
    onOpen?: ((automationId: string, tab: string | null) => void) | null;
    onError: (error: StudioError | null) => void;
}

/**
 * Title, count, refresh, "New form".
 *
 * `count` is a NUMBER or null, and null renders nothing at all. The caller
 * passes null both before the first list arrives and after any read fails, so
 * this row can never say "0 forms" about an organisation whose forms it could
 * not read.
 */
export interface FormsHeaderProps {
    t: TranslateFn;
    count: number | null;
    loading: boolean;
    creating: boolean;
    onRefresh: () => Promise<void>;
    onCreate: () => void;
}

export interface FormsStudioProps {
    user?: unknown;
    onNavigate?: ((path: string) => void) | null;
    initialFormId?: string | null;
    initialFormTab?: string | null;
}
