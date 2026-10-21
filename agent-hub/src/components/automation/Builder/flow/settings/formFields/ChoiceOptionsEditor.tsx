import { useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { denseInputClass, textareaClass } from '../formPrimitives';
import { hasDetails, joinOptions, mergeLines, setDetail, splitOptions, visibleRows } from './choiceOptionsModel';
import type { FieldEditorProps } from './fieldEditor.types';
import SourceSpecEditor from './SourceSpecEditor';

const LABEL = 'text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]';
const HINT = 'text-[10px] text-[var(--text-tertiary)]';

/**
 * The choices of a dropdown, radio buttons or several-choices question.
 *
 * Two sources: a fixed list typed here (one per line, with an optional label
 * and hint per choice), or, on a later page, a list from an earlier step (the
 * run's own data: the answer is the choice's VALUE, the label is only what
 * people read). Choosing "From an earlier step" keeps the typed list in
 * place; the server prefers the list from the run, and switching back is one
 * click.
 */
export default function ChoiceOptionsEditor({ field, index, onChange, allowVariables = false, onFocusField = null, previewSample = null }: FieldEditorProps) {
    const { t } = useTranslation();
    const fromRun = !!field.optionsFrom;
    return (
        <div className="space-y-1.5">
            {allowVariables && (
                <div role="group" aria-label={t('automations.form_wizard.options_source', 'Where the choices come from')} className="flex gap-1">
                    {([
                        [false, t('automations.form_wizard.source_fixed', 'Fixed list')],
                        [true, t('automations.form_wizard.source_run', 'From an earlier step')],
                    ] as const).map(([run, text]) => (
                        <button
                            key={String(run)}
                            type="button"
                            aria-pressed={fromRun === run}
                            onClick={() => onChange({ optionsFrom: run ? (field.optionsFrom || { ref: '' }) : undefined })}
                            className={`px-2 py-1 rounded-md text-[11px] border transition ${
                                fromRun === run
                                    ? 'border-[var(--accent)] text-[var(--text-primary)] bg-[var(--accent)]/10'
                                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                            }`}
                        >
                            {text}
                        </button>
                    ))}
                </div>
            )}
            {fromRun && allowVariables ? (
                <SourceSpecEditor
                    spec={field.optionsFrom}
                    onChange={(optionsFrom) => onChange({ optionsFrom })}
                    kind="choices"
                    ariaBase={`Question ${index + 1} choices`}
                    previewSample={previewSample}
                    onFocusField={onFocusField}
                />
            ) : (
                <FixedList field={field} index={index} onChange={onChange} />
            )}
            {field.type === 'multiselect' && <SelectedBounds field={field} index={index} onChange={onChange} />}
        </div>
    );
}

function FixedList({ field, index, onChange }: Pick<FieldEditorProps, 'field' | 'index' | 'onChange'>) {
    const { t } = useTranslation();
    // The textarea keeps its OWN text. The stored array is trimmed and
    // blank-free, so deriving the value from it would eat the trailing space or
    // newline the moment one is typed: the write-back is synchronous, the join
    // recomputes without that character, and React re-asserts node.value — the
    // keystroke is reverted on its own event and the caret jumps to the end of
    // the box. Same mechanism, same cure as App Studio's AiChatInspector.
    const joined = joinOptions(field.options);
    const [text, setText] = useState(joined);
    // Our own echo round-trips to the same list, so this stays equal while
    // typing. Only an edit from OUTSIDE (an undo, the AI builder, a reordered
    // card reusing this index) disagrees, and that is what we adopt.
    if (splitOptions(text).join('\n') !== splitOptions(joined).join('\n')) setText(joined);
    const [showDetails, setShowDetails] = useState(() => hasDetails(field.options));
    const rows = visibleRows(field.options);
    const n = index + 1;
    return (
        <div className="space-y-0.5">
            <div className={LABEL}>{t('automations.form_builder_fields.choices_one_per_line', 'Choices (one per line)')}</div>
            <textarea
                rows={4}
                aria-label={`Question ${n} choices`}
                value={text}
                onChange={(e) => {
                    setText(e.target.value);
                    onChange({ options: mergeLines(splitOptions(e.target.value), field.options) });
                }}
                className={textareaClass()}
                placeholder={'Red\nGreen\nBlue'}
            />
            {rows.length > 0 && (
                <button
                    type="button"
                    aria-expanded={showDetails}
                    onClick={() => setShowDetails(v => !v)}
                    className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                    {showDetails
                        ? t('automations.form_wizard.hide_choice_details', 'Hide labels and hints')
                        : t('automations.form_wizard.show_choice_details', 'Show a different label or a hint')}
                </button>
            )}
            {showDetails && rows.length > 0 && (
                <div className="space-y-1 pt-0.5">
                    <p className={HINT}>
                        {t('automations.form_wizard.choice_details_help', 'The answer stored is the choice itself. A label is only what people read; a hint is a short note under it.')}
                    </p>
                    {rows.map((r, i) => (
                        <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1">
                            <span className="truncate text-[11px] text-[var(--text-primary)]" title={r.value}>{r.value}</span>
                            <input
                                type="text"
                                aria-label={`Question ${n} choice ${i + 1} label`}
                                value={r.label || ''}
                                onChange={(e) => onChange({ options: setDetail(field.options, i, 'label', e.target.value) })}
                                className={denseInputClass('w-full')}
                                placeholder={t('automations.form_wizard.choice_label_placeholder', 'Label')}
                            />
                            <input
                                type="text"
                                aria-label={`Question ${n} choice ${i + 1} hint`}
                                value={r.hint || ''}
                                onChange={(e) => onChange({ options: setDetail(field.options, i, 'hint', e.target.value) })}
                                className={denseInputClass('w-full')}
                                placeholder={t('automations.form_wizard.choice_hint_placeholder', 'Hint')}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** The fewest and most choices a several-choices question accepts. */
function SelectedBounds({ field, index, onChange }: Pick<FieldEditorProps, 'field' | 'index' | 'onChange'>) {
    const { t } = useTranslation();
    const count = (v: string) => (v === '' ? undefined : Math.max(0, Math.floor(Number(v)) || 0));
    const min = field.minSelected;
    const max = field.maxSelected;
    const inverted = min !== undefined && max !== undefined && min > max;
    return (
        <div className="space-y-0.5">
            <div className="flex items-center gap-2">
                <label className="flex-1 min-w-0 space-y-0.5">
                    <span className={LABEL}>{t('automations.form_wizard.min_selected', 'Pick at least')}</span>
                    <input type="number" min={0} aria-label={`Question ${index + 1} minimum choices`} value={min ?? ''} onChange={(e) => onChange({ minSelected: count(e.target.value) })} className={denseInputClass('w-full')} />
                </label>
                <label className="flex-1 min-w-0 space-y-0.5">
                    <span className={LABEL}>{t('automations.form_wizard.max_selected', 'Pick at most')}</span>
                    <input type="number" min={0} aria-label={`Question ${index + 1} maximum choices`} value={max ?? ''} onChange={(e) => onChange({ maxSelected: count(e.target.value) })} className={denseInputClass('w-full')} />
                </label>
            </div>
            {inverted && (
                <p role="alert" className="text-[10px] text-amber-600 dark:text-amber-500">
                    {t('automations.form_wizard.min_above_max', 'The minimum is higher than the maximum, so nobody could answer.')}
                </p>
            )}
        </div>
    );
}
