import { AlertTriangle, CheckCircle2, Mail, RefreshCw, Unlink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { FIELD_INPUT, SAVE_BUTTON, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { ALERT_ERROR, ALERT_SUCCESS, ALERT_WARNING, DANGER_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';
import useConfirm from '@/components/shared/useConfirm';
import { useSupportMailboxQuery } from '@/api/queries/supportInbox';
import { supportInboxApi } from '@/api/supportInboxApi';
import { errorMessage } from '@/utils/caughtError';
import { formatRelative } from './supportInboxLabels';
import type { CompanyImapMailbox, MailSecurity, SupportMailbox } from './SupportInboxPanel.types';
import { type ImapForm, type ImapTestResult, bodyFromForm, formFromMailbox, portAfterSecurityChange, suggestHosts } from './SupportImapMailbox.helpers';

/**
 * The email box of the company inbox: mail that arrives on its IMAP folder
 * becomes a ticket here, and replies to those tickets go out over its SMTP
 * account into the customer's own conversation. Passwords are write-only.
 */
export default function SupportImapMailboxSection() {
    const { t } = useTranslation();
    const query = useSupportMailboxQuery<SupportMailbox>();
    const imap = query.data?.imap ?? null;
    const { confirm, confirmDialog } = useConfirm();
    const refresh = async () => { await query.refetch(); };
    return (
        <SettingsGroup
            title={<span className="inline-flex items-center gap-2"><Mail className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />{t('support_mailbox.title', 'Email (IMAP / SMTP)')}</span>}
            description={t('support_mailbox.description', 'Connect the mailbox customers write to, such as support@yourcompany.com. New mail becomes a ticket here, and your replies go out from that address in the same email conversation. Only mail that arrives after connecting is picked up.')}
        >
            <MailboxStatus imap={imap} />
            {/* The key resets the form when a save comes back with new settings. */}
            <ImapMailboxForm key={imap ? `${imap.emailAddress}|${imap.imap.host}|${imap.username}` : 'new'} imap={imap} onChanged={refresh} confirm={confirm} />
            {confirmDialog}
        </SettingsGroup>
    );
}

function MailboxStatus({ imap }: { imap: CompanyImapMailbox | null }) {
    const { t } = useTranslation();
    if (!imap) return <Notice tone="warn">{t('support_mailbox.not_connected', 'No mailbox connected. Tickets arrive only through the contact form and from inside the app.')}</Notice>;
    if (imap.syncStatus === 'error') {
        return <Notice tone="bad">{t('support_mailbox.sync_error', 'Reading {address} failed:', { address: imap.emailAddress })} {imap.syncError}</Notice>;
    }
    return (
        <Notice tone="ok">
            {t('support_mailbox.connected', 'Connected to {address}.', { address: imap.emailAddress })}
            {imap.lastSyncAt ? ` ${t('support_mailbox.last_read', 'Last read {when}.', { when: formatRelative(imap.lastSyncAt) })}` : ''}
        </Notice>
    );
}

const NOTICE = {
    ok: { cls: ALERT_SUCCESS, Icon: CheckCircle2 },
    warn: { cls: ALERT_WARNING, Icon: AlertTriangle },
    bad: { cls: ALERT_ERROR, Icon: AlertTriangle },
} as const;

function Notice({ tone, children }: { tone: keyof typeof NOTICE; children?: React.ReactNode }) {
    const { cls, Icon } = NOTICE[tone];
    return (
        <div className={cls} role={tone === 'bad' ? 'alert' : undefined}>
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{children}</span>
        </div>
    );
}

interface FormProps {
    imap: CompanyImapMailbox | null;
    onChanged: () => Promise<void>;
    confirm: ReturnType<typeof useConfirm>['confirm'];
}

function ImapMailboxForm({ imap, onChanged, confirm }: FormProps) {
    const { t } = useTranslation();
    const [form, setForm] = useState<ImapForm>(() => formFromMailbox(imap));
    const set = <K extends keyof ImapForm>(key: K, value: ImapForm[K]) => setForm((f) => ({ ...f, [key]: value }));
    const actions = useImapActions(form, { onChanged, confirm, t });
    // Leaving the address field fills empty server fields with a guess to correct.
    const fillHosts = () => {
        const s = suggestHosts(form.emailAddress);
        if (s) setForm((f) => ({ ...f, imapHost: f.imapHost || s.imapHost, smtpHost: f.smtpHost || s.smtpHost, username: f.username || f.emailAddress }));
    };
    return (
        <>
            <SettingsList>
                <SettingRow htmlFor="support-imap-address" label={t('support_mailbox.address', 'Email address')} hint={t('support_mailbox.address_hint', 'The address customers write to and replies come from.')}>
                    <input id="support-imap-address" type="email" value={form.emailAddress} onChange={(e) => set('emailAddress', e.target.value)} onBlur={fillHosts} placeholder="support@example.com" className={FIELD_INPUT} autoComplete="off" />
                </SettingRow>
                <SettingRow htmlFor="support-imap-name" label={t('support_mailbox.display_name', 'Sender name')} hint={t('support_mailbox.display_name_hint', 'Shown next to the address in the customer\'s inbox.')}>
                    <input id="support-imap-name" value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder={t('support_mailbox.display_name_placeholder', 'Customer support')} className={FIELD_INPUT} />
                </SettingRow>
                <SettingRow htmlFor="support-imap-user" label={t('support_mailbox.username', 'User name')} hint={t('support_mailbox.username_hint', 'Usually the email address itself.')}>
                    <input id="support-imap-user" value={form.username} onChange={(e) => set('username', e.target.value)} placeholder={form.emailAddress || 'support@example.com'} className={FIELD_INPUT} autoComplete="off" />
                </SettingRow>
                <SettingRow htmlFor="support-imap-password" label={t('support_mailbox.password', 'Password')} hint={t('support_mailbox.password_hint', 'Stored encrypted and never shown again. Leave blank to keep the current one. With Gmail or Microsoft 365, use an app password.')}>
                    <input id="support-imap-password" type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={imap ? t('support.connections_unchanged', '••••••••  (unchanged)') : ''} className={FIELD_INPUT} autoComplete="new-password" />
                </SettingRow>
            </SettingsList>
            <ServerFields kind="imap" form={form} setForm={setForm} />
            <ServerFields kind="smtp" form={form} setForm={setForm} />
            <SmtpLoginFields form={form} set={set} connected={!!imap} />
            <SettingsList>
                <label className="flex cursor-pointer items-start gap-3 px-4 py-3 text-xs">
                    <input type="checkbox" className="mt-0.5 accent-[var(--accent-primary)]" checked={form.aiAutoReply} onChange={(e) => set('aiAutoReply', e.target.checked)} />
                    <span className="text-[var(--text-secondary)]">
                        <strong className="text-[var(--text-primary)]">{t('support_mailbox.ai_auto_reply', 'Let the AI answer new email tickets.')}</strong>{' '}
                        {t('support_mailbox.ai_auto_reply_hint', 'Off by default. When on, the support agent replies by email with a note that it is an AI, and hands over to the team when it is unsure. Once someone from the team has replied, the AI stays out of that ticket.')}
                    </span>
                </label>
            </SettingsList>
            <ActionResult result={actions.result} error={actions.error} />
            <ActionButtons actions={actions} connected={!!imap} />
        </>
    );
}

function ServerFields({ kind, form, setForm }: { kind: 'imap' | 'smtp'; form: ImapForm; setForm: React.Dispatch<React.SetStateAction<ImapForm>> }) {
    const { t } = useTranslation();
    const host = kind === 'imap' ? 'imapHost' : 'smtpHost';
    const port = kind === 'imap' ? 'imapPort' : 'smtpPort';
    const security = kind === 'imap' ? 'imapSecurity' : 'smtpSecurity';
    const onSecurity = (to: MailSecurity) => setForm((f) => ({ ...f, [security]: to, [port]: portAfterSecurityChange(kind, f[security], to, f[port]) }));
    const label = kind === 'imap' ? t('support_mailbox.incoming', 'Incoming mail (IMAP)') : t('support_mailbox.outgoing', 'Outgoing mail (SMTP)');
    return (
        <SettingsList>
            <SettingRow htmlFor={`support-${kind}-host`} label={label} hint={t('support_mailbox.server_hint', 'Server, port and security, as your mail provider lists them.')}>
                <div className="flex flex-wrap gap-2">
                    <input id={`support-${kind}-host`} aria-label={t('support_mailbox.server', 'Server')} value={form[host]} onChange={(e) => setForm((f) => ({ ...f, [host]: e.target.value }))} placeholder={kind === 'imap' ? 'imap.example.com' : 'smtp.example.com'} className={`${FIELD_INPUT} min-w-0 flex-[3]`} autoComplete="off" />
                    <input aria-label={t('support_mailbox.port', 'Port')} inputMode="numeric" value={form[port]} onChange={(e) => setForm((f) => ({ ...f, [port]: e.target.value }))} className={`${FIELD_INPUT} w-20 flex-none`} />
                    <select aria-label={t('support_mailbox.security', 'Security')} value={form[security]} onChange={(e) => onSecurity(e.target.value as MailSecurity)} className={`${FIELD_INPUT} w-32 flex-none`}>
                        <option value="tls">{t('support_mailbox.security_tls', 'SSL/TLS')}</option>
                        <option value="starttls">{t('support_mailbox.security_starttls', 'STARTTLS')}</option>
                    </select>
                </div>
            </SettingRow>
            {kind === 'imap' && (
                <SettingRow htmlFor="support-imap-folder" label={t('support_mailbox.folder', 'Folder')} hint={t('support_mailbox.folder_hint', 'Where new mail arrives. Almost always INBOX.')}>
                    <input id="support-imap-folder" value={form.folder} onChange={(e) => setForm((f) => ({ ...f, folder: e.target.value }))} className={FIELD_INPUT} />
                </SettingRow>
            )}
        </SettingsList>
    );
}

function SmtpLoginFields({ form, set, connected }: { form: ImapForm; set: <K extends keyof ImapForm>(k: K, v: ImapForm[K]) => void; connected: boolean }) {
    const { t } = useTranslation();
    return (
        <SettingsList>
            <label className="flex cursor-pointer items-start gap-3 px-4 py-3 text-xs">
                <input type="checkbox" className="mt-0.5 accent-[var(--accent-primary)]" checked={form.separateSmtpLogin} onChange={(e) => set('separateSmtpLogin', e.target.checked)} />
                <span className="text-[var(--text-secondary)]">{t('support_mailbox.separate_smtp', 'The SMTP server uses a different login (a relay service, for example).')}</span>
            </label>
            {form.separateSmtpLogin && (
                <>
                    <SettingRow htmlFor="support-smtp-user" label={t('support_mailbox.smtp_username', 'SMTP user name')}>
                        <input id="support-smtp-user" value={form.smtpUsername} onChange={(e) => set('smtpUsername', e.target.value)} className={FIELD_INPUT} autoComplete="off" />
                    </SettingRow>
                    <SettingRow htmlFor="support-smtp-password" label={t('support_mailbox.smtp_password', 'SMTP password')}>
                        <input id="support-smtp-password" type="password" value={form.smtpPassword} onChange={(e) => set('smtpPassword', e.target.value)} placeholder={connected ? t('support.connections_unchanged', '••••••••  (unchanged)') : ''} className={FIELD_INPUT} autoComplete="new-password" />
                    </SettingRow>
                </>
            )}
        </SettingsList>
    );
}

type Busy = 'test' | 'save' | 'sync' | 'delete' | null;
type ActionOutcome = { tone: 'ok' | 'bad'; text: string; test?: ImapTestResult } | null;

interface ActionsDeps { onChanged: () => Promise<void>; confirm: FormProps['confirm']; t: TranslateFn }

/** Test, save, read now and disconnect, with one outcome line for whichever ran last. */
function useImapActions(form: ImapForm, { onChanged, confirm, t }: ActionsDeps) {
    const [busy, setBusy] = useState<Busy>(null);
    const [result, setResult] = useState<ActionOutcome>(null);
    const [error, setError] = useState<string | null>(null);

    const run = async (kind: Exclude<Busy, null>, fn: () => Promise<void>) => {
        setBusy(kind);
        setError(null);
        setResult(null);
        try { await fn(); } catch (e) { setError(errorMessage(e) ?? null); } finally { setBusy(null); }
    };
    const readJson = async (res: Response) => res.json().catch(() => ({})) as Promise<{ error?: string; test?: ImapTestResult; handled?: number }>;

    const test = () => run('test', async () => {
        const res = await supportInboxApi.testImapMailbox(bodyFromForm(form));
        const d = await readJson(res);
        if (!res.ok) { setError(d.error || t('support_mailbox.test_failed', 'The connection test failed.')); return; }
        setResult(d.test?.ok
            ? { tone: 'ok', text: t('support_mailbox.test_ok', 'Both servers accepted the login.'), test: d.test }
            : { tone: 'bad', text: t('support_mailbox.test_failed', 'The connection test failed.'), test: d.test });
    });
    const save = () => run('save', async () => {
        const res = await supportInboxApi.saveImapMailbox(bodyFromForm(form));
        const d = await readJson(res);
        if (!res.ok) { setResult({ tone: 'bad', text: d.error || t('support_mailbox.save_failed', 'Could not save the mailbox.'), test: d.test }); return; }
        await onChanged();
    });
    const sync = () => run('sync', async () => {
        const res = await supportInboxApi.syncImapMailbox();
        const d = await readJson(res);
        if (!res.ok || d.error) { setError(d.error || t('support_mailbox.sync_failed', 'Reading the mailbox failed.')); return; }
        setResult({ tone: 'ok', text: t('support_mailbox.sync_done', 'Mailbox read: {count} message(s) handled.', { count: d.handled ?? 0 }) });
        await onChanged();
    });
    const disconnect = () => run('delete', async () => {
        const ok = await confirm({
            title: t('support_mailbox.disconnect_title', 'Disconnect the mailbox?'),
            description: t('support_mailbox.disconnect_description', 'New mail is no longer picked up and replies to email tickets go out as notification emails again. Tickets that already came in stay.'),
            confirmLabel: t('support_mailbox.disconnect', 'Disconnect'),
            destructive: true,
        });
        if (!ok) return;
        const res = await supportInboxApi.deleteImapMailbox();
        if (!res.ok) { setError((await readJson(res)).error || t('support_mailbox.disconnect_failed', 'Disconnecting failed.')); return; }
        await onChanged();
    });
    return { busy, result, error, test, save, sync, disconnect };
}

function ActionResult({ result, error }: { result: ActionOutcome; error: string | null }) {
    if (error) return <Notice tone="bad">{error}</Notice>;
    if (!result) return null;
    const details = [result.test?.imap.error, result.test?.smtp.error].filter(Boolean);
    return <Notice tone={result.tone}>{result.text}{details.length ? ` ${details.join(' ')}` : ''}</Notice>;
}

function ActionButtons({ actions, connected }: { actions: ReturnType<typeof useImapActions>; connected: boolean }) {
    const { t } = useTranslation();
    const { busy } = actions;
    return (
        <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={actions.save} disabled={!!busy} className={SAVE_BUTTON}>
                {busy === 'save' ? t('support_mailbox.saving', 'Testing and saving…') : t('support_mailbox.save', 'Save mailbox')}
            </button>
            <button type="button" onClick={actions.test} disabled={!!busy} className={SECONDARY_BTN}>
                {busy === 'test' ? t('support_mailbox.testing', 'Testing…') : t('support_mailbox.test', 'Test connection')}
            </button>
            {connected && (
                <>
                    <button type="button" onClick={actions.sync} disabled={!!busy} className={SECONDARY_BTN}>
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        {busy === 'sync' ? t('support_mailbox.reading', 'Reading…') : t('support_mailbox.read_now', 'Read now')}
                    </button>
                    <button type="button" onClick={actions.disconnect} disabled={!!busy} className={`${DANGER_BTN} ml-auto`}>
                        <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('support_mailbox.disconnect', 'Disconnect')}
                    </button>
                </>
            )}
        </div>
    );
}
