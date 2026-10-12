import React, { useState } from 'react';
import { ClipFields } from './ClipFields';
import { useTranslation } from '../../../../hooks/useTranslation';
import {
    migrateLegacyContent,
    makeColumn,
    makeElement,
} from '../../../../marketing/sections/contentMigration';
import useConfirm from '../../../shared/useConfirm';
import { TextField, Toggle, ImageField, RepeatableList, LinkField, FieldRow, inputCls } from '../fields';
import {
    InlineHint,
    CollapsibleCard,
    StyleTriplet,
    FieldSelect,
    CtaStyleSelect,
    BackgroundVariantSelect,
    SegmentedControl,
} from '../primitives';

// ── Content (generic flexible block) ─────────────────────────────────

// Layout, element, and migration helpers live in the marketing-side
// module so the editor and the renderer share one source of truth on
// shape conversion + defaults.

const columnLayouts = (t) => [
    { value: '1',   label: '1',         hint: t('cms_site.blocks.content.layout_single_column', 'Single column') },
    { value: '2',   label: '1 │ 1', hint: t('cms_site.blocks.content.layout_two_equal_columns', 'Two equal columns') },
    { value: '3',   label: '1│ 1│ 1', hint: t('cms_site.blocks.content.layout_three_equal_columns', 'Three equal columns') },
    { value: '1-2', label: '1 │ 2', hint: t('cms_site.blocks.content.layout_narrow_wide', 'Narrow | Wide') },
    { value: '2-1', label: '2 │ 1', hint: t('cms_site.blocks.content.layout_wide_narrow', 'Wide | Narrow') },
];

const valigns = (t) => [
    { value: 'top',    label: t('cms_site.blocks.content.valign_top', 'Top') },
    { value: 'center', label: t('cms_site.blocks.content.valign_center', 'Center') },
    { value: 'bottom', label: t('cms_site.blocks.content.valign_bottom', 'Bottom') },
];

// Content keeps its own background vocabulary (none/light/dark/primary),
// distinct from the shared default/surface/primary/dark variant scale.
const backgrounds = (t) => [
    { value: 'none',    label: t('cms_site.blocks.content.bg_none', 'None (page bg)') },
    { value: 'light',   label: t('cms_site.blocks.content.bg_light', 'Light surface') },
    { value: 'dark',    label: t('cms_site.blocks.content.bg_dark', 'Dark') },
    { value: 'primary', label: t('cms_site.blocks.content.bg_primary', 'Brand primary') },
];

const aligns = (t) => [
    { value: 'left',   label: t('cms_site.blocks.content.align_left', 'Left') },
    { value: 'center', label: t('cms_site.blocks.content.align_center', 'Center') },
    { value: 'right',  label: t('cms_site.blocks.content.align_right', 'Right') },
];

const elementKinds = (t) => [
    { value: 'text',   label: t('cms_site.blocks.content.kind_text', 'Text'),   icon: 'Type'    },
    { value: 'image',  label: t('cms_site.blocks.content.kind_image', 'Image'),  icon: 'Image'   },
    { value: 'video',  label: t('cms_site.blocks.content.kind_video', 'Video'),  icon: 'Video'   },
    { value: 'iframe', label: t('cms_site.blocks.content.kind_embed', 'Embed'),  icon: 'Globe'   },
    { value: 'cta',    label: t('cms_site.blocks.content.kind_button', 'Button'), icon: 'Square'  },
];

// How many columns each layout token lays out. Used when the user picks a
// new layout so we add/remove columns to match — preserving content where
// possible and warning before dropping a non-empty column.
const COLUMN_COUNT_FOR_LAYOUT = {
    '1': 1, '2': 2, '3': 3, '1-2': 2, '2-1': 2,
};

