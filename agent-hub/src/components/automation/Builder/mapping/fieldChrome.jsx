import React from 'react';
import { KIND_WORD } from './fieldKinds';
import { useTranslation } from '../../../../hooks/useTranslation';
import FieldHint from '../flow/FieldHint';
import { fieldLabelClass, requiredMarkClass } from '../flow/settings/formStyles';

/**
 * The two pieces of chrome that belong to a value SLOT rather than to the
 * editor inside it: the label row and the empty-required note (artboard 2a).
 *
 * They were BindingField's private markup until the visual editor (today the
 * value slot) became the default renderer for step-bound fields — at which point the same slot could
 * be drawn by either editor, and the label had to stop being an accident of
 * which one you got. The testids stayed, so nothing that reads them
 * noticed the move.
 */

/** Label · required mark · the kind in one word ("date") · hint · the auto-mapped pill. */
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
                    · {expectWord}
                </span>
            )}
            <FieldHint title={label}>{hint}</FieldHint>
            {autoMapped && (
                <span
                    className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] uppercase tracking-wide"
                    title="Auto-mapped from an upstream step — edit to override"
                >
                    auto
                </span>
            )}
        </div>
    );
}

/**
 * One muted line under a REQUIRED slot that holds nothing: that it is
 * required, nothing more. The placeholder already says how to fill it, the
 * field's ⋯ offers the picker, and the footer counts what is still empty;
 * the red dashed box with "expects: text · pick ▸ 10 fit" said all three
 * again, in jargon, on every empty field.
 */
export function EmptySlotNote({ empty, required = true }) {
    const { t } = useTranslation();
    if (!required || !empty) return null;
    return (
        <div className="text-[11px] text-[var(--text-tertiary)]" data-testid="binding-empty-required">
            {t('mapping.slot.required_empty', 'Required before this step can run.')}
        </div>
    );
}

function expectWordFor(expectKind, t) {
    return expectKind && KIND_WORD[expectKind] ? t(KIND_WORD[expectKind].key, KIND_WORD[expectKind].en) : '';
}
