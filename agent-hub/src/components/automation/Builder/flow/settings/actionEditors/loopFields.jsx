// The loop editor: what to iterate over, how many items at a time, and the
// steps that run once per item.
import { Workflow } from 'lucide-react';
import LoopBodyEditor from '../../../mapping/LoopBodyEditor';
import LoopOverPicker from '../../../mapping/LoopOverPicker';
import AccordionSection from '../../AccordionSection';
import { FormRow, inputClass } from '../formPrimitives';
import { useTranslation } from '../../../../../../hooks/useTranslation';

function LoopFields({
    draft, set, groups, onFocusField, previewSample, catalog, modelTiers,
    rootDefinition, blocksCatalog, errorSections = new Set(), onExpandOnCanvas = null,
}) {
    const { t } = useTranslation();
    return (
        <>
            <AccordionSection stepType="loop" sectionKey="loop" title={t('automations.loop_fields.loop', 'Loop')} defaultOpen forceOpen={errorSections.has('loop')}>
                <LoopOverPicker
                    overRef={draft.overRef || ''}
                    itemVar={draft.itemVar || 'item'}
                    onChange={(patch) => {
                        if ('overRef' in patch) set('overRef', patch.overRef);
                        if ('itemVar' in patch) set('itemVar', patch.itemVar);
                    }}
                    groups={groups}
                    onFocusField={onFocusField}
                    // Another list: the steps inside follow the item by field
                    // name, or are named when the new item lacks the field.
                    bindings={draft.body || []}
                    onRebind={(next) => set('body', next)}
                    container
                />
                <FormRow label="Batch size" hint="Items per iteration. 1 = one at a time; higher values bind an ARRAY of that many items to loop.<name> instead of a single item.">
                    <input type="number" min={1} max={1000} value={draft.batchSize ?? 1} onChange={(e) => set('batchSize', Number(e.target.value))} className={inputClass()} />
                </FormRow>
                <FormRow label="Max iterations" hint="Safety cap. 1–1000.">
                    <input type="number" min={1} max={1000} value={draft.maxIterations ?? 100} onChange={(e) => set('maxIterations', Number(e.target.value))} className={inputClass()} />
                </FormRow>
            </AccordionSection>
            <AccordionSection stepType="loop" sectionKey="body" title={t('automations.loop_fields.steps_inside_the_loop', 'Steps inside the loop')} defaultOpen forceOpen={errorSections.has('body')}>
                {/* Nothing here used to say the body is SEQUENTIAL, and the
                    list's up/down arrows are the only hint that order matters
                    at all. It does: the runtime chains these steps and runs
                    them top to bottom for each item (engine.js). */}
                <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-[11px] text-[var(--text-tertiary)]">
                        {t('automations.loop_fields.these_run_once_per_item_top', 'These run once per item, top to bottom.')}
                    </p>
                    {onExpandOnCanvas && (
                        <button
                            type="button"
                            onClick={onExpandOnCanvas}
                            title={t('automations.loop_fields.open_these_steps_on_the_canvas', 'Open these steps on the canvas, inside the loop')}
                            className="shrink-0 inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
                        >
                            <Workflow size={11} /> Edit on canvas
                        </button>
                    )}
                </div>
                <LoopBodyEditor
                    loopStep={draft}
                    onChange={(nextBody) => set('body', nextBody)}
                    outerGroups={groups}
                    previewSample={previewSample}
                    catalog={catalog}
                    modelTiers={modelTiers}
                    rootDefinition={rootDefinition}
                    blocksCatalog={blocksCatalog}
                    onFocusField={onFocusField}
                />
            </AccordionSection>
        </>
    );
}

export { LoopFields };
