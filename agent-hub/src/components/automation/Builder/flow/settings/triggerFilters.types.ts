/**
 * Every key a trigger filter form reads, across all of the forms: each form
 * shows its own subset, and an unset key is absent from the stored filter.
 */
export interface TriggerFilterValues {
    from?: string;
    to?: string;
    subjectContains?: string;
    subjectRegex?: string;
    hasAttachment?: boolean;
    excludeFromSelf?: boolean;
    maxAgeMinutes?: number;
    labelId?: string;
    excludeLabelIds?: string[];
    calendarId?: string | number;
    statusEquals?: string;
    attendeeEmailContains?: string;
    leadMinutes?: number;
    includeAllDay?: boolean;
    spreadsheetId?: string;
    sheet?: string;
    range?: string;
    folderId?: string;
    mimeType?: string;
    nameContains?: string;
    excludeOwnUploads?: boolean;
    inFolder?: string;
    extension?: string;
    actorEquals?: string;
    kindEquals?: string;
    type?: string;
    objectNameContains?: string;
    app?: string;
    inboxId?: string;
    categoryEquals?: string;
    priorityEquals?: string;
    tagIncludes?: string;
    resolvedBy?: string;
    minMessages?: number;
    requireGenuineContact?: boolean;
    formId?: number;
    formHash?: string;
    titleContains?: string;
    submittedByEquals?: string;
    tableId?: number;
    columnId?: number;
    valueEquals?: string;
    valueContains?: string;
    changedOnly?: boolean;
    tagId?: number;
    /** A list, or the comma-separated text an older draft stored. */
    tags?: string[] | string;
    reprocessed?: boolean;
}

export interface FilterFieldsProps {
    filter: TriggerFilterValues;
    setFilter: (key: string, value: unknown) => void;
}
