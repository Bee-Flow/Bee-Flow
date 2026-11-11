import { TextCursorInput } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `set_form_field` step (server/appStudio/componentSpecs/steps/set_form_field.js).
 * Its fields are drawn from the spec by StepSettings.
 */
const entry: StepKindModule = {
    kind: 'set_form_field',
    meta: {
        label: 'Fill in a field',
        labelKey: 'studio_apps_ui_steps.catalog.set_form_field_label',
        group: 'On screen',
        icon: TextCursorInput,
        blurb: 'Put a value into one field of a form, as if it was typed.',
        blurbKey: 'studio_apps_ui_steps.catalog.set_form_field_blurb',
    },
    newStep: () => ({ kind: 'set_form_field', form: '', field: '', value: { kind: 'static', value: '' } }),
};

export default entry;
