import React, { useMemo } from 'react';
import { describeField, kindFits, KIND_WORD } from './fieldKinds';
import { useVariablePickerContext } from './VariablePickerContext';
import { useTranslation } from '../../../../hooks/useTranslation';
import FieldHint from '../flow/FieldHint';
import { fieldLabelClass, requiredMarkClass } from '../flow/settings/formStyles';

/**
 * The two pieces of chrome that belong to a value SLOT rather than to the
 * editor inside it: the label row and the empty-required note (artboard 2a).
 *
 * They were BindingField's private markup until ValueBuilder became the
 * default renderer for step-bound fields — at which point the same slot could
 * be drawn by either editor, and the label had to stop being an accident of
 * which one you got. Extracted verbatim: same classes, same testids, same
 * words, so nothing that already reads them notices the move.
 */

/** Label · required mark · "expects: date" · hint · the auto-mapped pill. */
export function FieldLabelRow({ label, required = false, expectKind = null, hint = null, autoMapped = false }) {
    const { t } = useTranslation();
    if (!label) return null;
    const expectWord = expectWordFor(expectKind, t);
    return (
        <div className="flex items-center gap-1">
            <label className={fieldLabelClass()}>{label}</label>
            {required && <span className={requiredMarkClass()} title="Required">*</span>}
            {expectWord && expectKind !== 'text' && (
                <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-[var(--text-tertiary)]" data-testid="binding-expects">
                    · {t('automations.builder.expects_kind', 'expects: {kind}', { kind: expectWord })}
                </span>
            )}
            <FieldHint title={label}>{hint}</FieldHint>
            {autoMapped && <AutoMappedPill kind={autoMapped} className="ml-auto" />}
        </div>
    );
}

/**
 * The calm "auto" pill on a slot the Auto-map wand filled. `kind === 'ai'`:
 * its AI fallback chose this one, not the deterministic matcher — same pill,
 * but it says so, because an AI pick is the one worth a second look.
 */
export function AutoMappedPill({ kind = true, className = '', title = null }) {
    const { t } = useTranslation();
    const ai = kind === 'ai';
    return (
        <span
            className={`${className} text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] uppercase tracking-wide`}
            title={ai
                ? t('automations.builder.auto_mapped_ai_title', 'Mapped by AI from an upstream step — check it, edit to override')
                : (title || 'Auto-mapped from an upstream step — edit to override')}
            data-testid={ai ? 'auto-mapped-ai' : undefined}
        >
            {ai ? t('automations.builder.auto_mapped_ai', 'auto · AI') : 'auto'}
        </span>
    );
}

/**
 * "still empty · expects: date · pick ▸ 2 fit" — shown only for a REQUIRED
 * slot with a known kind that holds nothing. The count is how many upstream
 * fields would fit, through fieldKinds.kindFits — the same "fits" the mismatch
 * box reasons with, so the two can never disagree.
 */
export function EmptySlotNote({ expectKind, empty, required = true, onPick = null }) {
    const { t } = useTranslation();
    const ctx = useVariablePickerContext();
    const groups = ctx.groups;
    const previewSample = ctx.previewSample;
    const fitCount = useMemo(() => {
        if (!expectKind || expectKind === 'unknown') return 0;
        let n = 0;
        const walk = (fields) => {
            for (const f of fields || []) {
                if (kindFits(describeField(f, previewSample).kind, expectKind)) n += 1;
                if (Array.isArray(f.children) && f.children.length) walk(f.children);
            }
        };
        for (const g of groups || []) walk(g.fields);
        return n;
    }, [groups, previewSample, expectKind]);

    if (!required || !empty || !expectKind || expectKind === 'unknown') return null;
    // One quiet line, no box: the label row above already says what the slot
    // expects, and the footer counts what is still empty. This only says THIS
    // one is, and how many upstream fields would fit.
    return (
        <span
            className="inline-flex items-center gap-1.5 text-[10px] text-[var(--error)]"
            data-testid="binding-empty-required"
        >
            <span>{t('automations.builder.still_empty', 'still empty')}</span>
            {onPick && fitCount > 0 && (
                <button
                    type="button"
                    onClick={onPick}
                    className="underline hover:no-underline text-[var(--text-secondary)]"
                >
                    {t('automations.builder.pick_n_fit', 'pick ▸ {n} fit', { n: fitCount })}
                </button>
            )}
        </span>
    );
}

function expectWordFor(expectKind, t) {
    return expectKind && KIND_WORD[expectKind] ? t(KIND_WORD[expectKind].key, KIND_WORD[expectKind].en) : '';
}
