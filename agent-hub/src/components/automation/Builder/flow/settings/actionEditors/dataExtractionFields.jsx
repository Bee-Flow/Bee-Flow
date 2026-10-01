// The data_extraction editor: which text to read, the field rows that ARE the
// step's output shape, and any extra guidance for the extraction model.
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import BindingField from '../../../mapping/BindingField';
import AccordionSection from '../../AccordionSection';
import { RetrySection, retryIsSet } from '../collectionEditors';
import StepRepeatSection from '../advanced/StepRepeatSection';
import { perItemIsSet } from '../advanced/stepRepeat';
import { AMBER_NOTE, cardClass, hintTextClass, rowInputClass, textareaClass } from '../formPrimitives';
import {
    EXTRACTION_FIELD_TYPES, MAX_EXTRACTION_FIELDS, MAX_EXTRACTION_INSTRUCTIONS,
    coerceExtractionName, emptyExtractionField,
} from '../formState';

/**
 * The Extract data editor: WHICH text, WHICH fields, and any extra guidance.
 *
 * No model, no tier, no tools, no output schema. The step runs on the one
 * extraction model the admin set (`data_extraction_model`, Admin → AI config),
 * and the field rows below ARE the output shape — mapping/upstream.js reads
 * them, so a downstream step can drag `datum` or `totaal` off the variable tree
 * the moment a row is named. Field names are coerced to lowercase snake as
 * they are typed (formState.coerceExtractionName): they become output keys,
 * and a name the server would refuse is never on screen to begin with.
 */
