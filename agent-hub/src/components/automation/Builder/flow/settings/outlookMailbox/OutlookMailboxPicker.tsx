// "My mailbox" or "Shared mailbox" plus its address: the mailbox an Outlook
// step works in, or the inbox the Outlook "New email" trigger watches.
//
// The address is written as it is typed (a half-typed one saves as a draft
// and blocks go-live, server side); this picker only says early what the
// server will say: not an address yet, or a Microsoft connection without
// shared-mailbox access (Settings → Connections).
import React, { useId, useState } from 'react';
import { useOptionalMicrosoft365Status } from '../../../../../../api/queries/microsoft365';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { AMBER_NOTE, hintTextClass, inputClass } from '../formPrimitives';
import { isMailboxAddress, isOwnMailbox } from './outlookMailbox';

interface OutlookMailboxPickerProps {
    /** The shared mailbox's address; '' or undefined for the own mailbox. */
    value: string | undefined;
    /** undefined = the own mailbox. */
    onChange: (next: string | undefined) => void;
    /** For the trigger: a shared inbox is polled about once a minute. */
    polled?: boolean;
}

export default function OutlookMailboxPicker({ value, onChange, polled = false }: OutlookMailboxPickerProps) {
    const { t } = useTranslation();
    const id = useId();
    const stored = isOwnMailbox(value) ? '' : String(value);
    // "Shared" with no address typed yet is still the own mailbox on disk, so
    // the choice keeps its own state; an address from outside (undo, another
    // step in the same panel) re-opens it.
    const [sharedChosen, setSharedChosen] = useState(stored !== '');
    const [text, setText] = useState(stored);
    if (stored !== '' && stored !== text.trim()) {
        setText(stored);
        if (!sharedChosen) setSharedChosen(true);
    }
    const shared = sharedChosen || stored !== '';

    const chooseOwn = () => { setSharedChosen(false); setText(''); onChange(undefined); };
    const chooseShared = () => { setSharedChosen(true); if (text.trim()) onChange(text.trim()); };
    const type = (next: string) => { setText(next); onChange(next.trim() ? next.trim() : undefined); };

    return (
        <fieldset className="rounded-md border border-[var(--border-subtle)] p-3 space-y-2">
            <legend className="px-1 text-xs font-medium text-[var(--text-secondary)]">{t('automations.outlook_mailbox.label', 'Mailbox')}</legend>
            <div className="flex flex-wrap gap-4 text-sm" role="radiogroup" aria-label={t('automations.outlook_mailbox.label', 'Mailbox')}>
                <label className="inline-flex items-center gap-2">
                    <input type="radio" name={`${id}-mailbox`} checked={!shared} onChange={chooseOwn} />
                    {t('automations.outlook_mailbox.mine', 'My mailbox')}
                </label>
                <label className="inline-flex items-center gap-2">
                    <input type="radio" name={`${id}-mailbox`} checked={shared} onChange={chooseShared} />
                    {t('automations.outlook_mailbox.shared', 'Shared mailbox')}
                </label>
            </div>
            {shared && <SharedAddressField id={id} text={text} onType={type} polled={polled} />}
        </fieldset>
    );
}

/** The address of the shared mailbox, with what the server would say about it. */
function SharedAddressField({ id, text, onType, polled }: { id: string; text: string; onType: (next: string) => void; polled: boolean }) {
    const { t } = useTranslation();
    const status = useOptionalMicrosoft365Status();
    const needsReconnect = status.data?.connected === true && status.data.sharedMailboxGranted === false;
    const invalid = text.trim() !== '' && !isMailboxAddress(text);
    return (
        <div className="space-y-1">
            <label htmlFor={`${id}-address`} className="block text-xs text-[var(--text-secondary)]">
                {t('automations.outlook_mailbox.address_label', 'Shared mailbox address')}
            </label>
            <input
                id={`${id}-address`}
                type="email"
                autoComplete="off"
                spellCheck={false}
                value={text}
                placeholder={t('automations.outlook_mailbox.address_placeholder', 'team@example.com')}
                aria-invalid={invalid || undefined}
                aria-describedby={`${id}-hint`}
                onChange={(e) => onType(e.target.value)}
                className={inputClass()}
            />
            {invalid && (
                <div role="alert" className={`${hintTextClass()} text-[var(--error)]`}>
                    {t('automations.outlook_mailbox.invalid', 'Enter the e-mail address of the shared mailbox.')}
                </div>
            )}
            <div id={`${id}-hint`} className={`${hintTextClass()} leading-snug`}>
                {polled
                    ? t('automations.outlook_mailbox.trigger_hint', 'Bee Flow checks this inbox for new mail about once a minute, as you. Your Microsoft administrator must give you Full Access to the mailbox.')
                    : t('automations.outlook_mailbox.step_hint', 'Bee Flow searches, reads and replies in this mailbox as you; mail sent from this step goes out from the shared mailbox. Your Microsoft administrator must give you Full Access (and Send As to send).')}
            </div>
            {needsReconnect && (
                <div className={`${AMBER_NOTE} leading-snug`}>
                    {t('automations.outlook_mailbox.needs_reconnect', 'Your Microsoft connection has no shared-mailbox access yet. Reconnect Microsoft in Settings → Connections.')}
                </div>
            )}
        </div>
    );
}
