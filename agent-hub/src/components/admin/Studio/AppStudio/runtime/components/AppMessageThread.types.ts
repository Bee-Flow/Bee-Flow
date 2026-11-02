import type { BindingInput } from '../resolveBinding.types';

export interface ChipsProps {
    items?: unknown;
    labelKey: string;
    testId: string;
    /** Column holding a chip row's file descriptor; a row with a file becomes a button. */
    fileKey?: string | null;
    /** Called when a chip with a file is clicked. Rejects with the message to show. */
    onOpen?: (item: unknown) => Promise<void>;
}

export interface MessageThreadProps {
    source?: BindingInput;
    attachmentsSource?: BindingInput;
    eventsSource?: BindingInput;
    bodyField?: string | null;
    htmlField?: string | null;
    authorField?: string | null;
    timestampField?: string | null;
    sideField?: string | null;
    sideMap?: { value: string; side: string; tone: string }[];
    attachmentsField?: string | null;
    attachmentLabelKey?: string;
    attachmentMatchKey?: string | null;
    /** The file column of an attachment row (e.g. 'file'); makes chips clickable. */
    attachmentFileKey?: string | null;
    /** The column holding an attachment's Content-ID (e.g. 'content_id'); resolves cid: images. */
    inlineContentIdKey?: string | null;
    citationsField?: string | null;
    citationLabelKey?: string;
    emailField?: string | null;
    toField?: string | null;
    subjectField?: string | null;
    showAvatar?: boolean;
    centerMeta?: string;
    eventsBodyField?: string;
    eventsTimestampField?: string;
    rowLimit?: number;
    emptyText?: string;
}
