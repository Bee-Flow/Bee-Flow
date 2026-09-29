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
 * The buttons re-apply; the selected one is filled in the accent, like
 * every primary choice in the builder.
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
    const [moreOpen, setMoreOpen] = useState(false);
    // `actualKind` steers WHICH question gets asked (list / table / group) —
    // remediesFor is the one place that decides, so the box and the sentence
    // above it can never offer answers to different questions.
    const remedies = useMemo(
        () => remediesFor(path, sampleRoot, { allowForEach, itemVar, actualKind }),
        [path, sampleRoot, allowForEach, itemVar, actualKind],
    );
    const friendly = describeListPath(path, stepLabelById, t);
    const sentence = mismatchSentence({ actualKind, expectedKind, count: remedies.count }, t);

    const button = (r) => {
        const on = r.id === selectedId;
        const label = t(r.labelKey, r.labelEn, r.labelParams);
        return (
            <button
                key={r.id}
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
                {label}
            </button>
        );
    };

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
            <div className="flex flex-wrap gap-1.5">
                {remedies.primary.map(button)}
                <button
                    type="button"
                    onClick={() => setMoreOpen(o => !o)}
                    aria-expanded={moreOpen}
                    className="inline-flex items-center gap-1 px-2 py-[5px] rounded-lg text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                    {moreOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {t('routines.mismatch.more', 'more')}
                </button>
            </div>
            {moreOpen && (
                <div className="flex flex-wrap gap-1.5" data-testid="mismatch-more">
                    {remedies.more.map(button)}
                </div>
            )}
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {t('routines.builder.alt_bypass_tip', 'Tip: hold Alt while you click or drag to skip this and insert the list as it is.')}
            </div>
        </div>
    );
}
