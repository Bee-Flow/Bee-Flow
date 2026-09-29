// "Email" section of the IntegrationsAdminPanel (Service Email via the Gmail
// API). Subtree moved verbatim from IntegrationsAdminPanel.jsx; all bindings
// are threaded in as props from the panel.
import { Check, Loader2, Mail, Send } from 'lucide-react';
import React from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';

export default function EmailSection({
    hasServiceEmail, serviceEmailAddress, disconnectServiceEmail, savingServiceEmail,
    serviceEmailDisplayName, setServiceEmailDisplayName, saveServiceEmailDisplayName,
    showTestEmail, setShowTestEmail, startServiceEmailConnect, connectingServiceEmail,
    testEmailRecipient, setTestEmailRecipient, testingServiceEmail, setTestingServiceEmail,
    setMessage,
}) {
    return (
            <div className="p-6">
            <div className="max-w-4xl mx-auto space-y-8">
                {/* Service Email (Gmail SMTP) */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            <Mail className="w-4 h-4" style={{ color: '#ea4335' }} />
                            Service Email (Gmail)
                            {hasServiceEmail && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">Configured</span>}
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            Configure a Gmail service account to send emails to customers from the platform.
                        </p>
                        <p className="text-xs mt-1.5 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                            <Mail className="w-3.5 h-3.5 shrink-0" />
                            <span>The layout &amp; text of the account <strong>verification</strong> and <strong>welcome</strong> emails are configured per language under <span style={{ color: 'var(--text-secondary)' }}>Admin → Languages → Email Templates</span>.</span>
                        </p>
                    </div>
                    <div className="p-6 space-y-3">
                        {hasServiceEmail ? (
                            <>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Connected account:</span>
                                    <span className="text-sm font-medium px-2 py-1 rounded-lg" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}>
                                        {serviceEmailAddress || 'Google account'}
                                    </span>
                                    <button
                                        onClick={disconnectServiceEmail}
                                        disabled={savingServiceEmail}
                                        className="text-xs px-2.5 py-1 rounded-lg font-medium transition-all disabled:opacity-50"
                                        style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }}
                                    >
                                        Disconnect
                                    </button>
                                </div>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={serviceEmailDisplayName}
                                        onChange={e => setServiceEmailDisplayName(e.target.value)}
                                        placeholder="Display Name (e.g. BeeFlow)"
                                        className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                    />
                                    <button
                                        onClick={saveServiceEmailDisplayName}
                                        disabled={savingServiceEmail}
                                        className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                        style={{ background: 'var(--accent-primary)', color: '#fff' }}
                                    >
                                        {savingServiceEmail ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                        Save
                                    </button>
                                    <button
                                        onClick={() => setShowTestEmail(!showTestEmail)}
                                        className="px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5"
                                        style={{ background: 'rgba(16, 185, 129, 0.1)', color: '#10b981' }}
                                    >
                                        <Send className="w-3.5 h-3.5" />
                                        Send Test Email
                                    </button>
                                </div>
                            </>
                        ) : (
                            <button
                                onClick={startServiceEmailConnect}
                                disabled={connectingServiceEmail}
                                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-2"
                                style={{ background: 'var(--accent-primary)', color: '#fff' }}
                            >
                                {connectingServiceEmail ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                                Connect Google account
                            </button>
                        )}
                        {/* Test Email inline form */}
                        {showTestEmail && hasServiceEmail && (
                            <div className="flex gap-2 pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                                <input
                                    type="email"
                                    value={testEmailRecipient}
                                    onChange={e => setTestEmailRecipient(e.target.value)}
                                    placeholder="recipient@example.com"
                                    className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && testEmailRecipient.trim()) {
                                            e.preventDefault();
                                            document.getElementById('btn-send-test-email')?.click();
                                        }
                                    }}
                                />
                                <button
                                    id="btn-send-test-email"
                                    onClick={async () => {
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
                                    }}
                                    disabled={testingServiceEmail || !testEmailRecipient.trim()}
                                    className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                    style={{ background: '#10b981', color: '#fff' }}
                                >
                                    {testingServiceEmail ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                                    Send
                                </button>
                            </div>
                        )}
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Connects a Google account via <strong>OAuth</strong> and sends through the <strong>Gmail API over HTTPS</strong> — no SMTP, no App Password, and unaffected by cloud SMTP-port blocks. The connected account is the sender; approve the “Send email on your behalf” permission when prompted.
                        </p>
                    </div>
                </div>

            </div>
            </div>
    );
}
