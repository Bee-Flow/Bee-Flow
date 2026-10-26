import type { TranslateFn } from '@/hooks/useTranslation';

/** The config a new source is created with; which fields are set depends on its kind. */
interface NewSourceConfig {
    text?: string;
    url?: string;
    crawl?: { maxPages: number };
    tag?: string;
    fields?: string[];
    datatableId?: string;
    columns?: string[];
    titleColumn?: string;
}

/** What a form hands to `onCreate`. */
export interface NewSource {
    kind: string;
    name?: string;
    config: NewSourceConfig;
}

/** The fields of an existing source the automation signpost lists. */
interface SignpostSource {
    id: string;
    kind?: string;
    name?: string;
    lastRefreshAt?: string | null;
}

/** One column of a table, as the schema route lists it. */
export interface TableField {
    key: string;
}

/** One table of the picker; the list route never carries `fields`, older callers do. */
export interface TableOption {
    id: string;
    name?: string;
    rowCount?: number | null;
    fields?: TableField[];
}

export interface AddSourcePanelProps {
    canManage?: boolean;
    onCreate?: ((payload: NewSource) => unknown) | null;
    onUpload?: ((files: File[]) => unknown) | null;
    busy?: boolean;
    kbName?: string;
    onNavigate?: ((target: string) => void) | null;
    sources?: SignpostSource[];
}

/** The props every inline form takes. */
export interface FormProps {
    t: TranslateFn;
    busy: boolean;
    onSubmit: (payload: NewSource) => void | Promise<void>;
}

export interface SignpostProps {
    t: TranslateFn;
    kbName?: string;
    onNavigate?: ((target: string) => void) | null;
    sources?: SignpostSource[];
}

export interface KindButtonProps {
    t: TranslateFn;
    kind: string;
    disabled: boolean;
    reason: string;
    onClick: () => void;
}

export interface UploadFormProps {
    t: TranslateFn;
    busy: boolean;
    onUpload: (files: File[]) => unknown;
}

export interface SubmitProps {
    t: TranslateFn;
    busy: boolean;
    disabled: boolean;
}
