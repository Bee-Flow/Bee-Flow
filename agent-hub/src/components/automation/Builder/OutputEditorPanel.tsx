import { ChevronDown, ChevronRight } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { outputShape } from './outputDrafts';
import OutputFieldsEditor from './OutputFieldsEditor';
import { useTranslation } from '../../../hooks/useTranslation';
import type { TranslateFn } from '../../../hooks/useTranslation';

export interface OutputEditorPanelProps {
    /** The JSON text BOTH faces write — the one piece of state the cap weighs. */
    text: string;
    /** `Invalid JSON: <msg>`, or whatever the save refused with; null when clean. */
    error: string | null;
    saving: boolean;
    /** There is already a pinned output, so removing it means something. */
    canRemove: boolean;
    onChange: (text: string) => void;
    onApply: () => void;
    onRemove: () => void;
    onCancel: () => void;
    /** Only for a form node: seed the sheet with its declared answers, all empty. */
    onEmptyAnswers?: (() => void) | null;
}

/**
 * The hand-written-output sheet.
 *
 * The SAVE CONTRACT is the one this sheet has always had, and none of it
 * moves: nothing commits on a keystroke, an explicit Save parses once, an
 * `Invalid JSON: <msg>` line lands under the editor, and MAX_PINNED_BYTES is
 * measured before the PUT. It was copied from SettingsTab's JSON row when this
 * sheet was written; that row is gone now (its comment there says why — the
 * "Manual trigger payload (JSON)" had one writer and no reader, and became
 * this pinned output), so the contract is this file's own to keep. Still NOT
 * ConnectorsManager's JsonObjectField: that one commits on every keystroke,
 * and here a keystroke means a full definition PUT plus a row in
 * automation_versions.
 *
 * What the contract never said is that the AUTHOR HAS TO TYPE JSON. It used to
 * anyway — the sheet was one raw textarea — and the complaint this product
 * exists to answer ("not seeing JSON file structures, but datatables") applied
 * to it word for word, from the one screen where we ask a non-programmer to
 * hand-write a brace. A pinned output is almost always a handful of fields or
 * a couple of sample records, so that is the face now: named fields with a
 * value and a kind each, one block per record when the output is a list of
 * them. The kind words come from mapping/fieldKinds.js — the same vocabulary
 * the variable tree shows for the same data one column to the left, so the
 * word beside a field here is the word the picker downstream uses for it.
 *
 * The raw textarea is DEMOTED, never deleted. It is one disclosure away, it is
 * the same single element (still labelled `Output JSON`), and it OPENS BY
 * ITSELF for a shape the field list cannot honestly show — a bare scalar, a
 * list of strings, anything mixed — where it remains the whole sheet, exactly
 * as before. That is this product's standing rule about machine values: the
 * visible surface shows the sentence, the exact value stays reachable. A
 * nested field (a group, a list, a file) follows the same rule: the field list
 * says what it IS and never flattens it into a text box, and the raw editor is
 * where it gets edited.
 *
 * Both faces write ONE piece of state, the JSON text. That is what keeps the
 * cap honest: whichever face the author used, Save sees the same text, parses
 * it once and weighs the same bytes.
 */