function DataExtractionFields({ draft, set, groups = [], onFocusField, previewSample, errorSections = new Set() }) {
    const { t } = useTranslation();
    const fields = Array.isArray(draft.fields) ? draft.fields : [];

    const updateField = (i, patch) => {
        const next = fields.slice();
        next[i] = { ...next[i], ...patch };
        set('fields', next);
    };
    const removeField = (i) => set('fields', fields.filter((_, idx) => idx !== i));
    const addField = () => { if (fields.length < MAX_EXTRACTION_FIELDS) set('fields', [...fields, emptyExtractionField()]); };
    // Order is the order the prompt lists the fields and the output panel
    // shows them, so it is the author's to arrange.
    const moveField = (i, dir) => {
        const j = i + dir;
        if (j < 0 || j >= fields.length) return;
        const next = fields.slice();
        [next[i], next[j]] = [next[j], next[i]];
        set('fields', next);
    };
    // A later row repeating an earlier name is not saved (formState drops it —
    // `fields_duplicate` is an integrity error); say so on the row itself.
    const firstIndexOfName = (name) => fields.findIndex(f => (f?.name || '') === name);

    const modelNote = t('routines.ndv.extraction.model_note', 'Runs on the extraction model set by your administrator');
    const fieldNameLabel = t('routines.ndv.extraction.field_name', 'Name');
    const fieldTypeLabel = t('routines.ndv.extraction.field_type', 'Type');
    const fieldDescLabel = t('routines.ndv.extraction.field_desc', 'What to look for');
    const requiredLabel = t('routines.ndv.extraction.required', 'Required');

    return (
        <>
            <AccordionSection stepType="data_extraction" sectionKey="source" title={t('routines.ndv.extraction.source', 'Text to read')} defaultOpen forceOpen={errorSections.has('source')}>
                {/* A sentence, not a labelled FormRow: the band already says
                    "Text to read", and the same words twice was the FieldsSection
                    lesson. */}
                <p className={`${hintTextClass()} mb-2`}>
                    The text the fields are read from — usually the output of the step that fetched the document or e-mail. Drag it in from the panel on the right.
                </p>
                <BindingField
                    value={draft.source}
                    onChange={(next) => set('source', next)}
                    required
                    placeholder="Pick a value from an earlier step"
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    expectShape="scalar"
                    expectKind="text"
                />
                {/* The one thing about the model an author needs to know, and
                    the one thing they cannot change here. The config key sits
                    in the tooltip for whoever goes to set it. */}
                <p
                    className={`${hintTextClass()} mt-2`}
                    title="Admin → AI config → Data extraction model (config key: data_extraction_model)"
                    data-testid="extraction-model-note"
                >
                    {modelNote}
                </p>
            </AccordionSection>

            <AccordionSection stepType="data_extraction" sectionKey="fields" title={t('routines.ndv.extraction.fields', 'Fields to extract')} defaultOpen forceOpen={errorSections.has('fields')}>
                <p className={`${hintTextClass()} mb-2`}>
                    One row per value to pull out. The name becomes the output key the next steps bind to; the description tells the model what to look for. A field it cannot find comes back empty.
                </p>
                <div className="space-y-2">
                    {fields.map((f, i) => {
                        const name = f?.name || '';
                        const duplicate = !!name && firstIndexOfName(name) !== i;
                        return (
                            <div key={i} className={cardClass()} data-testid="extraction-field-row">
                                <div className="flex items-center gap-1.5">
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={(e) => updateField(i, { name: coerceExtractionName(e.target.value) })}
                                        placeholder="invoice_date"
                                        aria-label={fieldNameLabel}
                                        className={rowInputClass('flex-1 min-w-0 font-mono', { invalid: duplicate })}
                                    />
                                    <select
                                        value={EXTRACTION_FIELD_TYPES.includes(f?.type) ? f.type : 'string'}
                                        onChange={(e) => updateField(i, { type: e.target.value })}
                                        aria-label={fieldTypeLabel}
                                        className={rowInputClass('px-1.5')}
                                    >
                                        {EXTRACTION_FIELD_TYPES.map(ty => <option key={ty} value={ty}>{ty}</option>)}
                                    </select>
                                    <label className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] whitespace-nowrap select-none">
                                        <input
                                            type="checkbox"
                                            checked={f?.required === true}
                                            onChange={(e) => updateField(i, { required: e.target.checked })}
                                            aria-label={`${requiredLabel} — ${name || fieldNameLabel}`}
                                        />
                                        {requiredLabel}
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() => moveField(i, -1)}
                                        disabled={i === 0}
                                        title="Move up"
                                        aria-label="Move up"
                                        className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30"
                                    >
                                        <ChevronUp size={12} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => moveField(i, 1)}
                                        disabled={i === fields.length - 1}
                                        title="Move down"
                                        aria-label="Move down"
                                        className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30"
                                    >
                                        <ChevronDown size={12} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => removeField(i)}
                                        title="Remove field"
                                        aria-label="Remove field"
                                        className="p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-500/10"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                                <input
                                    type="text"
                                    value={f?.description || ''}
                                    onChange={(e) => updateField(i, { description: e.target.value })}
                                    placeholder="The invoice date, usually top right — written day first"
                                    aria-label={fieldDescLabel}
                                    className={rowInputClass('w-full')}
                                />
                                {duplicate && (
                                    <div className={AMBER_NOTE}>
                                        Another field is already called {name} — this one is not saved until it has its own name.
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                <button
                    type="button"
                    onClick={addField}
                    disabled={fields.length >= MAX_EXTRACTION_FIELDS}
                    title={fields.length >= MAX_EXTRACTION_FIELDS ? `At most ${MAX_EXTRACTION_FIELDS} fields per step` : undefined}
                    className="mt-2 flex items-center gap-1 text-xs text-[var(--accent)] hover:opacity-80 transition disabled:opacity-40"
                >
                    <Plus size={12} /> {t('routines.ndv.extraction.add_field', 'Add field')}
                </button>
            </AccordionSection>

            <AccordionSection
                stepType="data_extraction" sectionKey="instructions" title={t('routines.ndv.extraction.instructions', 'Extra instructions')}
                defaultOpen={!!draft.instructions} forceOpen={errorSections.has('instructions')} hasContent={!!draft.instructions}
            >
                <p className={`${hintTextClass()} mb-2`}>
                    Optional. Anything the model should know that the field descriptions do not say — the currency, the language, which of two dates counts.
                </p>
                <textarea
                    rows={3}
                    maxLength={MAX_EXTRACTION_INSTRUCTIONS}
                    value={draft.instructions || ''}
                    onChange={(e) => set('instructions', e.target.value)}
                    placeholder="Amounts are in euros. Dates are written day first."
                    aria-label={t('routines.ndv.extraction.instructions', 'Extra instructions')}
                    className={textareaClass()}
                />
            </AccordionSection>

            <AccordionSection stepType="data_extraction" sectionKey="advanced" title="Advanced" defaultOpen={perItemIsSet(draft) || retryIsSet(draft)} forceOpen={errorSections.has('advanced')} hasContent={perItemIsSet(draft) || retryIsSet(draft)}>
                <StepRepeatSection stepType="data_extraction" draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
                <RetrySection draft={draft} set={set} />
            </AccordionSection>
        </>
    );
}

export { DataExtractionFields };
