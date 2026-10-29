import { useState } from 'react';
import { CtaElementFields, IframeElementFields, ImageElementFields, TextElementFields, VideoElementFields } from './ElementKindFields';
import { useTranslation, type TranslateParams } from '@/hooks/useTranslation';
import {
    migrateLegacyContent,
    makeColumn,
    makeElement,
    type ContentColumn,
    type ContentData,
    type ContentElement,
    type LegacyContent,
} from '@/marketing/sections/contentMigration';
import type { BlockData } from './shared';
import type { StyleBlob } from '../primitives.types';
import useConfirm from '@/components/shared/useConfirm';
import { RepeatableList, FieldRow, type CmsPageOption } from '../fields';
import {
    InlineHint,
    CollapsibleCard,
    FieldSelect,
    BackgroundVariantSelect,
    SegmentedControl,
} from '../primitives';
import type { ElementExtras, EditorElement, ContentEditorProps, ColumnPanelProps, ElementFieldsProps } from './ContentEditor.types';

// ── Content (generic flexible block) ─────────────────────────────────

// Layout, element, and migration helpers live in the marketing-side
// module so the editor and the renderer share one source of truth on
// shape conversion + defaults.

const columnLayouts = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { value: '1',   label: '1',         hint: t('cms_site.blocks.content.layout_single_column', 'Single column') },
    { value: '2',   label: '1 │ 1', hint: t('cms_site.blocks.content.layout_two_equal_columns', 'Two equal columns') },
    { value: '3',   label: '1│ 1│ 1', hint: t('cms_site.blocks.content.layout_three_equal_columns', 'Three equal columns') },
    { value: '1-2', label: '1 │ 2', hint: t('cms_site.blocks.content.layout_narrow_wide', 'Narrow | Wide') },
    { value: '2-1', label: '2 │ 1', hint: t('cms_site.blocks.content.layout_wide_narrow', 'Wide | Narrow') },
];

const valigns = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { value: 'top',    label: t('cms_site.blocks.content.valign_top', 'Top') },
    { value: 'center', label: t('cms_site.blocks.content.valign_center', 'Center') },
    { value: 'bottom', label: t('cms_site.blocks.content.valign_bottom', 'Bottom') },
];

// Content keeps its own background vocabulary (none/light/dark/primary),
// distinct from the shared default/surface/primary/dark variant scale.
const backgrounds = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { value: 'none',    label: t('cms_site.blocks.content.bg_none', 'None (page bg)') },
    { value: 'light',   label: t('cms_site.blocks.content.bg_light', 'Light surface') },
    { value: 'dark',    label: t('cms_site.blocks.content.bg_dark', 'Dark') },
    { value: 'primary', label: t('cms_site.blocks.content.bg_primary', 'Brand primary') },
];

const aligns = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { value: 'left',   label: t('cms_site.blocks.content.align_left', 'Left') },
    { value: 'center', label: t('cms_site.blocks.content.align_center', 'Center') },
    { value: 'right',  label: t('cms_site.blocks.content.align_right', 'Right') },
];

const elementKinds = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { value: 'text',   label: t('cms_site.blocks.content.kind_text', 'Text'),   icon: 'Type'    },
    { value: 'image',  label: t('cms_site.blocks.content.kind_image', 'Image'),  icon: 'Image'   },
    { value: 'video',  label: t('cms_site.blocks.content.kind_video', 'Video'),  icon: 'Video'   },
    { value: 'iframe', label: t('cms_site.blocks.content.kind_embed', 'Embed'),  icon: 'Globe'   },
    { value: 'cta',    label: t('cms_site.blocks.content.kind_button', 'Button'), icon: 'Square'  },
];

// How many columns each layout token lays out. Used when the user picks a
// new layout so we add/remove columns to match — preserving content where
// possible and warning before dropping a non-empty column.
const COLUMN_COUNT_FOR_LAYOUT: Record<string, number> = {
    '1': 1, '2': 2, '3': 3, '1-2': 2, '2-1': 2,
};

