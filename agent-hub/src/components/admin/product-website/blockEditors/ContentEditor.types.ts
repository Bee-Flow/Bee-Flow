import type { StyleBlob } from '../primitives.types';
import type { ContentElement, ContentData, LegacyContent, ContentColumn } from '../../../../marketing/sections/contentMigration';
import type { CmsPageOption } from '../fields';
import type { BlockData } from './shared';

/** The per-element fields the editor writes on top of the shared element shape. */
export type ElementExtras = {
    headingAlign?: string; subheadingAlign?: string; bodyAlign?: string;
    headingStyle?: StyleBlob; subheadingStyle?: StyleBlob; bodyStyle?: StyleBlob;
    frame?: string; fullBleed?: boolean; lightbox?: boolean; source?: string;
};

/** A content element as this editor reads and writes it (a mapped copy, so it is also a plain record). */
export type EditorElement = { [K in keyof ContentElement]: ContentElement[K] } & ElementExtras;

export interface ContentEditorProps {
    data?: ContentData | LegacyContent;
    pages?: CmsPageOption[];
    onChange: (next: BlockData) => void;
}

export interface ColumnPanelProps {
    col: ContentColumn;
    colIdx: number;
    pages: CmsPageOption[];
    onChange: (next: ContentColumn) => void;
}

export interface ElementFieldsProps {
    el: EditorElement;
    pages: CmsPageOption[];
    update: (next: EditorElement) => void;
}
