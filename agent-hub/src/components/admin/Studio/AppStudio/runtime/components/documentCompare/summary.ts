// The one-line change summary of a document compare ("3 slides changed,
// 1 slide added, look changed"), per family, and the labels of a deck's look.
// Every key is written out whole so the i18n tooling can find it.

import type { CompareResult, LookChange } from '../../../../../../../api/queries/studioAppDocuments';

export type TFn = (key: string, fallback: string, params?: Record<string, unknown>) => string;

/** One count: the singular text for 1, the plural for more, nothing for 0. */
type Count = [n: number, one: (n: number) => string, many: (n: number) => string];

function joinCounts(counts: Count[]): string[] {
    return counts.filter(([n]) => n > 0).map(([n, one, many]) => (n === 1 ? one(n) : many(n)));
}

/** The parts of the summary that are not zero, in reading order. */
function summaryParts(t: TFn, result: CompareResult): string[] {
    if (result.family === 'deck') {
        const s = result.summary;
        const parts = joinCounts([
            [s.changed, (n) => t('studio_app_documents.slides_changed_one', '{n} slide changed', { n }), (n) => t('studio_app_documents.slides_changed', '{n} slides changed', { n })],
            [s.added, (n) => t('studio_app_documents.slides_added_one', '{n} slide added', { n }), (n) => t('studio_app_documents.slides_added', '{n} slides added', { n })],
            [s.removed, (n) => t('studio_app_documents.slides_removed_one', '{n} slide removed', { n }), (n) => t('studio_app_documents.slides_removed', '{n} slides removed', { n })],
        ]);
        if (s.lookChanged) parts.push(t('studio_app_documents.look_changed', 'look changed'));
        return parts;
    }
    if (result.family === 'sheet') {
        const s = result.summary;
        return joinCounts([
            [s.cellsChanged, (n) => t('studio_app_documents.cells_changed_one', '{n} cell changed', { n }), (n) => t('studio_app_documents.cells_changed', '{n} cells changed', { n })],
            [s.rowsAdded, (n) => t('studio_app_documents.rows_added_one', '{n} row added', { n }), (n) => t('studio_app_documents.rows_added', '{n} rows added', { n })],
            [s.rowsRemoved, (n) => t('studio_app_documents.rows_removed_one', '{n} row removed', { n }), (n) => t('studio_app_documents.rows_removed', '{n} rows removed', { n })],
            [s.columnsAdded, (n) => t('studio_app_documents.columns_added_one', '{n} column added', { n }), (n) => t('studio_app_documents.columns_added', '{n} columns added', { n })],
            [s.columnsRemoved, (n) => t('studio_app_documents.columns_removed_one', '{n} column removed', { n }), (n) => t('studio_app_documents.columns_removed', '{n} columns removed', { n })],
            [s.tabsAdded, (n) => t('studio_app_documents.tabs_added_one', '{n} tab added', { n }), (n) => t('studio_app_documents.tabs_added', '{n} tabs added', { n })],
            [s.tabsRemoved, (n) => t('studio_app_documents.tabs_removed_one', '{n} tab removed', { n }), (n) => t('studio_app_documents.tabs_removed', '{n} tabs removed', { n })],
        ]);
    }
    const s = result.summary;
    return joinCounts([
        [s.changed, (n) => t('studio_app_documents.paragraphs_changed_one', '{n} paragraph changed', { n }), (n) => t('studio_app_documents.paragraphs_changed', '{n} paragraphs changed', { n })],
        [s.added, (n) => t('studio_app_documents.paragraphs_added_one', '{n} paragraph added', { n }), (n) => t('studio_app_documents.paragraphs_added', '{n} paragraphs added', { n })],
        [s.removed, (n) => t('studio_app_documents.paragraphs_removed_one', '{n} paragraph removed', { n }), (n) => t('studio_app_documents.paragraphs_removed', '{n} paragraphs removed', { n })],
    ]);
}

/** The whole line, or "No differences". */
export function summaryText(t: TFn, result: CompareResult): string {
    const parts = summaryParts(t, result);
    return parts.length ? parts.join(', ') : t('studio_app_documents.no_differences', 'No differences');
}

/** Has anything changed at all? */
export function hasChanges(result: CompareResult): boolean {
    if (result.family === 'deck') return result.slides.some((s) => s.op !== 'equal') || result.look.length > 0;
    if (result.family === 'sheet') return result.tabs.some((tab) => tab.op !== 'equal');
    return result.blocks.some((b) => b.op !== 'equal') || result.truncated;
}

const LOOK_LABELS: Record<string, (t: TFn) => string> = {
    houseStyle: (t) => t('studio_app_documents.look.house_style', 'House style'),
    preset: (t) => t('studio_app_documents.look.preset', 'Design'),
    accent: (t) => t('studio_app_documents.look.accent', 'Accent colour'),
    background: (t) => t('studio_app_documents.look.background', 'Background'),
    text: (t) => t('studio_app_documents.look.text', 'Text colour'),
    titleFont: (t) => t('studio_app_documents.look.title_font', 'Title font'),
    bodyFont: (t) => t('studio_app_documents.look.body_font', 'Body font'),
    coverStyle: (t) => t('studio_app_documents.look.cover_style', 'Cover'),
    tableStyle: (t) => t('studio_app_documents.look.table_style', 'Tables'),
    logoPlacement: (t) => t('studio_app_documents.look.logo_placement', 'Logo position'),
    slideNumbers: (t) => t('studio_app_documents.look.slide_numbers', 'Slide numbers'),
    brandOnSlides: (t) => t('studio_app_documents.look.brand_on_slides', 'Brand on slides'),
    footerText: (t) => t('studio_app_documents.look.footer_text', 'Footer'),
    template: (t) => t('studio_app_documents.look.template', 'Template deck'),
    logo: (t) => t('studio_app_documents.look.logo', 'Logo'),
};

/** "Design", "Accent colour", … for a look key (the key itself for one this build does not know). */
export function lookLabel(t: TFn, key: string): string {
    return LOOK_LABELS[key] ? LOOK_LABELS[key](t) : key;
}

/** A look value as a person reads it: '' is the house style's, 'custom' the deck's own picture. */
export function lookValue(t: TFn, change: LookChange, side: 'before' | 'after'): string {
    const v = change[side];
    if (v === '') return t('studio_app_documents.look_value.default', 'From the house style');
    if (v === 'on') return t('studio_app_documents.look_value.on', 'On');
    if (v === 'off' || v === 'none') return t('studio_app_documents.look_value.off', 'Off');
    if (v === 'custom') {
        return change.replaced && side === 'after'
            ? t('studio_app_documents.look_value.replaced', 'Another one')
            : t('studio_app_documents.look_value.custom', 'Its own');
    }
    return v;
}
