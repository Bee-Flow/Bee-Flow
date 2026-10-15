/**
 * The shapes of the link-spreadsheet wizard: what the storage lists, what the
 * server describes about a file and a sheet, and the selection entry the
 * dialog edits (see wizardState.ts for the keys they are held under).
 */
import type { ErrorLike } from '../datatableTypes';

/** A sheet's name on the wire: `null` for the only, unnamed sheet of a csv. */
export type SheetName = string | null;

/** One column of a sheet, as the describe lists it and the person retypes it. */
export interface SheetColumn {
    /** 0-based position; the letter is for reading only. */
    col: number;
    header: string;
    type: string;
    key: string;
    letter?: string;
    blankHeader?: boolean;
    duplicateHeader?: boolean;
    formula?: boolean;
    samples?: unknown[];
    typeTouched?: boolean;
}

/** One sheet that will become a table: the dialog's editable entry. */
export interface SheetSelection {
    sheetKey: string;
    fileKey: string;
    provider: string;
    fileId: string;
    fileName: string;
    format: string | null;
    path: string | null;
    sheet: SheetName;
    sheetLabel: string;
    headerRow: number;
    columns: SheetColumn[];
    keyColumn: number | null;
    name: string;
    key: string;
    nameTouched: boolean;
    keyTouched: boolean;
    description: string;
    sharedWriteOptIn: boolean;
}

/** The probe's answer for one storage. */
export interface ProviderProbe {
    provider: string;
    connected?: boolean;
    reason?: string;
}

/** A link to a table that already mirrors a sheet of this file. */
export interface LinkedAs {
    datatableId: string;
    sheet?: string | null;
}

/** One entry of a folder listing: a folder or a spreadsheet file. */
export interface BrowseItem {
    id: string;
    name: string;
    kind: 'folder' | 'file';
    format?: string | null;
    size?: number;
    modifiedAt?: string | null;
    webUrl?: string;
    path?: string;
    owned?: boolean;
    linkedAs?: LinkedAs[];
}

/** A file ticked in the browser (the selection is global, across storages). */
export interface PickedFile extends BrowseItem {
    provider: string;
    sharedWriteOptIn?: boolean;
}

/** The folder a listing is of, with the chain of folders down to it. */
export interface BrowseFolder {
    id: string;
    name: string;
    path?: Array<{ id: string; name: string }>;
}

/** What the browser shows: the folder, its items and where the reading stands. */
export interface BrowsePage {
    folder: BrowseFolder | null;
    items: BrowseItem[];
    nextPageToken: string | null;
    loading: boolean;
    error: ErrorLike | null;
}

/** A read that is under way, failed or done (the dialog fetches, the steps read). */
export interface Fetched<T> {
    loading: boolean;
    error: ErrorLike | null;
    data: T | null;
}

/** One sheet of a file as the file's describe lists it. */
export interface SheetInfo {
    name: SheetName;
    hidden?: boolean;
    rows?: number | null;
    cols?: number | null;
    linkedAs?: LinkedAs[];
}

/** How a file can be written back (`write` of the describe). */
export interface WriteInfo {
    mode: string;
    reason?: string | null;
}

/** A file's describe: its sheets, its format and how it can be written. */
export interface FileDescribe {
    format?: string;
    sheets?: SheetInfo[];
    write?: WriteInfo | null;
}

/** A sheet's describe at one header row: preview, key candidates, warnings. */
export interface SheetDescribe {
    keyCandidates?: number[];
    sheet?: { preview?: { rows?: unknown[][] } };
    warnings?: string[];
}

/** One end of a relation between two selected sheets, as the link body names it. */
export interface RelationEnd {
    provider: string;
    fileId: string;
    sheet?: SheetName;
}

/** A relation between two selected sheets, by column. */
export interface SheetRelation {
    from: RelationEnd;
    to: RelationEnd;
    localColumn: { col: number };
    targetColumn: { col: number };
}

/** The part of a refusal body the wizard reads to find the step that can fix it. */
export interface LinkErrorBody {
    key?: string;
    ref?: { provider?: string; fileId?: string; sheet?: string | null };
}