export function ContentEditor({ data = {}, pages = [], onChange }) {
    const { t } = useTranslation();
    // Always read through the migration helper. If `data` is already in
    // the new shape, this is a no-op; if it's legacy, the editor sees the
    // converted shape and the very next user edit persists it.
    const c = migrateLegacyContent(data);
    const setField = (key, value) => onChange({ ...c, [key]: value });
    const { confirm, confirmDialog } = useConfirm();

    const handleLayoutChange = async (nextLayout) => {
        const targetCount = COLUMN_COUNT_FOR_LAYOUT[nextLayout] || 1;
        const current = Array.isArray(c.columns) ? c.columns : [];
        let nextColumns;
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

    const updateColumn = (idx, nextCol) => {
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

export function ColumnPanel({ col, colIdx, pages, onChange }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(true);
    const elements = Array.isArray(col?.elements) ? col.elements : [];

    const updateElements = (next) => onChange({ ...col, elements: next });
    const addElement = (kind) => {
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
                    <span style={{ transform: open ? 'rotate(0)' : 'rotate(-90deg)' }} aria-hidden>▾</span>
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

export function ElementFields({ el, pages, update }) {
    const { t } = useTranslation();
    const setKind = (nextKind) => {
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

            {el.kind === 'text' ? (
                <>
                    <TextField
                        label={t('cms_site.blocks.content.heading', 'Heading')}
                        value={el.heading || ''}
                        onChange={v => update({ ...el, heading: v })}
                        placeholder={t('cms_site.blocks.content.optional_heading', 'Optional heading')}
                        align={el.headingAlign || el.align || 'left'}
                        onAlignChange={v => update({ ...el, headingAlign: v })}
                    />
                    <TextField
                        label={t('cms_site.blocks.content.subheading', 'Subheading')}
                        value={el.subheading || ''}
                        onChange={v => update({ ...el, subheading: v })}
                        placeholder={t('cms_site.blocks.content.optional_subheading', 'Optional subheading')}
                        align={el.subheadingAlign || el.align || 'left'}
                        onAlignChange={v => update({ ...el, subheadingAlign: v })}
                    />
                    <TextField
                        label={t('cms_site.blocks.content.body', 'Body')}
                        value={el.body || ''}
                        onChange={v => update({ ...el, body: v })}
                        placeholder={t('cms_site.blocks.content.write_paragraph_text_line_breaks_are', 'Write paragraph text. Line breaks are preserved.')}
                        align={el.bodyAlign || el.align || 'left'}
                        onAlignChange={v => update({ ...el, bodyAlign: v })}
                    />
                    {/* Per-text-element typography. Stored under
                        element.headingStyle / subheadingStyle / bodyStyle. */}
                    <CollapsibleCard title={t('cms_site.blocks.content.text_styles', 'Text styles')} defaultOpen={false}>
                        <StyleTriplet
                            label={t('cms_site.blocks.content.heading', 'Heading')}
                            value={el.headingStyle}
                            onChange={v => update({ ...el, headingStyle: v })}
                            sample={el.heading || t('cms_site.blocks.content.heading_preview', 'Heading preview')}
                            weight={700}
                            min={12} max={96}
                        />
                        <StyleTriplet
                            label={t('cms_site.blocks.content.subheading', 'Subheading')}
                            value={el.subheadingStyle}
                            onChange={v => update({ ...el, subheadingStyle: v })}
                            sample={el.subheading || t('cms_site.blocks.content.subheading_preview', 'Subheading preview')}
                            weight={500}
                            min={10} max={48}
                        />
                        <StyleTriplet
                            label={t('cms_site.blocks.content.body', 'Body')}
                            value={el.bodyStyle}
                            onChange={v => update({ ...el, bodyStyle: v })}
                            sample={el.body || 'The quick brown fox jumps over the lazy dog.'}
                            weight={400}
                            min={10} max={32}
                        />
                    </CollapsibleCard>
                </>
            ) : null}

            {el.kind === 'image' ? (
                <>
                    <ImageField
                        label={t('cms_site.blocks.content.image', 'Image')}
                        value={el.src || ''}
                        onChange={v => update({ ...el, src: v })}
                    />
                    <TextField
                        label={t('cms_site.blocks.content.alt_text', 'Alt text')}
                        value={el.alt || ''}
                        onChange={v => update({ ...el, alt: v })}
                        placeholder={t('cms_site.blocks.content.describe_the_image', 'Describe the image')}
                    />
                    <FieldSelect
                        label={t('cms_site.blocks.content.aspect_ratio', 'Aspect ratio')}
                        value={el.aspectRatio || 'auto'}
                        options={[
                            { value: 'auto', label: t('cms_site.blocks.content.aspect_auto', 'Auto (intrinsic)') },
                            { value: '16/9', label: '16:9' },
                            { value: '4/3',  label: '4:3'  },
                            { value: '1/1',  label: '1:1'  },
                            { value: '3/4',  label: '3:4'  },
                        ]}
                        onChange={v => update({ ...el, aspectRatio: v })}
                    />
                    {/* Premium frame — routes through FramedMedia. Framed
                        images use the frame's own box (aspect-ratio crop is
                        skipped) and win over the lightbox toggle. */}
                    <FieldSelect
                        label={t('cms_site.blocks.content.frame', 'Frame')}
                        value={el.frame || ''}
                        options={[
                            { value: '',         label: t('cms_site.blocks.content.frame_none', 'None') },
                            { value: 'hairline', label: t('cms_site.blocks.content.frame_hairline', 'Hairline frame') },
                            { value: 'browser',  label: t('cms_site.blocks.content.frame_browser', 'Browser window') },
                        ]}
                        onChange={v => update({ ...el, frame: v })}
                    />
                    <Toggle
                        label={t('cms_site.blocks.content.rounded_corners', 'Rounded corners')}
                        value={!!el.rounded}
                        onChange={v => update({ ...el, rounded: v })}
                    />
                    <Toggle
                        label={t('cms_site.blocks.content.full_width_image', 'Full width image')}
                        value={!!el.fullBleed}
                        onChange={v => update({ ...el, fullBleed: v })}
                    />
                    <Toggle
                        label={t('cms_site.blocks.content.click_to_enlarge_lightbox', 'Click to enlarge (lightbox)')}
                        value={!!el.lightbox}
                        onChange={v => update({ ...el, lightbox: v })}
                    />
                    <TextField
                        label={t('cms_site.blocks.content.caption', 'Caption')}
                        value={el.caption || ''}
                        onChange={v => update({ ...el, caption: v })}
                        placeholder={t('cms_site.blocks.content.optional_caption', 'Optional caption')}
                    />
                </>
            ) : null}

            {el.kind === 'video' ? (
                <>
                    {/* Source toggle: external embed (YouTube/Vimeo iframe)
                        vs. self-hosted file upload (MP4/WebM, looped + muted
                        like the Media + Text 'video-silent' kind). Both paths
                        write the resulting address to el.url so the renderer
                        only has one field to read. */}
                    <FieldSelect
                        label={t('cms_site.blocks.content.source', 'Source')}
                        value={el.source === 'upload' || el.source === 'clip' ? el.source : 'embed'}
                        options={[
                            { value: 'embed',  label: t('cms_site.blocks.content.source_embed', 'External URL (YouTube / Vimeo)') },
                            { value: 'upload', label: t('cms_site.blocks.content.source_upload', 'Upload file (silent loop, MP4 / WebM)') },
                            { value: 'clip',   label: t('cms_site.blocks.content.source_clip', 'Clip (video with sound)') },
                        ]}
                        onChange={v => update({ ...el, source: v, url: '' })}
                    />
                    {el.source === 'clip' ? (
                        <ClipFields value={el} srcKey="url" onPatch={patch => update({ ...el, ...patch })} />
                    ) : el.source === 'upload' ? (
                        <ImageField
                            label={t('cms_site.blocks.content.video_file', 'Video file')}
                            value={el.url || ''}
                            onChange={v => update({ ...el, url: v })}
                            accept="video/mp4,video/webm"
                            previewKind="video"
                            uploadLabel={t('cms_site.blocks.content.upload_video', 'Upload video')}
                            placeholder="https://… or /api/cms/asset/cms/…"
                        />
                    ) : (
                        <TextField
                            label={t('cms_site.blocks.content.video_url', 'Video URL')}
                            value={el.url || ''}
                            onChange={v => update({ ...el, url: v })}
                            placeholder={t('cms_site.blocks.content.youtube_or_vimeo_url', 'YouTube or Vimeo URL')}
                        />
                    )}
                    <FieldSelect
                        label={t('cms_site.blocks.content.aspect_ratio', 'Aspect ratio')}
                        value={el.aspectRatio || '16/9'}
                        options={[
                            { value: '16/9', label: '16:9' },
                            { value: '4/3',  label: '4:3'  },
                            { value: '1/1',  label: '1:1'  },
                        ]}
                        onChange={v => update({ ...el, aspectRatio: v })}
                    />
                    <TextField
                        label={t('cms_site.blocks.content.caption', 'Caption')}
                        value={el.caption || ''}
                        onChange={v => update({ ...el, caption: v })}
                        placeholder={t('cms_site.blocks.content.optional_caption', 'Optional caption')}
                    />
                </>
            ) : null}

            {el.kind === 'iframe' ? (
                <>
                    <TextField
                        label={t('cms_site.blocks.content.embed_url', 'Embed URL')}
                        value={el.src || ''}
                        onChange={v => update({ ...el, src: v })}
                        placeholder={t('cms_site.blocks.content.embed_url_placeholder', 'https://… (chat agent, Calendly, Map, …)')}
                    />
                    <FieldRow label={t('cms_site.blocks.content.height_px', 'Height (px)')}>
                        <input
                            type="number"
                            min={120}
                            max={2000}
                            step={20}
                            className={inputCls}
                            value={Number.isFinite(el.height) ? el.height : 480}
                            onChange={e => update({ ...el, height: Number(e.target.value) || 480 })}
                        />
                    </FieldRow>
                    <TextField
                        label={t('cms_site.blocks.content.accessible_label', 'Accessible label')}
                        value={el.label || ''}
                        onChange={v => update({ ...el, label: v })}
                        placeholder={t('cms_site.blocks.content.used_as_the_iframe_title_attribute', 'Used as the iframe title attribute')}
                    />
                    <Toggle
                        label={t('cms_site.blocks.content.allow_scrolling', 'Allow scrolling')}
                        value={!!el.scrolling}
                        onChange={v => update({ ...el, scrolling: v })}
                    />
                </>
            ) : null}

            {el.kind === 'cta' ? (
                <>
                    <TextField
                        label={t('cms_site.blocks.content.label', 'Label')}
                        value={el.label || ''}
                        onChange={v => update({ ...el, label: v })}
                    />
                    <LinkField
                        label={t('cms_site.blocks.content.link', 'Link')}
                        value={el.link}
                        pages={pages}
                        onChange={v => update({ ...el, link: v })}
                    />
                    <CtaStyleSelect
                        value={el.style || 'primary'}
                        onChange={v => update({ ...el, style: v })}
                    />
                    <FieldSelect
                        label={t('cms_site.blocks.content.align', 'Align')}
                        value={el.align || 'left'}
                        options={aligns(t)}
                        onChange={v => update({ ...el, align: v })}
                    />
                </>
            ) : null}
        </>
    );
}
