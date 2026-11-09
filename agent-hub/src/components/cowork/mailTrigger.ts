/**
 * Pure helpers for the "When a new email arrives" trigger of a Cowork item.
 *
 * The trigger rides on the same row as a schedule (`triggerKind: 'app_event'`), so
 * the composer, the agent editor and the list all need the same three answers: what
 * a fresh trigger looks like, whether it can be saved, and how to print it.
 */
import { isMailboxAddress, isOwnMailbox } from '@/components/automation/Builder/flow/settings/outlookMailbox/outlookMailbox';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { CoworkRequestError } from '@/api/coworkApi';
import { errorMessage } from '@/utils/caughtError';
import type { CoworkPayload, CoworkTriggerPayload, MailProvider, MailTrigger, MailTriggerFilter } from '@/api/cowork.types';

export const MAIL_PROVIDERS: readonly MailProvider[] = ['gmail', 'msgraph'];

export function defaultMailTrigger(provider: MailProvider = 'gmail'): MailTrigger {
    return { provider, event: 'mail.new', filter: {} };
}

/** Drop empty strings and keys that do not belong to the provider, so the server only sees what was meant. */
export function cleanMailFilter(provider: MailProvider, filter: MailTriggerFilter | undefined): MailTriggerFilter {
    const f = filter || {};
    const out: MailTriggerFilter = {};
    if (f.from?.trim()) out.from = f.from.trim();
    if (f.subjectContains?.trim()) out.subjectContains = f.subjectContains.trim();
    if (provider === 'gmail') {
        const labels = (f.labelIds || []).map(l => l.trim()).filter(Boolean);
        if (labels.length > 0) out.labelIds = labels;
    }
    if (provider === 'msgraph' && f.mailbox && !isOwnMailbox(f.mailbox)) out.mailbox = f.mailbox.trim();
    return out;
}

export function normaliseMailTrigger(trigger: MailTrigger): MailTrigger {
    return { provider: trigger.provider, event: 'mail.new', filter: cleanMailFilter(trigger.provider, trigger.filter) };
}

/** A shared Outlook mailbox needs a real address; everything else is optional. */
export function isMailTriggerReady(trigger: MailTrigger | null | undefined): boolean {
    if (!trigger) return false;
    const mailbox = trigger.filter?.mailbox;
    if (trigger.provider === 'msgraph' && mailbox && !isOwnMailbox(mailbox)) return isMailboxAddress(mailbox);
    return true;
}

export function mailProviderLabel(provider: string, t: TranslateFn): string {
    return provider === 'msgraph' ? t('cowork.mail_trigger.provider_outlook', 'Outlook') : t('cowork.mail_trigger.provider_gmail', 'Gmail');
}

/** "On new email · Gmail" (and the shared mailbox, when there is one). */
export function describeMailTrigger(trigger: MailTrigger, t: TranslateFn): string {
    const base = t('cowork.mail_trigger.summary', 'On new email · {provider}', { provider: mailProviderLabel(trigger.provider, t) });
    const mailbox = trigger.filter?.mailbox;
    return trigger.provider === 'msgraph' && mailbox && !isOwnMailbox(mailbox) ? `${base} · ${mailbox}` : base;
}

export function isMailTriggerItem(item: { triggerKind?: string | null; trigger?: MailTrigger | null }): item is { triggerKind: 'app_event'; trigger: MailTrigger } {
    return item.triggerKind === 'app_event' && !!item.trigger;
}

/** The line under the composer after a create: run now, watching for mail, or just scheduled. */
export function createdFlash(payload: CoworkPayload | CoworkTriggerPayload, t: TranslateFn): string {
    if ('startNow' in payload && payload.startNow) return 'Off it goes — the result lands in your notifications.';
    return 'triggerKind' in payload && payload.triggerKind === 'app_event' ? t('cowork.flash.watching_mail', 'Watching for new email.') : 'Scheduled.';
}

/** What a refused save says; a mail account that is not connected gets its own sentence. */
export function saveErrorMessage(err: unknown, t: TranslateFn): string | undefined {
    return (err as CoworkRequestError)?.code === 'mail_not_connected'
        ? t('cowork.mail_trigger.error_not_connected', 'That mail account is not connected. Connect it in Settings → Connections and try again.')
        : errorMessage(err);
}
