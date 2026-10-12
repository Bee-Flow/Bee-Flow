import React, { useMemo } from 'react';
import studioFieldOptions from './studioFieldOptions';
import StudioScopeProvider, { buildStudioScope } from './StudioScopeProvider';
import ConditionBuilder from '../../../../../automation/Builder/mapping/ConditionBuilder';
import useTranslation from '../../../../../../hooks/useTranslation';

/**
 * ConditionField — the automations clickable ConditionBuilder, mounted inside a
 * Studio variable-source so its BindingFields resolve App Studio scope
 * (currentUser · item · form.* · actions.* · datasets.*). The serialise/parse
 * model (conditionModel.js) is reused VERBATIM — this only supplies the
 * Studio-shaped previewSample used for datatype inference and the picker.
 *
 * `value` is the raw expression string; onChange emits the string. Anything the
 * clickable model can't represent keeps the user in the builder's own raw mode.
 */
/**
 * The shared builder ships automations-shaped examples (`steps.step1.output.total`)
 * — a scope root App Studio does not have and validate.js rejects, so an author
 * following the placeholder wrote an expression that could never resolve.
 */
const studioPlaceholders = (t) => ({
    field: t('studio_apps_insp.condition.field_placeholder', 'field (e.g. form.quantity)'),
    raw: 'form.quantity > 0',
});

export default function ConditionField({
    value = '', onChange, definition = null, node = null, previewSample = null, disabled = false,
}) {
    const { t } = useTranslation();
    const { groups, previewSample: sample } = useMemo(
        () => buildStudioScope(definition, node, previewSample, null, t),
        [definition, node, previewSample, t],
    );
    // The left-hand side of a row becomes a searchable list of NAMES rather
    // than a box you must know to fill with `form.quantity`. `fieldBase` is
    // where a free-typed name lands when there is nothing to match it against.
    const fieldOptions = useMemo(() => studioFieldOptions(groups), [groups]);

    return (
        <StudioScopeProvider definition={definition} node={node} previewSample={previewSample}>
            {/*
              * A <fieldset disabled> switches off every control below it,
              * natively and without threading a prop through a shared component
              * from another product area. It matters: while the AI builder
              * streams a rewrite the inspector is locked, and this was the one
              * path that stayed fully editable — an edit here fired onCommit
              * into a definition the stream was replacing.
              */}
            <fieldset disabled={disabled} className="min-w-0 border-0 p-0 m-0">
                <ConditionBuilder
                    value={value}
                    onChange={onChange}
                    previewSample={sample}
                    fieldOptions={fieldOptions}
                    fieldBase="form"
                    context="condition"
                    placeholders={studioPlaceholders(t)}
                />
            </fieldset>
        </StudioScopeProvider>
    );
}
