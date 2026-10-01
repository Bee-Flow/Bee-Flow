// The stop_error editor: the message a deliberate halt records as the run's
// reason.
import ComposeField from '../../../valueSlot/ComposeField';
import AccordionSection from '../../AccordionSection';
import { FormRow } from '../formPrimitives';

function StopErrorFields({ draft, set, onFocusField, previewSample, errorSections = new Set() }) {
    return (
        <AccordionSection stepType="stop_error" sectionKey="config" title="Configuration" defaultOpen forceOpen={errorSections.has('config')}>
            <FormRow label="Error message" hint="Surfaced as the run error. Template-interpolated.">
                <ComposeField stepType="stop_error" field="message"
                    value={draft.message || ''}
                    onChange={(next) => set('message', next)}
                    rows={3}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder="Budget exceeded by {{steps.calc.output.delta}}"
                />
            </FormRow>
        </AccordionSection>
    );
}

export { StopErrorFields };
