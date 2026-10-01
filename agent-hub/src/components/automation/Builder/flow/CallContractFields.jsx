// Shared body for the "call" step editors (call_layer / call_block).
//
// CallLayerFields (a flowlet call) and CallStepFields (a published-Step call)
// rendered a near-identical three-section body: a header naming the target,
// an Inputs editor (one BindingField per declared param, with an Auto-map
// shortcut), and a read-only Returns list. Only the contract source and a
// few labels differed. This component renders that body; the two thin
// wrappers in SettingsForm resolve the contract, title, and labels and feed
// it the setInput/onAutoMap handlers from useInputMapping.

import { Sparkles } from 'lucide-react';
import React from 'react';
import AccordionSection from './AccordionSection';
import { FormRow } from './settings/formPrimitives';
import ValueSlot from '../valueSlot/ValueSlot';
import { humanizeFieldKey } from './displayHelpers';
import { expectedKindFor } from '../mapping/fieldKinds';

export default function CallContractFields({
    step,
    stepType,
    headerSectionKey,
    headerTitle,
    displayTitle,
    warning = null,
    contract,
    inputs,
    setInput,
    onAutoMap,
    groups,
    onFocusField,
    previewSample,
    inputsHint,
    emptyInputsLabel,
    outputFields = [],
    errorSections = new Set(),
}) {
    const autoMapped = Array.isArray(step.autoMapped) ? step.autoMapped : [];
    return (
        <>
            <AccordionSection stepType={stepType} sectionKey={headerSectionKey} title={headerTitle} defaultOpen forceOpen={errorSections.has(headerSectionKey)}>
                <FormRow label={headerTitle}>
                    <div className="text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded px-2 py-1.5 truncate">
                        {displayTitle}
                    </div>
                    {warning && (
                        <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                            {warning}
                        </div>
                    )}
                </FormRow>
            </AccordionSection>
            <AccordionSection stepType={stepType} sectionKey="inputs" title="Inputs" defaultOpen={contract.length > 0} forceOpen={errorSections.has('inputs')}>
                <FormRow label="Inputs" hint={inputsHint}>
                    {contract.length === 0 ? (
                        <div className="text-[11px] text-[var(--text-tertiary)] italic">{emptyInputsLabel}</div>
                    ) : (
                        <div className="space-y-3">
                            {groups && groups.length > 0 && (
                                <div className="flex justify-end">
                                    <button
                                        type="button"
                                        onClick={onAutoMap}
                                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
                                    >
                                        <Sparkles size={12} /> Auto-map
                                    </button>
                                </div>
                            )}
                            {contract.map(p => (
                                // The contract's `name` is a machine key — `iban`,
                                // `klant_naam` — and it was what the row said out
                                // loud, so a flowlet's inputs read like a JSON
                                // schema instead of like a form. Two steps down,
                                // in order: a `label` if the contract carries one,
                                // otherwise the key read as words. Today nothing
                                // authors that label — the flowlet input editor
                                // (settings/triggerEditors LayerInputFields) writes
                                // name/type/required, and server stepContract.js
                                // projects a published Step's params down to
                                // {name,type,required,description} — so in practice
                                // this is always the humanised key. It stays first
                                // because the day a param gets a real name, that
                                // name must win over a guess made from its key.
                                // The key itself is never gone: it sits on the
                                // row's `title`, because it is the name the binding
                                // is stored under and the one a power user needs
                                // when reading the JSON of this step (same demotion
                                // ConditionNode/FilterNode do with `subTitle` on
                                // the canvas).
                                <div key={p.name} title={p.name}>
                                    <ValueSlot
                                        label={p.label || humanizeFieldKey(p.name) || p.name}
                                        fieldId={p.name}
                                        field={p.name}
                                        showChrome
                                        required={!!p.required}
                                        hint={p.description}
                                        value={inputs[p.name] ?? null}
                                        onChange={(b) => setInput(p.name, b)}
                                        onFocusField={onFocusField}
                                        previewSample={previewSample}
                                        autoMapped={autoMapped.includes(p.name)}
                                        // The flowlet DECLARED these params, so the
                                        // same answer a tool parameter gets ("what
                                        // does this want") is read off the
                                        // contract rather than guessed.
                                        schema={{ type: p.type }}
                                        expectKind={expectedKindFor({ type: p.type })}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </FormRow>
            </AccordionSection>
            {outputFields.length > 0 && (
                <AccordionSection stepType={stepType} sectionKey="returns" title="Returns">
                    <FormRow label="Returns" hint="These fields are available to downstream steps by name.">
                        <div className="text-[11px] text-[var(--text-secondary)] font-mono">{outputFields.join(', ')}</div>
                    </FormRow>
                </AccordionSection>
            )}
        </>
    );
}
