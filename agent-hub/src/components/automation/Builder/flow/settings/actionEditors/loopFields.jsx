// The loop editor: what to iterate over, how many items at a time, and the
// steps that run once per item.
import { Workflow } from 'lucide-react';
import LoopBodyEditor from '../../../mapping/LoopBodyEditor';
import LoopOverPicker from '../../../mapping/LoopOverPicker';
import AccordionSection from '../../AccordionSection';
import { planLoopItemRename } from '../advanced/stepRepeat';
import { FormRow, inputClass } from '../formPrimitives';

function LoopFields({
    draft, set, groups, onFocusField, previewSample, catalog, modelTiers,
    rootDefinition, blocksCatalog, errorSections = new Set(), onExpandOnCanvas = null,
}) {
    return (
        <>
            <AccordionSection stepType="loop" sectionKey="loop" title="Loop" defaultOpen forceOpen={errorSections.has('loop')}>
                <LoopOverPicker
                    overRef={draft.overRef || ''}
                    itemVar={draft.itemVar || 'item'}
                    onChange={(patch) => {
                        if ('overRef' in patch) set('overRef', patch.overRef);
                        if (!('itemVar' in patch) || patch.itemVar === (draft.itemVar || 'item')) return;
                        // A new name (typed, or suggested by a newly picked
                        // list) carries the body's `loop.<old>` reads along;
                        // a name the run could not bind is not taken.
                        const res = planLoopItemRename(draft, patch.itemVar);
                        if (!res.error) for (const [k, v] of Object.entries(res.patch)) set(k, v);
                    }}
                    groups={groups}
                    onFocusField={onFocusField}
                />
                <FormRow label="Batch size" hint="Items per iteration. 1 = one at a time; higher values bind an ARRAY of that many items to loop.<name> instead of a single item.">
                    <input type="number" min={1} max={1000} value={draft.batchSize ?? 1} onChange={(e) => set('batchSize', Number(e.target.value))} className={inputClass()} />
                </FormRow>
                <FormRow label="Max iterations" hint="Safety cap. 1–1000.">
                    <input type="number" min={1} max={1000} value={draft.maxIterations ?? 100} onChange={(e) => set('maxIterations', Number(e.target.value))} className={inputClass()} />
                </FormRow>
            </AccordionSection>
            <AccordionSection stepType="loop" sectionKey="body" title="Steps inside the loop" defaultOpen forceOpen={errorSections.has('body')}>
                {/* Nothing here used to say the body is SEQUENTIAL, and the
                    list's up/down arrows are the only hint that order matters
                    at all. It does: the runtime chains these steps and runs
                    them top to bottom for each item (engine.js). */}
                <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-[11px] text-[var(--text-tertiary)]">
                        These run once per item, top to bottom.
                    </p>
                    {onExpandOnCanvas && (
                        <button
                            type="button"
                            onClick={onExpandOnCanvas}
                            title="Open these steps on the canvas, inside the loop"
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
