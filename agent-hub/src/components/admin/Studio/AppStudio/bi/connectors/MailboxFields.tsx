import { CheckCircle2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { postConnector } from '../../../../../../api/connectorHttp';
import { TextField } from './ConnectorFields';
import { INPUT, LABEL } from './connectorModel';
import type { Connector } from './connectorModel';
import useTranslation from '../../../../../../hooks/useTranslation';
import { errorMessage } from '../../../../../../utils/caughtError';

/** Sets (or, for '' / null, removes) one optional connector field. */
export type SetOpt = (key: string, value: unknown) => void;

interface VerifyResult {
    ok?: boolean;
    mailbox?: string;
    hint?: string;
    error?: string;
}

/** The last "Check access" answer; held by MailboxFields so it outlives the button. */
function useVerify(connector: Connector, appId: string | null) {
    const { t } = useTranslation();
    const [verify, setVerify] = useState<VerifyResult | null>(null);
    const [verifying, setVerifying] = useState(false);

    const runVerify = async () => {
        setVerifying(true);
        setVerify(null);
        try {
            const res = await postConnector(appId as string, connector.id, 'verify', '{}');
            const body = await res.json().catch(() => null);
            setVerify(body || { ok: false, error: t('studio_apps_bi.connectors.check_failed', 'Check failed ({status})', { status: res.status }) });
        } catch (e) {
            setVerify({ ok: false, error: errorMessage(e) });
        } finally {
            setVerifying(false);
        }
    };
    return { verify, verifying, runVerify };
}

/** "Check access": confirms the mailbox is reachable before you rely on it. */
function VerifyAccess({ connector, disabled, state }: { connector: Connector; disabled?: boolean; state: ReturnType<typeof useVerify> }) {
    const { t } = useTranslation();
    const { verify, verifying, runVerify } = state;
    return (
        <div className="flex items-center gap-3">
            <button
                type="button"
                onClick={runVerify}
                disabled={disabled || verifying || !connector.provider}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-default)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] disabled:opacity-50"
            >
                {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
                {t('studio_apps_bi.connectors.check_access', 'Check access')}
            </button>
            {verify ? (
                <span className={`text-xs ${verify.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--warning)]'}`}>
                    {verify.ok
                        ? t('studio_apps_bi.connectors.reachable', 'Reachable — {mailbox}.', { mailbox: verify.mailbox || t('studio_apps_bi.connectors.your_mailbox', 'your mailbox') })
                        : (verify.hint || verify.error || t('studio_apps_bi.connectors.mailbox_unreachable', 'Could not reach that mailbox.'))}
                </span>
            ) : (
                <span className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_bi.connectors.check_access_hint', 'Confirms the mailbox is reachable before you rely on it.')}</span>
            )}
        </div>
    );
}

interface MailboxFieldsProps {
    connector: Connector;
    setOpt: SetOpt;
    disabled?: boolean;
    appId: string | null;
    saved?: boolean;
}

/**
 * Mailbox settings.
 *
 * The point this panel has to make, because it is the thing people ask about:
 * there is NO separate sign-in here. It reads mail with the Google or Microsoft
 * account you already used to sign in to Bee Flow.
 *
 * "Shared" means different things per provider and we say so out loud rather
 * than letting someone discover it at send time: Outlook can open a real shared
 * mailbox you have been given access to; the Gmail API cannot open anyone
 * else's mailbox at all, so there it means mail delivered to a team address
 * inside your own.
 */
export default function MailboxFields({ connector, setOpt, disabled, appId, saved }: MailboxFieldsProps) {
    const { t } = useTranslation();
    const shared = connector.mode === 'shared';
    const isGmail = connector.provider === 'gmail';
    const verifyState = useVerify(connector, appId);

    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('studio_apps_bi.connectors.mail_provider', 'Mail provider')}</span>
                    <select
                        className={INPUT}
                        value={connector.provider || ''}
                        onChange={(e) => setOpt('provider', e.target.value || undefined)}
                        disabled={disabled}
                        aria-label={t('studio_apps_bi.connectors.mail_provider', 'Mail provider')}
                    >
                        <option value="">{t('studio_apps_bi.connectors.choose', 'Choose…')}</option>
                        <option value="gmail">Gmail</option>
                        <option value="outlook">Outlook</option>
                    </select>
                </label>
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('studio_apps_bi.connectors.which_mailbox', 'Which mailbox')}</span>
                    <select
                        className={INPUT}
                        value={connector.mode || 'personal'}
                        onChange={(e) => setOpt('mode', e.target.value)}
                        disabled={disabled}
                        aria-label={t('studio_apps_bi.connectors.which_mailbox', 'Which mailbox')}
                    >
                        <option value="personal">{t('studio_apps_bi.connectors.mailbox_mine', 'Mine (the account I signed in with)')}</option>
                        <option value="shared">{t('studio_apps_bi.connectors.mailbox_shared', 'A shared mailbox')}</option>
                    </select>
                </label>
            </div>

            <p className="-mt-1 text-xs text-[var(--text-tertiary)]">
                {t('studio_apps_bi.connectors.mailbox_uses_account', 'Uses the {provider} account you signed in to Bee Flow with — there is no separate sign-in here.', { provider: isGmail ? 'Google' : connector.provider === 'outlook' ? 'Microsoft' : t('studio_apps_bi.connectors.google_or_microsoft', 'Google or Microsoft') })}
            </p>

            {shared ? (
                <>
                    <TextField
                        label={t('studio_apps_bi.connectors.shared_address', 'Shared mailbox address')}
                        value={connector.address}
                        onChange={(v) => setOpt('address', v)}
                        disabled={disabled}
                        placeholder="support@yourcompany.com"
                    />
                    <p className="-mt-1 text-xs text-[var(--text-tertiary)]">
                        {isGmail
                            ? t('studio_apps_bi.connectors.shared_gmail_note', 'Gmail cannot open someone else’s mailbox, so this must be a team address delivered to your own inbox and verified as a “send mail as” alias.')
                            : t('studio_apps_bi.connectors.shared_outlook_note', 'Your Microsoft admin must have given you access to this mailbox, and the connection needs the shared-mailbox permission (reconnect Microsoft in Settings → Connections if it does not).')}
                    </p>
                </>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
                <TextField
                    label={t('studio_apps_bi.connectors.folder_or_label', 'Folder or label')}
                    value={connector.folder}
                    onChange={(v) => setOpt('folder', v)}
                    disabled={disabled}
                    placeholder="inbox"
                />
                <TextField
                    label={t('studio_apps_bi.connectors.mail_matching', 'Only mail matching (optional)')}
                    value={connector.query}
                    onChange={(v) => setOpt('query', v)}
                    disabled={disabled}
                    placeholder="label:support"
                />
            </div>
            <p className="-mt-1 text-xs text-[var(--text-tertiary)]">
                {t('studio_apps_bi.connectors.mail_matching_hint', 'A search keeps the table to the mail you actually want. Leave it empty to take everything in the folder.')}
            </p>

            {saved ? <VerifyAccess connector={connector} disabled={disabled} state={verifyState} /> : null}
        </div>
    );
}
