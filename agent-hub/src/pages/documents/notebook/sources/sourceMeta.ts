/**
 * sourceMeta — what a notebook source LOOKS like, per type: label key, glyph
 * and a tone. Tones are literal Tailwind classes on theme variables (Tailwind
 * only emits a class it can read whole), never a hex, so every theme repaints
 * the tiles. Kind colours (`--kind-*`) are used where a source type has one.
 */
import { File, FileText, Link2, Mic, Table2, type LucideIcon } from 'lucide-react';
import type { NotebookSource } from '../hooks/useSourcesPolling';

export interface SourceMeta {
    /** i18n key of the type label ("PDF", "Word", …). */
    labelKey: string;
    /** English fallback, used when the dictionary has no entry yet. */
    label: string;
    Icon: LucideIcon;
    /** Text colour + 12% tint of the same colour, for the tile and the pill. */
    tone: string;
}

const TONE = {
    error: 'text-[var(--error)] bg-[color-mix(in_srgb,var(--error)_12%,transparent)]',
    info: 'text-[var(--info)] bg-[color-mix(in_srgb,var(--info)_12%,transparent)]',
    success: 'text-[var(--success)] bg-[color-mix(in_srgb,var(--success)_12%,transparent)]',
    web: 'text-[var(--kind-web)] bg-[color-mix(in_srgb,var(--kind-web)_14%,transparent)]',
    meet: 'text-[var(--kind-meet)] bg-[color-mix(in_srgb,var(--kind-meet)_14%,transparent)]',
    doc: 'text-[var(--kind-doc)] bg-[color-mix(in_srgb,var(--kind-doc)_14%,transparent)]',
    neutral: 'text-[var(--text-secondary)] bg-[var(--bg-tertiary)]',
} as const;

export const SOURCE_META: Record<string, SourceMeta> = {
    pdf: { labelKey: 'notebooks.src_type_pdf', label: 'PDF', Icon: FileText, tone: TONE.error },
    docx: { labelKey: 'notebooks.src_type_word', label: 'Word', Icon: FileText, tone: TONE.info },
    xlsx: { labelKey: 'notebooks.src_type_excel', label: 'Excel', Icon: Table2, tone: TONE.success },
    csv: { labelKey: 'notebooks.src_type_csv', label: 'CSV', Icon: Table2, tone: TONE.success },
    text: { labelKey: 'notebooks.src_type_text', label: 'Text', Icon: FileText, tone: TONE.doc },
    url: { labelKey: 'notebooks.src_type_url', label: 'URL', Icon: Link2, tone: TONE.web },
    gdrive: { labelKey: 'notebooks.src_type_drive', label: 'Drive', Icon: File, tone: TONE.info },
    onedrive: { labelKey: 'notebooks.src_type_onedrive', label: 'OneDrive', Icon: File, tone: TONE.info },
    file: { labelKey: 'notebooks.src_type_file', label: 'File', Icon: File, tone: TONE.neutral },
    meeting: { labelKey: 'notebooks.src_type_meeting', label: 'Meeting', Icon: Mic, tone: TONE.meet },
};

export function metaFor(type: string): SourceMeta {
    return SOURCE_META[type] || SOURCE_META.file;
}

/** The ingest stage → i18n key + fallback. */
export function stageText(t: (k: string, fb: string) => string, stage: unknown): string {
    switch (stage) {
        case 'queued': return t('notebooks.stage_queued', 'Queued…');
        case 'extracting': return t('notebooks.stage_extracting', 'Reading…');
        case 'fetching': return t('notebooks.stage_fetching', 'Fetching…');
        case 'embedding': return t('notebooks.stage_embedding', 'Indexing…');
        default: return t('notebooks.stage_processing', 'Processing…');
    }
}

/** What a source row needs from the list item (loosely typed server rows). */
export interface SourceRow extends NotebookSource {
    stage?: string;
    hasContent?: boolean;
    storageKey?: string | null;
    metadata?: { duplicate?: boolean } | null;
}
