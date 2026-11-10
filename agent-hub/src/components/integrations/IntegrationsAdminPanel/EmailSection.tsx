// "Email" section of the IntegrationsAdminPanel: the service mailbox (a Google
// account connected over OAuth, sending through the Gmail API), its display
// name and a test send. The bindings are threaded in as props from the panel.
import { Mail, Send } from 'lucide-react';
import type React from 'react';
import { API_BASE, authFetch } from '@/utils/helpers';
import { useTranslation } from '@/hooks/useTranslation';
import { DANGER_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';
import SectionHeader from '@/components/shared/SectionHeader';
import { FIELD_INPUT, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import type { EmailSectionProps } from './adminPanel.types';
import { Hint, SaveButton, StatusChip } from './ui';

type TestSendProps = Pick<EmailSectionProps, 'testEmailRecipient' | 'setTestEmailRecipient' | 'testingServiceEmail' | 'setTestingServiceEmail' | 'setShowTestEmail' | 'setMessage'>;

/** The inline test send: a recipient and Send (Enter sends too). */
function TestSend({ testEmailRecipient, setTestEmailRecipient, testingServiceEmail, setTestingServiceEmail, setShowTestEmail, setMessage }: TestSendProps) {
    const { t } = useTranslation();
    const send = async () => {
        if (!testEmailRecipient.trim()) return;
        setTestingServiceEmail(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/test-service-email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ testRecipient: testEmailRecipient }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                setMessage({ type: 'success', text: `Test email sent to ${testEmailRecipient}` });
                setTestEmailRecipient('');
                setShowTestEmail(false);
            } else {
                setMessage({ type: 'error', text: data.error || 'Failed to send test email' });
            }
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to send test email' });
        }
        setTestingServiceEmail(false);
        setTimeout(() => setMessage(null), 5000);
    };
    return (
        <div className="flex gap-2">
            <input
                type="email"
                value={testEmailRecipient}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTestEmailRecipient(e.target.value)}
                placeholder="recipient@example.com"
                aria-label={t('integ.email_send_test_email', 'Send Test Email')}
                className={FIELD_INPUT}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter' && testEmailRecipient.trim()) {
                        e.preventDefault();
                        void send();
                    }
                }}
            />
            <SaveButton id="btn-send-test-email" saving={testingServiceEmail} disabled={!testEmailRecipient.trim()} onClick={send} icon={<Send className="h-3.5 w-3.5" aria-hidden="true" />}>
                {t('integ.email_send', 'Send')}
            </SaveButton>
        </div>
    );
}

export default function EmailSection(props: EmailSectionProps) {
    const {
        hasServiceEmail, serviceEmailAddress, disconnectServiceEmail, savingServiceEmail,
        serviceEmailDisplayName, setServiceEmailDisplayName, saveServiceEmailDisplayName,
        showTestEmail, setShowTestEmail, startServiceEmailConnect, connectingServiceEmail,
    } = props;
    const { t } = useTranslation();
    return (
        <div className="flex max-w-4xl flex-col gap-6">
            <SectionHeader
                title={t('integ.email_service_email_gmail', 'Service Email (Gmail)')}
                description={t('integ.email_configure_a_gmail_service_account_to', 'Configure a Gmail service account to send emails to customers from the platform.')}
                status={hasServiceEmail ? <StatusChip>{t('integ.email_configured', 'Configured')}</StatusChip> : undefined}
            />

            <SettingsGroup title={t('integ.email_account_group', 'Sender account')}>
                <SettingsList>
                    {hasServiceEmail ? (
                        <>
                            <SettingRow icon={<Mail className="h-4 w-4" />} label={serviceEmailAddress || 'Google account'}>
                                <div className="flex justify-end gap-2">
                                    <button type="button" onClick={() => setShowTestEmail(!showTestEmail)} className={SECONDARY_BTN}>
                                        <Send className="h-3.5 w-3.5" aria-hidden="true" />
                                        {t('integ.email_send_test_email', 'Send Test Email')}
                                    </button>
                                    <button type="button" onClick={disconnectServiceEmail} disabled={savingServiceEmail} className={DANGER_BTN}>
                                        {t('integ.email_disconnect', 'Disconnect')}
                                    </button>
                                </div>
                            </SettingRow>
                            {showTestEmail && <div className="px-4 py-3"><TestSend {...props} /></div>}
                            <SettingRow htmlFor="service-email-display-name" label={t('integ.email_display_name_e_g_beeflow', 'Display Name (e.g. BeeFlow)')}>
                                <div className="flex gap-2">
                                    <input
                                        id="service-email-display-name"
                                        type="text"
                                        value={serviceEmailDisplayName}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setServiceEmailDisplayName(e.target.value)}
                                        placeholder={t('integ.email_display_name_e_g_beeflow', 'Display Name (e.g. BeeFlow)')}
                                        className={FIELD_INPUT}
                                    />
                                    <SaveButton saving={savingServiceEmail} onClick={saveServiceEmailDisplayName}>{t('integ.email_save', 'Save')}</SaveButton>
                                </div>
                            </SettingRow>
                        </>
                    ) : (
                        <SettingRow icon={<Mail className="h-4 w-4" />} label={t('integ.email_connect_google_account', 'Connect Google account')}>
                            <div className="flex justify-end">
                                <SaveButton saving={connectingServiceEmail} onClick={startServiceEmailConnect} icon={<Mail className="h-3.5 w-3.5" aria-hidden="true" />}>
                                    {t('integ.email_connect_google_account', 'Connect Google account')}
                                </SaveButton>
                            </div>
                        </SettingRow>
                    )}
                </SettingsList>
                <Hint>
                    {t('integ.email_connects_a_google_account_via', 'Connects a Google account via')} <strong>{t('integ.email_oauth', 'OAuth')}</strong> {t('integ.email_and_sends_through_the', 'and sends through the')} <strong>{t('integ.email_gmail_api_over_https', 'Gmail API over HTTPS')}</strong> {t('integ.email_no_smtp_no_app_password_and_unaffected', '— no SMTP, no App Password, and unaffected by cloud SMTP-port blocks. The connected account is the sender; approve the “Send email on your behalf” permission when prompted.')}
                </Hint>
                <Hint>
                    {t('integ.email_the_layout_text_of_the_account', 'The layout & text of the account')} <strong>{t('integ.email_verification', 'verification')}</strong> {t('integ.email_and', 'and')} <strong>{t('integ.email_welcome', 'welcome')}</strong> {t('integ.email_emails_are_configured_per_language', 'emails are configured per language under')} <span className="text-[var(--text-secondary)]">{t('integ.email_admin_languages_email_templates', 'Admin → Languages → Email Templates')}</span>.
                </Hint>
            </SettingsGroup>
        </div>
    );
}
