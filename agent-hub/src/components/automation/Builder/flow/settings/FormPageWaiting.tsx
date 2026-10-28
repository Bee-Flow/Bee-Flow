import { useTranslation } from '@/hooks/useTranslation';
import AccordionSection from '../AccordionSection';
import { FormRow, inputClass } from './formPrimitives';

const FORM_WAIT_CHOICES = [
    { value: 900, label: '15 minutes' },
    { value: 3600, label: '1 hour' },
    { value: 86400, label: '24 hours' },
    { value: 7 * 24 * 3600, label: '7 days' },
];

interface Props {
    waitSeconds?: number;
    onChange: (seconds: number) => void;
    forceOpen?: boolean;
}

/**
 * How long the run waits for the visitor on an input page before giving up.
 * Its own section key, not 'options': how long the automation waits for a
 * real person is a first-class decision, so it must not disappear behind the
 * advanced-density filter.
 */
export default function FormPageWaiting({ waitSeconds, onChange, forceOpen = false }: Props) {
    const { t } = useTranslation();
    return (
        <AccordionSection stepType="form_page" sectionKey="waiting" title={t('automations.trigger_editors.waiting', 'Waiting')} defaultOpen forceOpen={forceOpen}>
            <FormRow label={t('automations.trigger_editors.wait_for_an_answer', 'Wait for an answer')} hint={t('automations.trigger_editors.after_this_the_automation_gives_up', 'After this the automation gives up and the run fails.')}>
                <select
                    aria-label={t('automations.trigger_editors.wait_for_an_answer', 'Wait for an answer')}
                    value={waitSeconds ?? 3600}
                    onChange={(e) => onChange(Number(e.target.value))}
                    className={inputClass()}
                >
                    {FORM_WAIT_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
            </FormRow>
        </AccordionSection>
    );
}
