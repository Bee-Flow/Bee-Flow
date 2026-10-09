// The stop_error editor: the message a deliberate halt records as the run's
// reason.
import TemplateField from '../../../mapping/TemplateField';
import AccordionSection from '../../AccordionSection';
import { FormRow } from '../formPrimitives';
import { useTranslation } from '../../../../../../hooks/useTranslation';

function StopErrorFields({ draft, set, onFocusField, previewSample, errorSections = new Set() }) {
    const { t } = useTranslation();
    return (
        <AccordionSection stepType="stop_error" sectionKey="config" title={t('automations.stop_error_fields.configuration', 'Configuration')} defaultOpen forceOpen={errorSections.has('config')}>
            <FormRow label="Error message" hint="Surfaced as the run error. Template-interpolated.">
                <TemplateField
                    value={draft.message || ''}
                    onChange={(next) => set('message', next)}
                    rows={3}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder={t('automations.stop_error_fields.budget_exceeded_by', 'Budget exceeded by {{steps.calc.output.delta}}')}
                />
            </FormRow>
        </AccordionSection>
    );
}

export { StopErrorFields };
