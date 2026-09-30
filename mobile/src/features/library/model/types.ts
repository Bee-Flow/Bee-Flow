/**
 * Shapes the Library hub owns: house styles (server/stores/houseStyleStore.js
 * mapRow) and the hub's own cross-collection search hit.
 */

export interface HouseStyle {
    id: string;
    orgId: string;
    name: string;
    description: string;
    /** Extracted DOCX style metadata; shape varies by extractor version. */
    styleMeta: Record<string, unknown>;
    isDefault: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
}

/** What the hub's search box matches against, whatever the item is. */
export type LibraryKind = 'notebook' | 'knowledge' | 'document' | 'template';

export interface LibraryHit {
    kind: LibraryKind;
    id: string;
    title: string;
    subtitle?: string;
    meta?: string;
    /** expo-router path this row opens. */
    href: string;
}
