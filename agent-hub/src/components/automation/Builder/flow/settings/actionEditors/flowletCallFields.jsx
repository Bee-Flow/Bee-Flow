// Calling a reusable group of steps and returning from one: the call_layer and
// call_block editors (one BindingField per declared param) and the layer_output
// editor that names what a flowlet hands back.
import CallContractFields from '../../CallContractFields';
import { getLayerContract } from '../../flowletScope';
import useInputMapping from '../../useInputMapping';
import { FieldsSection } from '../collectionEditors';
import { useTranslation } from '../../../../../../hooks/useTranslation';

/**
 * Editor for a call_layer step. The flowlet's contract derives LIVE from
 * `rootDefinition.layers[step.layerKey]` (params from the layer_input
 * trigger, returns from the layer_output fields) — editing the flowlet
 * immediately updates this form. The user edits the input mapping (one
 * BindingField per declared param).
 */
function CallLayerFields({ step, draft, set, groups, onFocusField, previewSample, rootDefinition = null, errorSections = new Set() }) {
    const { params: contract, outputFields } = getLayerContract(rootDefinition, step.layerKey);
    const layerTitle = rootDefinition?.layers?.[step.layerKey]?.title || null;
    const inputs = draft.inputs || {};
    const { setInput, onAutoMap } = useInputMapping({ inputs, contract, groups, onChange: (next) => set('inputs', next) });

    return (
        <CallContractFields
            step={step}
            stepType="call_layer"
            headerSectionKey="flowlet"
            headerTitle="Flowlet"
            displayTitle={layerTitle || step.layerKey || '—'}
            warning={!layerTitle && step.layerKey ? `Flowlet “${step.layerKey}” was not found in this automation.` : null}
            contract={contract}
            inputs={inputs}
            setInput={setInput}
            onAutoMap={onAutoMap}
            groups={groups}
            onFocusField={onFocusField}
            previewSample={previewSample}
            inputsHint="Map each flowlet parameter to an upstream value."
            emptyInputsLabel="This flowlet has no declared inputs."
            outputFields={outputFields}
            errorSections={errorSections}
        />
    );
}

/**
 * Editor for a call_block step. The Step's contract comes from the published
 * Steps catalog (the Step is a separate row), not the local layers map.
 * The user maps each declared param to an upstream value.
 */
function CallStepFields({ step, draft, set, groups, onFocusField, previewSample, blocksCatalog = [], errorSections = new Set() }) {
    const block = (blocksCatalog || []).find(b => b.id === step.blockId) || null;
    const contract = block?.params || [];
    const outputFields = block?.outputFields || [];
    const blockTitle = block?.title || null;
    const inputs = draft.inputs || {};
    const { setInput, onAutoMap } = useInputMapping({ inputs, contract, groups, onChange: (next) => set('inputs', next) });

    return (
        <CallContractFields
            step={step}
            stepType="call_block"
            headerSectionKey="step"
            headerTitle="Step"
            displayTitle={blockTitle || step.label || step.blockId || '—'}
            warning={!block && step.blockId ? 'This Step is unpublished, deleted, or not shared with you.' : null}
            contract={contract}
            inputs={inputs}
            setInput={setInput}
            onAutoMap={onAutoMap}
            groups={groups}
            onFocusField={onFocusField}
            previewSample={previewSample}
            inputsHint="Map each Step input to an upstream value."
            emptyInputsLabel="This Step has no declared inputs."
            outputFields={outputFields}
            errorSections={errorSections}
        />
    );
}

/** Editor for a layer_output step — the object the flowlet returns. */
function LayerOutputFields({ draft, set, onFocusField, previewSample, errorSections = new Set() }) {
    const { t } = useTranslation();
    return (
        <FieldsSection
            draft={draft}
            set={set}
            stepType="layer_output"
            title={t('automations.flowlet_call_fields.return_fields', 'Return fields')}
            hint="The object this flowlet returns to its caller. Bind each field to a value produced inside the flowlet."
            onFocusField={onFocusField}
            previewSample={previewSample}
            errorSections={errorSections}
        />
    );
}

export { CallLayerFields, CallStepFields, LayerOutputFields };
