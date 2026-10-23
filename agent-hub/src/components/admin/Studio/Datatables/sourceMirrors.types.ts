import type { TranslateFn } from '../../../../hooks/useTranslation';

/** A relation a mirror carries: Nextcloud's own (`nc`) or one declared here (`match`). */
export type MirrorRelation = {
    fieldId?: string;
    kind?: string;
    localFieldId?: string;
    targetDatatableId?: string;
    targetFieldId?: string;
    labelFieldId?: string;
};

/** The `source` block of a mirrored table, as the server sends it. */
export type MirrorSource = {
    provider?: string;
    fileId?: string;
    fileName?: string;
    path?: string | null;
    format?: string;
    sheet?: string | null;
    headerRow?: number;
    webUrl?: string | null;
    writable?: boolean;
    writeMode?: string;
    writeReason?: string | null;
    owned?: boolean;
    keyColumn?: { header?: string; fieldId?: string } | null;
    columns?: unknown;
    relations?: MirrorRelation[];
    rowCap?: number;
    linkedByUserId?: string | null;
    linkedAt?: string | null;
    automationId?: string;
    ncTableId?: number | string;
    ncViewId?: number | string | null;
    ncUrl?: string | null;
};

/** The `sync` block of a mirrored table. */
export type MirrorSync = {
    status?: string;
    lastError?: string | null;
    lastErrorCode?: string | null;
    lastSuccessAt?: string | null;
    lastSyncAt?: string | null;
    sourceModifiedAt?: string | null;
    truncated?: boolean;
};

/** What the mirror helpers read of a table. */
export type MirrorTable = {
    managedKind?: string | null;
    source?: MirrorSource | null;
};

/** A refusal from a mirror's routes: the server's code and body ride on the Error. */
export type SourceError = Error & {
    code?: string | null;
    body?: { provider?: string; detail?: string; reason?: string; header?: string; ref?: { provider?: string } } | null;
};

/**
 * What differs between the two kinds on the shared surface — and ONLY that.
 * Everything a component can say with a `{source}` word is a `src_*`
 * sentence it calls itself; what is here is prose with a shape of its own
 * per kind (how "live" works, what a cap means, what unlinking leaves alone).
 *
 * Entries are FUNCTIONS over `t`, never bare keys: the i18n guard finds
 * translation keys at literal `t('…')` call sites, and a key carried as a
 * string would be one it could not see.
 */
export interface SourceKindSpec {
    kind: string;
    icon: string;
    tabLabel: (t: TranslateFn) => string;
    liveExplain: (t: TranslateFn) => string;
    truncated: (t: TranslateFn, n: string | number) => string;
    unlinkNotice: (t: TranslateFn, source?: string) => string;
    linkedBody: (t: TranslateFn, n: number) => string;
}
