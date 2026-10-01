import { X, ChevronDown, ChevronRight } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import FieldKindIcon from './FieldKindIcon';
import { describeListPath } from './listShape';
import { mismatchSentence, remediesFor } from './mismatch';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * The inline "it doesn't fit" box (artboard 2a). Lives UNDER the field it is
 * about — no portal, no popover, no outside-click, no Escape: it is part of
 * the form, and it stays until the author is happy or closes it.
 *
 * The first choice is already applied when this renders (BindingField wrote
 * the default remedy the moment the list was picked), so the field is never
 * left empty and the question can never be dismissed into a broken binding.
 * The choice buttons stay collapsed behind a "List options" disclosure
 * (BFSF-482): the collapsed box names the source and shows the applied choice
 * as a chip, so linking data never turns the field into a wall of controls.
 * Expanded, the buttons re-apply; the selected one is filled in the accent,
 * like every primary choice in the builder.
 *
 * Props:
 *   path, sampleRoot, stepLabelById — what was picked, and how to name it
 *   actualKind, expectedKind        — the two words in the sentence
 *   selectedId                      — which remedy the field currently holds
 *   allowForEach, itemVar           — offer "a separate run for each item"
 *   onChoose({ id, binding, forEach?, itemVar? })
 *   onClose()
 */
export default function MismatchResolver({
    path, sampleRoot = null, stepLabelById = null,
    actualKind = 'list', expectedKind = 'text',
    selectedId = 'join', allowForEach = false, itemVar = undefined,
    onChoose, onClose = null,
}) {
    const { t } = useTranslation();
    // Progressive disclosure (BFSF-482): the box used to open with every
    // choice expanded, so linking a list turned one field into a wall of
    // mapping controls. The default remedy is already written when this
    // renders, so the collapsed state only has to SAY what the field now
    // holds — the full choice list sits one click behind "List options".
    const [optionsOpen, setOptionsOpen] = useState(false);
    // `actualKind` steers WHICH question gets asked (list / table / group) —
    // remediesFor is the one place that decides, so the box and the sentence
    // above it can never offer answers to different questions.
    const remedies = useMemo(
        () => remediesFor(path, sampleRoot, { allowForEach, itemVar, actualKind }),
        [path, sampleRoot, allowForEach, itemVar, actualKind],
    );
    const friendly = describeListPath(path, stepLabelById, t);
    const sentence = mismatchSentence({ actualKind, expectedKind, count: remedies.count }, t);
    // The remedy the field currently holds — shown as the collapsed summary.
    // `selectedId` can name a "more" remedy (BindingField's "choose how to use
    // the list" enters on `each`), so look in both lists.
    const selected = [...remedies.primary, ...remedies.more].find(r => r.id === selectedId) || null;
    const optionsLabel = {
        list: t('routines.mismatch.options_list', 'List options'),
        table: t('routines.mismatch.options_table', 'Table options'),
        group: t('routines.mismatch.options_group', 'Field options'),
    }[actualKind] || t('routines.mismatch.options_generic', 'Options');

    return (
        <div
            role="group"
            aria-label={t('routines.mismatch.title', 'This field and the value you picked do not fit one-to-one')}
            data-testid="mismatch-resolver"
            className="flex flex-col gap-2 px-2.5 py-2 rounded-lg text-[12px] border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_6%,transparent)]"
        >
            <div className="flex items-start gap-2">
                <span className="inline-flex items-center gap-1 px-1.5 rounded-full font-semibold whitespace-nowrap shrink-0 bg-[var(--bg-tertiary)] text-[var(--text-primary)]">
                    <FieldKindIcon kind={actualKind} size={11} />
                    {friendly}
                </span>
                <span className="text-[var(--text-secondary)] min-w-0">{sentence}</span>
                {onClose && (
                    <button type="button" onClick={onClose} aria-label={t('routines.builder.cancel', 'Cancel')} className="ml-auto shrink-0 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                        <X size={12} />
                    </button>
                )}
            </div>
            {optionsOpen
                ? <OptionsPanel remedies={remedies} selectedId={selectedId} onChoose={onChoose} onCollapse={() => setOptionsOpen(false)} />
                : <CollapsedSummary selected={selected} optionsLabel={optionsLabel} onExpand={() => setOptionsOpen(true)} />}
        </div>
    );
}

/** One remedy choice; the applied one is filled in the accent. */
function RemedyButton({ remedy: r, selectedId, onChoose }) {
    const { t } = useTranslation();
    const on = r.id === selectedId;
    return (
        <button
            type="button"
            disabled={!!r.disabled}
            aria-pressed={on}
            onClick={() => onChoose?.(r)}
            title={r.preview != null ? `→ ${r.preview}` : undefined}
            className={`px-2.5 py-[5px] rounded-lg text-[12px] transition disabled:opacity-50 disabled:cursor-not-allowed ${
                on
                    ? 'font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]'
                    : 'border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
        >
            {t(r.labelKey, r.labelEn, r.labelParams)}
        </button>
    );
}

/**
 * Collapsed: one quiet line saying what the field holds now — the applied
 * choice as a chip, the disclosure beside it. The Alt-bypass tip only matters
 * while choosing, so it lives in the expanded panel.
 */
function CollapsedSummary({ selected, optionsLabel, onExpand }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1.5 flex-wrap">
            {selected && (
                <span
                    data-testid="mismatch-selected"
                    title={selected.preview != null ? `→ ${selected.preview}` : undefined}
                    className="inline-flex items-center px-2 py-[3px] rounded-lg font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                >
                    {t(selected.labelKey, selected.labelEn, selected.labelParams)}
                </span>
            )}
            <button
                type="button"
                onClick={onExpand}
                aria-expanded={false}
                className="inline-flex items-center gap-1 px-2 py-[3px] rounded-lg text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline"
            >
                <ChevronRight size={12} />
                {optionsLabel}
            </button>
        </div>
    );
}

/** The full choice list: primary remedies, "more" for the rest, the tip. */
function OptionsPanel({ remedies, selectedId, onChoose, onCollapse }) {
    const { t } = useTranslation();
    const [moreOpen, setMoreOpen] = useState(false);
    return (
        <>
            <div className="flex flex-wrap gap-1.5">
                {remedies.primary.map(r => <RemedyButton key={r.id} remedy={r} selectedId={selectedId} onChoose={onChoose} />)}
                <button
                    type="button"
                    onClick={() => setMoreOpen(o => !o)}
                    aria-expanded={moreOpen}
                    className="inline-flex items-center gap-1 px-2 py-[5px] rounded-lg text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                    {moreOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {t('routines.mismatch.more', 'more')}
                </button>
                <button
                    type="button"
                    onClick={onCollapse}
                    aria-expanded={true}
                    className="inline-flex items-center gap-1 px-2 py-[5px] rounded-lg text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                    <ChevronDown size={12} />
                    {t('routines.mismatch.fewer', 'fewer')}
                </button>
            </div>
            {moreOpen && (
                <div className="flex flex-wrap gap-1.5" data-testid="mismatch-more">
                    {remedies.more.map(r => <RemedyButton key={r.id} remedy={r} selectedId={selectedId} onChoose={onChoose} />)}
                </div>
            )}
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {t('routines.builder.alt_bypass_tip', 'Tip: hold Alt while you click or drag to skip this and insert the list as it is.')}
            </div>
        </>
    );
}
