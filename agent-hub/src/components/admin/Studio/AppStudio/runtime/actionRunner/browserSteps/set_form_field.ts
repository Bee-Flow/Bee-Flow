import { resolveBinding } from '../../resolveBinding';
import { setAppFormField } from '../../formContext';
import type { BrowserStepModule } from '../browserSteps';

/**
 * set_form_field (server/appStudio/componentSpecs/steps/set_form_field.js): the
 * value goes through the mounted form's own setValue, as if typed. No form of
 * that name on the page: nothing happens.
 */
const entry: BrowserStepModule = {
    kind: 'set_form_field',
    run: ({ liveBag }, step, st) => {
        if (typeof step.form !== 'string' || !step.form || typeof step.field !== 'string' || !step.field) return;
        const { value } = resolveBinding(step.value, liveBag(st));
        setAppFormField(step.form, step.field, value);
    },
};

export default entry;
