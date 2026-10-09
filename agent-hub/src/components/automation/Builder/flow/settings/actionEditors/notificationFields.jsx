// The notification editor: the message a run sends while it is going, and the
// channels it goes out on.
import ChannelPills from '../../../ChannelPills';
import TemplateField from '../../../mapping/TemplateField';
import useForEachRequest from '../../../mapping/useForEachRequest';
import { normalizeChannels, stepChannelsToUi } from '../../../notificationDefaults';
import AccordionSection from '../../AccordionSection';
import { ForEachSection, RetrySection, retryIsSet } from '../collectionEditors';
import { FormRow } from '../formPrimitives';
import { useTranslation } from '../../../../../../hooks/useTranslation';

function NotificationFields({ draft, set, groups = [], onFocusField, previewSample, errorSections = new Set() }) {
    const { t } = useTranslation();
    // A separate run per item (under a field's More) sets this step's forEach.
    const forEach = useForEachRequest(draft, set);
    return (
        <>
        <AccordionSection stepType="notification" sectionKey="message" title={t('automations.notification_fields.message', 'Message')} defaultOpen forceOpen={errorSections.has('message')}>
            <FormRow label="Title">
                <TemplateField
                    onRequestForEach={forEach.request}
                    canForEach={forEach.allowed}
                    value={draft.title || ''}
                    onChange={(next) => set('title', next)}
                    rows={1}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder={t('automations.notification_fields.new_invoice_received', 'New invoice received')}
                />
            </FormRow>
            <FormRow label="Body" required hint="Click a value in the right panel to insert it.">
                <TemplateField
                    onRequestForEach={forEach.request}
                    canForEach={forEach.allowed}
                    value={draft.body || ''}
                    onChange={(next) => set('body', next)}
                    rows={4}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder={t('automations.notification_fields.what_should_the_notification_say', 'What should the notification say?')}
                />
            </FormRow>
            {/* Where it goes. The runner has honoured `channels` all along but
                nothing ever showed it, so the step could say what to send and
                never where — and email was reachable only via the JSON tab
                (BFSF-350). */}
            <FormRow label="Send to">
                <ChannelPills
                    caption={null}
                    channels={stepChannelsToUi(draft.channels)}
                    onToggle={(key) => {
                        const cur = stepChannelsToUi(draft.channels);
                        const next = cur.includes(key) ? cur.filter(c => c !== key) : [...cur, key];
                        set('channels', normalizeChannels(next));
                    }}
                />
                {/* Stated in the open, not behind a hint icon: "where does this
                    even go?" was the whole of the report. */}
                <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                    {t('automations.notification_fields.in_app_lands_in_the_bee', 'In-app lands in the Bee Flow notification centre — the bell in the top bar. Email goes to the person this automation belongs to.')}
                </div>
            </FormRow>
            </AccordionSection>
            <AccordionSection stepType="notification" sectionKey="advanced" title={t('automations.notification_fields.advanced', 'Advanced')} defaultOpen={!!draft.forEach || retryIsSet(draft)} forceOpen={errorSections.has('advanced')} hasContent={!!draft.forEach || retryIsSet(draft)}>
                <ForEachSection draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
                <RetrySection draft={draft} set={set} />
            </AccordionSection>
        </>
    );
}

export { NotificationFields };