function OutputEditorPanel({
    text, error, saving, canRemove, onChange, onApply, onRemove, onCancel, onEmptyAnswers,
}: OutputEditorPanelProps) {
    const { t } = useTranslation();
    const parsed = useMemo<unknown>(() => { try { return JSON.parse(text); } catch { return undefined; } }, [text]);
    const shape = outputShape(parsed);
    // Closed on a shape the field list can show; not a toggle at all on the
    // shapes it cannot, because there the raw editor is not an escape hatch —
    // it is the only editor, and a disclosure around it would hide the sheet.
    const [rawOpen, setRawOpen] = useState(false);
    const rawShown = rawOpen || !shape;
    return (
        <div className="flex-1 min-h-0 flex flex-col" data-testid="ndv-output-editor">
            <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)] leading-snug border-b border-[var(--border-default)]">
                {/* One sentence, one key — the line break above was wrapping,
                    not punctuation. */}
                {t('routines.ndv.output_editor_hint', 'What the steps after this one should see. Saved with the routine and replayed instead of running this step — so it is a stand-in for real data, not a note.')}
            </div>
            {shape && (
                <div className="flex-1 min-h-0 overflow-auto" data-testid="ndv-output-fields">
                    <OutputFieldsEditor shape={shape} text={text} onChange={onChange} />
                </div>
            )}
            {shape && (
                <button
                    type="button"
                    data-testid="ndv-output-raw-toggle"
                    onClick={() => setRawOpen(o => !o)}
                    aria-expanded={rawOpen}
                    className="flex items-center gap-1 px-3 py-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] border-t border-[var(--border-default)] transition"
                >
                    {rawOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {t('routines.ndv.output_json', 'Output JSON')}
                </button>
            )}
            {/* `hidden` AND no display class while closed: Tailwind's `flex`
                beats the attribute's UA rule, so a `hidden` element with a
                display utility on it stays on screen. The textarea itself stays
                MOUNTED either way — it carries the text both faces write, and a
                closed disclosure is not a removed escape hatch. */}
            <div hidden={!rawShown} className={rawShown ? 'flex-1 min-h-0 flex flex-col' : undefined}>
                <textarea
                    aria-label={t('routines.ndv.output_json', 'Output JSON')}
                    value={text}
                    onChange={(e) => onChange(e.target.value)}
                    spellCheck={false}
                    className="flex-1 min-h-[6rem] w-full resize-none bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-primary)] outline-none"
                />
            </div>
            {error && (
                <div role="alert" className="px-3 py-1.5 text-[11px] text-[var(--error)] bg-[color-mix(in_srgb,var(--error)_5%,transparent)] border-t border-[var(--border-default)]">
                    {error}
                </div>
            )}
            <OutputSheetFooter
                t={t}
                saving={saving}
                canRemove={canRemove}
                onEmptyAnswers={onEmptyAnswers}
                onRemove={onRemove}
                onCancel={onCancel}
                onApply={onApply}
            />
        </div>
    );
}

/**
 * The one action bar of the sheet, whichever face is on screen above it.
 * Save is the ONLY thing that writes: both faces edit the same text, and the
 * parse, the truncation refusal and the 64 KB weigh-in all hang off this
 * button — which is why there is exactly one of it.
 */
type OutputSheetFooterProps = Pick<OutputEditorPanelProps, 'saving' | 'canRemove' | 'onEmptyAnswers' | 'onRemove' | 'onCancel' | 'onApply'> & { t: TranslateFn };

function OutputSheetFooter({ t, saving, canRemove, onEmptyAnswers, onRemove, onCancel, onApply }: OutputSheetFooterProps) {
    return (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-[var(--border-default)]">
            {onEmptyAnswers && (
                <button
                    type="button"
                    onClick={onEmptyAnswers}
                    title={t('routines.ndv.empty_answers_title', 'Fill in every declared question with an empty answer — the key set a submission has before anyone types anything')}
                    className="text-[11px] px-2 py-0.5 rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                >
                    {t('routines.ndv.use_empty_answers', 'Use empty answers')}
                </button>
            )}
            {canRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    className="text-[11px] px-2 py-0.5 rounded text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] transition"
                >
                    {t('common.remove', 'Remove')}
                </button>
            )}
            <button
                type="button"
                onClick={onCancel}
                className="ml-auto text-[11px] px-2 py-0.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition"
            >
                {t('common.cancel', 'Cancel')}
            </button>
            <button
                type="button"
                onClick={onApply}
                disabled={saving}
                className="text-[11px] px-2.5 py-0.5 rounded bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-85 disabled:opacity-40 transition"
            >
                {saving ? t('common.saving', 'Saving…') : t('routines.ndv.save_output', 'Save output')}
            </button>
        </div>
    );
}

export default OutputEditorPanel;