export function ContentEditor({ data = {}, pages = [], onChange }: ContentEditorProps) {
    const { t } = useTranslation();
    // Always read through the migration helper. If `data` is already in
    // the new shape, this is a no-op; if it's legacy, the editor sees the
    // converted shape and the very next user edit persists it.
    const c = migrateLegacyContent(data) as ContentData & { columns: ContentColumn[] };
    const setField = (key: string, value: string) => onChange({ ...c, [key]: value });
    const { confirm, confirmDialog } = useConfirm();
    const handleLayoutChange = async (nextLayout: string) => {
        const targetCount = COLUMN_COUNT_FOR_LAYOUT[nextLayout] || 1;
        const current = Array.isArray(c.columns) ? c.columns : [];
        let nextColumns: ContentColumn[];
        if (targetCount === current.length) {
            nextColumns = current;
        } else if (targetCount > current.length) {
            // Pad with empty columns so the user can immediately fill them.
            nextColumns = current.slice();
            while (nextColumns.length < targetCount) nextColumns.push(makeColumn());
        } else {
            // Dropping columns — warn if the to-be-removed ones aren't empty.
            const dropped = current.slice(targetCount);
            const hasContent = dropped.some(col => Array.isArray(col?.elements) && col.elements.length > 0);
            if (hasContent) {
                const labels = dropped
                    .map((_, i) => t('cms_site.blocks.content.column_n', 'Column {n}', { n: targetCount + i + 1 }))
                    .join(', ');
                const ok = await confirm({ title: t('cms_site.blocks.content.columns_contain_elements', '{columns} contain elements.', { columns: labels }), description: t('cms_site.blocks.content.remove_anyway', 'Remove anyway?'), confirmLabel: t('cms_site.blocks.content.remove', 'Remove'), destructive: true });
                if (!ok) return;
            }
            nextColumns = current.slice(0, targetCount);
        }
        onChange({ ...c, columnLayout: nextLayout, columns: nextColumns });
    };
    const updateColumn = (idx: number, nextCol: ContentColumn) => {
        const cols = c.columns.slice();
        cols[idx] = nextCol;
        onChange({ ...c, columns: cols });
    };
    return (
        <>
            <InlineHint>
                {t('cms_site.blocks.content.each_column_holds_a_stack_of_elements', 'Each column holds a stack of elements (text, image, video, embed, button). Click any text in the preview to edit it inline.')}
            </InlineHint>
            {/* ── Layout ─────────────────────────────────────────── */}
            <CollapsibleCard title={t('cms_site.blocks.content.layout', 'Layout')} defaultOpen={true} persistKey="blk.content.layout">
                <FieldRow label={t('cms_site.blocks.content.column_layout', 'Column layout')}>
                    <SegmentedControl
                        options={columnLayouts(t)}
                        value={c.columnLayout}
                        onChange={handleLayoutChange}
                    />
                </FieldRow>
                <FieldSelect
                    label={t('cms_site.blocks.content.vertical_align', 'Vertical align')}
                    value={c.verticalAlign || 'top'}
                    options={valigns(t)}
                    onChange={v => setField('verticalAlign', v)}
                />
                <BackgroundVariantSelect
                    label={t('cms_site.blocks.content.background', 'Background')}
                    value={c.background || 'none'}
                    options={backgrounds(t)}
                    onChange={v => setField('background', v)}
                />
            </CollapsibleCard>
            {/* ── Columns ────────────────────────────────────────── */}
            <div className="text-xs font-semibold text-[var(--text-secondary)] mb-2">{t('cms_site.blocks.content.columns', 'Columns')}</div>
            {c.columns.map((col, colIdx) => (
                <ColumnPanel
                    key={col.id || colIdx}
                    col={col}
                    colIdx={colIdx}
                    pages={pages}
                    onChange={(nextCol) => updateColumn(colIdx, nextCol)}
                />
            ))}
            {confirmDialog}
        </>
    );
}

// ── Column panel ───────────────────────────────────────────────────────

function ColumnPanel({ col, colIdx, pages, onChange }: ColumnPanelProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(true);
    const elements = Array.isArray(col?.elements) ? col.elements : [];
    const updateElements = (next: ContentElement[]) => onChange({ ...col, elements: next });
    const addElement = (kind: string) => {
        updateElements([...elements, makeElement(kind)]);
    };
    return (
        <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 mb-3">
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="flex w-full items-center justify-between text-xs text-[var(--text-secondary)] mb-2"
            >
                <span className="flex items-center gap-1.5">
                    <span className={`${open ? '[transform:rotate(0)]' : '[transform:rotate(-90deg)]'}`} aria-hidden>▾</span>
                    <span className="font-medium">{t('cms_site.blocks.content.column_n', 'Column {n}', { n: colIdx + 1 })}</span>
                    <span className="text-[var(--text-muted)]">· {elements.length === 1
                        ? t('cms_site.blocks.content.one_element', '1 element')
                        : t('cms_site.blocks.content.n_elements', '{count} elements', { count: elements.length })}</span>
                </span>
            </button>

            {open ? (
                <>
                    <RepeatableList
                        items={elements}
                        onChange={updateElements}
                        makeNew={() => makeElement('text')}
                        itemLabel={(el) => {
                            const k = elementKinds(t).find(x => x.value === el?.kind);
                            return k ? k.label : (el?.kind || t('cms_site.blocks.content.element', 'Element'));
                        }}
                        collapsible
                        addLabel={t('cms_site.blocks.content.add_element', 'Add element')}
                        renderItem={(el, update) => (
                            <ElementFields el={el} pages={pages} update={update} />
                        )}
                    />

                    {/* Quick-add buttons next to "+ Add element" — saves a
                        click + a kind change on the first new element. */}
                    <div className="flex flex-wrap gap-1.5 mt-1">
                        {elementKinds(t).map(k => (
                            <button
                                key={k.value}
                                type="button"
                                onClick={() => addElement(k.value)}
                                className="px-2 py-1 text-[11px] rounded-md border border-dashed border-[var(--border-default)] text-[var(--text-muted)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] transition-colors"
                            >
                                + {k.label}
                            </button>
                        ))}
                    </div>
                </>
            ) : null}
        </div>
    );
}

// ── Element field renderer (per-kind) ──────────────────────────────────

function ElementFields({ el, pages, update }: ElementFieldsProps) {
    const { t } = useTranslation();
    const setKind = (nextKind: string) => {
        if (nextKind === el.kind) return;
        // Preserve the id when changing kind so RepeatableList's collapse
        // state for this row stays attached, but otherwise reset to the
        // new kind's defaults — fields don't share semantics across kinds.
        const fresh = makeElement(nextKind);
        update({ ...fresh, id: el.id });
    };

    return (
        <>
            <FieldSelect
                label={t('cms_site.blocks.content.element_type', 'Element type')}
                value={el.kind || 'text'}
                options={elementKinds(t).map(k => ({ value: k.value, label: k.label }))}
                onChange={setKind}
            />

            {el.kind === 'text' ? <TextElementFields el={el} update={update} t={t} /> : null}

            {el.kind === 'image' ? <ImageElementFields el={el} update={update} t={t} /> : null}

            {el.kind === 'video' ? <VideoElementFields el={el} update={update} t={t} /> : null}

            {el.kind === 'iframe' ? <IframeElementFields el={el} update={update} t={t} /> : null}

            {el.kind === 'cta' ? <CtaElementFields el={el} update={update} pages={pages} alignOptions={aligns(t)} t={t} /> : null}
        </>
    );
}
