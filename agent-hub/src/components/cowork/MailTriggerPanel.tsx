/**
 * The "when a new email arrives" settings, built once for both places that start an
 * agent from mail: the Cowork composer's "How often?" sheet and the agent editor's
 * Triggers popover.
 *
 * Provider (only the mail apps the account can use), the Outlook mailbox (own or
 * shared) and a few optional filters. It holds no state of its own: the caller owns
 * the trigger and this edits it.
 */
import React, { useEffect } from 'react';
import { useCoworkMailProvidersQuery } from '@/api/queries/coworkReads';
import { useTranslation } from '@/hooks/useTranslation';
import OutlookMailboxPicker from '@/components/automation/Builder/flow/settings/outlookMailbox/OutlookMailboxPicker';
import { MAIL_PROVIDERS, defaultMailTrigger, mailProviderLabel } from './mailTrigger';
import type { MailProvider, MailTrigger, MailTriggerFilter } from '@/api/cowork.types';

interface MailTriggerPanelProps {
    value: MailTrigger;
    onChange: (next: MailTrigger) => void;
    disabled?: boolean;
}

const FIELD = 'w-full px-2.5 py-1.5 rounded-lg border bg-[var(--bg-card)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] [border-color:var(--border-subtle)]!';
const LABEL = 'block text-[11px] mb-1 text-[var(--text-tertiary)]';

export default function MailTriggerPanel({ value, onChange, disabled = false }: MailTriggerPanelProps) {
    const { t } = useTranslation();
    const providers = useCoworkMailProvidersQuery();
    // Which mail apps to offer: the connected ones. When the read fails, both: the
    // save still refuses an account that is not connected, with its own sentence.
    const available: MailProvider[] = providers.isError
        ? [...MAIL_PROVIDERS]
        : MAIL_PROVIDERS.filter(id => (providers.data || []).includes(id));
    const loaded = providers.isSuccess;
    const provider = value.provider;
    const filter: MailTriggerFilter = value.filter || {};

    // The default is Gmail; when only Outlook is connected, start there instead.
    const firstAvailable = available[0];
    const needsSnap = loaded && !!firstAvailable && !available.includes(provider);
    useEffect(() => {
        if (needsSnap && firstAvailable) onChange(defaultMailTrigger(firstAvailable));
    }, [needsSnap, firstAvailable, onChange]);

    const setFilter = (key: keyof MailTriggerFilter, next: unknown) => {
        const merged: MailTriggerFilter = { ...filter };
        if (next === undefined || next === '') delete merged[key];
        else (merged as Record<string, unknown>)[key] = next;
        onChange({ ...value, filter: merged });
    };

    if (loaded && available.length === 0) {
        return (
            <div role="status" data-testid="mail-trigger-none" className="px-3 py-2 text-[12px] text-[var(--text-tertiary)]">
                {t('cowork.mail_trigger.none_connected', 'Connect Gmail or Outlook in Settings → Connections first.')}
            </div>
        );
    }

    // Until the connections are known (or while the trigger still moves to the connected
    // app), show no fields: Gmail's would be the wrong ones for an Outlook account.
    if (providers.isPending || needsSnap) {
        return <div aria-busy="true" data-testid="mail-trigger-loading" className="px-3 py-2 h-8" />;
    }

    return (
        <div className="space-y-2.5 px-3 py-2" data-testid="mail-trigger-panel">
            {available.length > 1 && (
                <div role="radiogroup" aria-label={t('cowork.mail_trigger.provider_aria', 'Mail app')} className="flex gap-1.5">
                    {available.map(id => (
                        <button
                            key={id}
                            type="button"
                            role="radio"
                            aria-checked={provider === id}
                            disabled={disabled}
                            onClick={() => onChange(defaultMailTrigger(id))}
                            className={`px-3 py-1 rounded-full border text-[12px] ${provider === id ? 'font-semibold bg-[var(--bg-secondary)] [border-color:var(--accent-primary)]!' : 'text-[var(--text-secondary)] [border-color:var(--border-subtle)]!'}`}
                        >
                            {mailProviderLabel(id, t)}
                        </button>
                    ))}
                </div>
            )}
            {provider === 'msgraph' && (
                <OutlookMailboxPicker
                    value={filter.mailbox}
                    onChange={(next) => setFilter('mailbox', next)}
                    polled
                />
            )}
            <FilterFields provider={provider} filter={filter} disabled={disabled} setFilter={setFilter} />
        </div>
    );
}

interface FilterFieldsProps {
    provider: MailProvider;
    filter: MailTriggerFilter;
    disabled: boolean;
    setFilter: (key: keyof MailTriggerFilter, next: unknown) => void;
}

function FilterFields({ provider, filter, disabled, setFilter }: FilterFieldsProps) {
    const { t } = useTranslation();
    return (
        <>
            <div>
                <label className={LABEL} htmlFor="mail-trigger-from">{t('cowork.mail_trigger.from', 'From contains (optional)')}</label>
                <input
                    id="mail-trigger-from"
                    type="text"
                    value={filter.from || ''}
                    disabled={disabled}
                    onChange={(e) => setFilter('from', e.target.value)}
                    placeholder="boss@example.com"
                    className={FIELD}
                />
            </div>
            <div>
                <label className={LABEL} htmlFor="mail-trigger-subject">{t('cowork.mail_trigger.subject', 'Subject contains (optional)')}</label>
                <input
                    id="mail-trigger-subject"
                    type="text"
                    value={filter.subjectContains || ''}
                    disabled={disabled}
                    onChange={(e) => setFilter('subjectContains', e.target.value)}
                    className={FIELD}
                />
            </div>
            {provider === 'gmail' && (
                <div>
                    <label className={LABEL} htmlFor="mail-trigger-label">{t('cowork.mail_trigger.label', 'Gmail label id (optional)')}</label>
                    <input
                        id="mail-trigger-label"
                        type="text"
                        value={filter.labelIds?.[0] || ''}
                        disabled={disabled}
                        onChange={(e) => setFilter('labelIds', e.target.value ? [e.target.value] : undefined)}
                        className={FIELD}
                    />
                </div>
            )}
        </>
    );
}
