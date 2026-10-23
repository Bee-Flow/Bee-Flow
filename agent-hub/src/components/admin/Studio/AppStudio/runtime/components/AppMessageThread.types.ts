import type { BindingInput } from '../resolveBinding.types';

export interface ChipsProps {
    items?: unknown;
    labelKey: string;
    testId: string;
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
