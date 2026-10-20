import type { ComponentPropsWithoutRef, CSSProperties, JSX } from 'react';

/** One question (or display-only field) of a form, as the server's renderConfig() declares it. */
export interface FormFieldDef {
    name: string;
    type: string;
    label?: string;
    required?: boolean;
    placeholder?: string;
    help?: string;
    options?: unknown;
    /** download / notebook fields */
    filename?: string;
    size?: number;
    /** file fields */
    maxSizeMb?: number;
    accept?: string;
    /** app_pick fields */
    multiple?: boolean;
    maxItems?: number;
    source?: string;
    app?: string;
    searchHint?: string;
    /** info fields (and a group's header): markdown, display only */
    content?: string;
    /** an expression over `form`, the answers of EARLIER questions */
    showIf?: string;
    /** number / date bounds */
    min?: number | string;
    max?: number | string;
    /** text / textarea / email length bounds */
    minLength?: number;
    maxLength?: number;
    /** text / textarea: whole-value pattern and the sentence to show when it fails */
    pattern?: string;
    patternMessage?: string;
    /** multiselect bounds */
    minSelected?: number;
    maxSelected?: number;
    /** a run-data list came back empty: nothing to choose, nothing required */
    noOptions?: boolean;
    /** one-question-per-list-item groups */
    group?: string;
    groupKey?: string;
    groupHeader?: boolean;
}

/** The server's renderConfig(). */
export interface FormDef {
    title?: string;
    description?: string;
    submitLabel?: string;
    successMessage?: string;
    theme?: Record<string, unknown> | null;
    fields?: FormFieldDef[];
}

/** What a file question keeps: the descriptor, never the bytes. */
export interface FormUpload {
    kind: 'form_upload';
    fileId: string;
    filename: string;
    size: number;
}

/** What an app_pick question keeps: a reference, never the record. */
export interface AppPick {
    kind: 'app_pick';
    source?: string;
    recordId: string;
    title?: string;
}

export interface AppPickRow {
    id: string;
    title?: string;
    subtitle?: string;
}

export type FormValue = string | boolean | string[] | FormUpload | AppPick | AppPick[] | null | undefined;
export type FormChangeHandler = (value: FormValue) => void;
export type FormErrorHandler = (message: string) => void;
export type FormValues = Record<string, FormValue>;

export type UploadHandler = (file: File, fieldName: string) => Promise<{ fileId: string; filename: string; size: number }>;
export type SearchAppHandler = (field: FormFieldDef, query: string) => Promise<{ results?: AppPickRow[]; error?: string }>;
export type DownloadHrefHandler = (field: FormFieldDef) => string | null;
export type OpenInNotebooksHandler = (field: FormFieldDef) => Promise<unknown>;
export type ExportAction = () => Promise<unknown>;
export type DownloadAsHandler = (format: 'docx' | 'pdf') => Promise<unknown>;

/** An error thrown out of a submit; `fields` carries per-question messages. */
export interface SubmitError {
    message?: string;
    fields?: Array<{ field: string; message: string }>;
}

export interface PublicFormRendererProps {
    form: FormDef;
    onSubmit?: ((values: Record<string, unknown>) => Promise<unknown>) | null;
    onUpload?: UploadHandler | null;
    onSearchApp?: SearchAppHandler | null;
    preview?: boolean;
    showSuccess?: boolean;
    downloadHref?: DownloadHrefHandler | null;
    onOpenInNotebooks?: OpenInNotebooksHandler | null;
}

export interface FormEndingViewProps {
    form?: FormDef | null;
    downloadHref?: DownloadHrefHandler | null;
    onOpenInNotebooks?: OpenInNotebooksHandler | null;
    onSaveToNotebook?: ExportAction | null;
    onSaveAsWebpage?: ExportAction | null;
    onDownloadAs?: DownloadAsHandler | null;
}

export interface FormWaitingViewProps {
    theme?: Record<string, unknown> | null;
    progress?: string[] | null;
    note?: string | null;
    label?: string;
    /** the median length of this form's recent runs, when the poll knew it */
    typicalSeconds?: number | null;
}

export interface FormRichTextProps {
    children: string;
    className?: string;
    style?: CSSProperties | null;
}

export interface FormFieldProps {
    field: FormFieldDef;
    value?: FormValue;
    error?: string | null;
    disabled?: boolean;
    onChange?: (value: FormValue) => void;
    onUpload?: UploadHandler | null;
    onSearchApp?: SearchAppHandler | null;
    onError?: (message: string) => void;
    /** the question lost focus: check its rules now */
    onBlur?: () => void;
    downloadHref?: string | null;
    onOpenInNotebooks?: OpenInNotebooksHandler | null;
}

export interface FormExportBarProps {
    text: string;
    title?: string;
    onDownloadAs?: DownloadAsHandler | null;
    onSaveToNotebook?: ExportAction | null;
    onSaveAsWebpage?: ExportAction | null;
}

export interface AppPickFieldProps {
    field: FormFieldDef;
    value: AppPick | AppPick[] | null | undefined;
    disabled?: boolean;
    onChange: (value: FormValue) => void;
    onSearch?: SearchAppHandler | null;
}

export interface FileFieldProps {
    field: FormFieldDef;
    value: FormUpload | null | undefined;
    disabled?: boolean;
    onChange: (value: FormValue) => void;
    onUpload?: UploadHandler | null;
    onError: (message: string) => void;
}

/** react-markdown hands every element a `node` beside its own props. */
export type MdProps<K extends keyof JSX.IntrinsicElements> = ComponentPropsWithoutRef<K> & { node?: unknown };
