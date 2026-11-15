// The mail trigger filter forms (Gmail and Nextcloud Mail), split out of
// triggerFilters.tsx, which maps them in FILTER_FORM_BY_KEY.
import { useTranslation } from '@/hooks/useTranslation';
import { inputClass, sectionHeaderClass, FormRow } from './formPrimitives';
import type { FilterFieldsProps } from './triggerFilters.types';

export function GmailFilterFields({ filter, setFilter }: FilterFieldsProps) {
    const { t } = useTranslation();
    return (
        <div className="rounded-md border border-[var(--border-subtle)] p-3 space-y-3">
            <div className={sectionHeaderClass()}>{t('automations.trigger_filters.gmail_filter_all_optional_and_across', 'Gmail filter (all optional, AND across keys)')}</div>
            <FormRow label={t('automations.trigger_filters.from_contains', 'From contains')}>
                <input type="text" value={filter.from || ''} onChange={(e) => setFilter('from', e.target.value || undefined)}
                    placeholder="boss@example.com" className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.to_contains', 'To contains')}>
                <input type="text" value={filter.to || ''} onChange={(e) => setFilter('to', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.subject_contains', 'Subject contains')}>
                <input type="text" value={filter.subjectContains || ''} onChange={(e) => setFilter('subjectContains', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.subject_regex', 'Subject regex')} hint={t('automations.trigger_filters.js_regex_capped_at_200_chars', 'JS regex. Capped at 200 chars; invalid patterns fail closed.')}>
                <input type="text" value={filter.subjectRegex || ''} onChange={(e) => setFilter('subjectRegex', e.target.value || undefined)} className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.has_attachment', 'Has attachment')}>
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.hasAttachment === true} onChange={(e) => setFilter('hasAttachment', e.target.checked || undefined)} />
                    {t('automations.trigger_filters.only_emails_with_attachments', 'Only emails with attachments')}
                </label>
            </FormRow>
            <FormRow label={t('automations.trigger_filters.exclude_self_sent', 'Exclude self-sent')}>
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.excludeFromSelf === true} onChange={(e) => setFilter('excludeFromSelf', e.target.checked || undefined)} />
                    {t('automations.trigger_filters.skip_emails_i_sent', 'Skip emails I sent')}
                </label>
            </FormRow>
            <FormRow label={t('automations.trigger_filters.max_age_minutes', 'Max age (minutes)')} hint={t('automations.trigger_filters.drop_messages_older_than_this_useful', 'Drop messages older than this. Useful so a long-paused poller doesn\'t flood with backlog on resume.')}>
                <input
                    type="number"
                    value={filter.maxAgeMinutes ?? ''}
                    min={1}
                    onChange={(e) => setFilter('maxAgeMinutes', e.target.value === '' ? undefined : Number(e.target.value))}
                    className={inputClass()}
                />
            </FormRow>
        </div>
    );
}

export function NextcloudMailFilterFields({ filter, setFilter }: FilterFieldsProps) {
    const { t } = useTranslation();
    return (
        <div className="rounded-md border border-[var(--border-subtle)] p-3 space-y-3">
            <div className={sectionHeaderClass()}>{t('automations.trigger_filters.nextcloud_mail_filter_all_optional', 'Nextcloud Mail filter (all optional)')}</div>
            <FormRow label={t('automations.trigger_filters.mail_account_id', 'Mail account ID')} hint={t('automations.trigger_filters.mail_account_id_hint', 'Numeric id from the “List mail accounts” action. Leave empty for every account.')}>
                <input type="number" value={filter.accountId ?? ''} onChange={(e) => setFilter('accountId', e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="3" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.mailbox_id', 'Mailbox ID')} hint={t('automations.trigger_filters.mailbox_id_hint', 'Numeric id from the “List mailboxes” action. Leave empty for the inbox.')}>
                <input type="number" value={filter.mailboxId ?? ''} onChange={(e) => setFilter('mailboxId', e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder="12" className={inputClass() + ' font-mono'} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.from_contains', 'From contains')}>
                <input type="text" value={filter.fromContains || ''} onChange={(e) => setFilter('fromContains', e.target.value || undefined)}
                    placeholder="boss@example.com" className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.subject_contains', 'Subject contains')}>
                <input type="text" value={filter.subjectContains || ''} onChange={(e) => setFilter('subjectContains', e.target.value || undefined)} className={inputClass()} />
            </FormRow>
            <FormRow label={t('automations.trigger_filters.has_attachment', 'Has attachment')}>
                <label className="inline-flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={filter.hasAttachment === true} onChange={(e) => setFilter('hasAttachment', e.target.checked || undefined)} />
                    {t('automations.trigger_filters.only_emails_with_attachments', 'Only emails with attachments')}
                </label>
            </FormRow>
        </div>
    );
}
