import { AlertTriangle, CheckCircle2, Link2, MessageSquare, Send, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { authFetch, API_BASE } from '../../utils/helpers';

/**
 * Where support connects to the outside world: YouTrack, and the team chat
 * space that gets told about new tickets.
 *
 * Neither credential ever comes back to the browser. The YouTrack token is
 * write-only, and a Google Chat webhook URL carries its key and token in the
 * query string — so the URL *is* the credential and the server only reports
 * the host it points at.
 */

const PROVIDERS = [
    { id: 'google_chat', label: 'Google Chat' },
    { id: 'slack', label: 'Slack' },
    { id: 'teams', label: 'Microsoft Teams' },
    { id: 'generic', label: 'Plain JSON webhook' },
];

// Written from the reader's side: what happens, not which table it touches.
const EVENT_LABELS = {
    ticket_created: 'A new ticket arrives',
    customer_message: 'A customer replies',
    sla_breach: 'An SLA is breached',
    escalation: 'A ticket is escalated to engineering',
    issue_resolved: 'A linked issue is resolved',
};

function Row({ label, hint, children }) {
    return (
        <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</label>
            {children}
            {hint && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{hint}</span>}
        </div>
    );
}

function Banner({ tone, children }) {
    const tones = {
        ok: { bg: 'rgba(16,185,129,0.10)', fg: '#059669', Icon: CheckCircle2 },
        warn: { bg: 'rgba(245,158,11,0.10)', fg: '#b45309', Icon: AlertTriangle },
        bad: { bg: 'rgba(239,68,68,0.10)', fg: '#dc2626', Icon: AlertTriangle },
    };
    const { bg, fg, Icon } = tones[tone] || tones.warn;
    return (
        <div className="rounded px-2.5 py-2 text-xs flex items-start gap-2" style={{ background: bg, color: fg }}>
            <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{children}</span>
        </div>
    );
}

export default function SupportConnectionsConfig() {
    const [yt, setYt] = useState(null);
    const [ytUrl, setYtUrl] = useState('');
    const [ytToken, setYtToken] = useState('');
    const [ytProject, setYtProject] = useState('');
    const [ytSaving, setYtSaving] = useState(false);
    const [ytError, setYtError] = useState(null);

    const [chat, setChat] = useState(null);
    const [hook, setHook] = useState('');
    const [chatSaving, setChatSaving] = useState(false);
    const [chatError, setChatError] = useState(null);
    const [testResult, setTestResult] = useState(null);

    const [includeSubject, setIncludeSubject] = useState(false);

    const loadYt = useCallback(async () => {
        try {
            const res = await authFetch(`${API_BASE}/api/support/youtrack/status`);
            if (res.ok) {
                const d = await res.json();
                setYt(d);
                setYtProject(d.defaultProject || '');
                setIncludeSubject(!!d.includeSubject);
            }
        } catch (e) {
            setYtError(e.message);
        }
    }, []);

    const loadChat = useCallback(async () => {
        try {
            const res = await authFetch(`${API_BASE}/api/support/notifications`);
            if (res.ok) setChat(await res.json());
        } catch (e) {
            setChatError(e.message);
        }
    }, []);

    useEffect(() => { loadYt(); loadChat(); }, [loadYt, loadChat]);

    // `subject` is passed explicitly rather than read from state: the checkbox
    // calls this from its own onChange, where the state update has not landed
    // yet and the closure would still hold the previous value.
    const saveYt = async ({ subject = includeSubject } = {}) => {
        setYtSaving(true);
        setYtError(null);
        try {
            const body = { project: ytProject, includeSubject: subject };
            if (ytUrl.trim()) body.url = ytUrl.trim();
            if (ytToken.trim()) body.token = ytToken.trim();
            const res = await authFetch(`${API_BASE}/api/support/youtrack/connection`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { setYtError(d.error || 'Could not save'); return; }
            setYtToken('');
            setYtUrl('');
            setYt(d.status);
        } catch (e) {
            setYtError(e.message);
        } finally {
            setYtSaving(false);
        }
    };

    const saveChat = async (patch) => {
        setChatSaving(true);
        setChatError(null);
        setTestResult(null);
        try {
            const body = { ...patch };
            if (hook.trim()) body.webhookUrl = hook.trim();
            const res = await authFetch(`${API_BASE}/api/support/notifications`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const d = await res.json().catch(() => ({}));
            if (!res.ok) { setChatError(d.error || 'Could not save'); return; }
            setHook('');
            setChat(d.settings);
        } catch (e) {
            setChatError(e.message);
        } finally {
            setChatSaving(false);
        }
    };

    const toggleEvent = (id) => {
        const next = chat?.events?.includes(id)
            ? chat.events.filter(e => e !== id)
            : [...(chat?.events || []), id];
        saveChat({ events: next });
    };

    const test = async () => {
        setTestResult(null);
        try {
            const res = await authFetch(`${API_BASE}/api/support/notifications/test`, { method: 'POST' });
            const d = await res.json().catch(() => ({}));
            // Report what the endpoint actually said — "test failed" with no
            // detail is why nobody trusts a test button.
            setTestResult(res.ok ? { ok: true } : { ok: false, error: d.error || 'Delivery failed' });
        } catch (e) {
            setTestResult({ ok: false, error: e.message });
        }
    };

    const inputStyle = {
        background: 'var(--bg-card)',
        borderColor: 'var(--border-default)',
        color: 'var(--text-primary)',
    };

    return (
        <div className="p-6 overflow-y-auto h-full flex flex-col gap-8 max-w-2xl">
            {/* ── YouTrack ─────────────────────────────────────────────── */}
            <section className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <Link2 className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>YouTrack</h3>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    One connection the whole support team shares, so a linked issue shows its status to
                    whoever opens the ticket next.
                </p>

                {yt?.configured && yt?.ok && (
                    <Banner tone="ok">Connected to {yt.host}. {yt.projects?.length || 0} projects visible.</Banner>
                )}
                {yt?.configured && !yt?.ok && (
                    <Banner tone="bad">Can&apos;t reach {yt.host}: {yt.error}</Banner>
                )}
                {yt && !yt.configured && (
                    <Banner tone="warn">Not connected yet. Agents can&apos;t link or create issues until this is set.</Banner>
                )}
                {ytError && <Banner tone="bad">{ytError}</Banner>}

                <Row label="Server URL" hint={yt?.host ? `Currently ${yt.host}. Leave blank to keep it.` : 'For example https://youtrack.example.com'}>
                    <input
                        value={ytUrl}
                        onChange={e => setYtUrl(e.target.value)}
                        placeholder={yt?.host ? `https://${yt.host}` : 'https://youtrack.example.com'}
                        className="px-2 py-1.5 rounded border text-sm"
                        style={inputStyle}
                    />
                </Row>

                <Row
                    label="Permanent token"
                    hint="Stored encrypted and never shown again. Leave blank to keep the current one. Use a dedicated service account, not a personal token."
                >
                    <input
                        type="password"
                        value={ytToken}
                        onChange={e => setYtToken(e.target.value)}
                        placeholder={yt?.configured ? '••••••••  (unchanged)' : 'perm:...'}
                        className="px-2 py-1.5 rounded border text-sm"
                        style={inputStyle}
                    />
                </Row>

                <Row label="Default project" hint="Where new issues are filed, and what search is scoped to.">
                    <select
                        value={ytProject}
                        onChange={e => setYtProject(e.target.value)}
                        className="px-2 py-1.5 rounded border text-sm"
                        style={inputStyle}
                    >
                        <option value="">Choose a project…</option>
                        {(yt?.projects || []).map(p => (
                            <option key={p.id} value={p.shortName}>{p.name} ({p.shortName})</option>
                        ))}
                    </select>
                </Row>

                <div>
                    <button
                        onClick={saveYt}
                        disabled={ytSaving}
                        className="px-3 py-1.5 rounded text-sm font-medium disabled:opacity-60"
                        style={{ background: 'var(--accent-primary)', color: 'white' }}
                    >
                        {ytSaving ? 'Saving…' : 'Save connection'}
                    </button>
                </div>
            </section>

            {/* ── What may leave ───────────────────────────────────────── */}
            <section className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>What leaves Bee Flow</h3>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    YouTrack and chat receive a ticket reference and a link only staff can open. The
                    customer&apos;s name, email address and organisation never leave, and an issue
                    description that contains them is refused. Email is the exception — there the
                    customer&apos;s address is how the reply reaches them.
                </p>
                <label className="flex items-start gap-2 text-xs cursor-pointer">
                    <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={includeSubject}
                        onChange={e => { setIncludeSubject(e.target.checked); saveYt({ subject: e.target.checked }); }}
                    />
                    <span style={{ color: 'var(--text-secondary)' }}>
                        <strong>Also send the ticket subject.</strong> Off by default — a subject line
                        often carries a name (&ldquo;Re: invoice for J. de Vries&rdquo;). When on, the
                        subject is still checked for personal data before it is sent.
                    </span>
                </label>
            </section>

            {/* ── Chat notifications ───────────────────────────────────── */}
            <section className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Tell the team in chat</h3>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    A short card in your team space when something needs attention, with a link into
                    this inbox. At most one message per ticket every ten minutes, so a long email
                    thread doesn&apos;t flood the channel.
                </p>

                {chat?.configured && (
                    <Banner tone={chat.enabled ? 'ok' : 'warn'}>
                        Webhook saved for {chat.host}. Notifications are {chat.enabled ? 'on' : 'off'}.
                    </Banner>
                )}
                {chatError && <Banner tone="bad">{chatError}</Banner>}
                {testResult?.ok && <Banner tone="ok">Test card delivered. Check the space.</Banner>}
                {testResult && !testResult.ok && <Banner tone="bad">{testResult.error}</Banner>}

                <Row label="Where to send it">
                    <select
                        value={chat?.provider || 'google_chat'}
                        onChange={e => saveChat({ provider: e.target.value })}
                        className="px-2 py-1.5 rounded border text-sm"
                        style={inputStyle}
                    >
                        {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                </Row>

                <Row
                    label="Webhook URL"
                    hint="Treated as a credential — it is stored encrypted and never shown again. Leave blank to keep the current one."
                >
                    <input
                        type="password"
                        value={hook}
                        onChange={e => setHook(e.target.value)}
                        placeholder={chat?.configured ? '••••••••  (unchanged)' : 'https://chat.googleapis.com/v1/spaces/…'}
                        className="px-2 py-1.5 rounded border text-sm"
                        style={inputStyle}
                    />
                </Row>

                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Send a message when</span>
                    {(chat?.availableEvents || []).map(id => (
                        <label key={id} className="flex items-center gap-2 text-xs cursor-pointer">
                            <input
                                type="checkbox"
                                checked={chat?.events?.includes(id) || false}
                                onChange={() => toggleEvent(id)}
                            />
                            <span style={{ color: 'var(--text-secondary)' }}>{EVENT_LABELS[id] || id}</span>
                        </label>
                    ))}
                </div>

                <div className="flex items-center gap-2">
                    <button
                        onClick={() => saveChat({ enabled: !chat?.enabled })}
                        disabled={chatSaving || (!chat?.configured && !hook.trim())}
                        className="px-3 py-1.5 rounded text-sm font-medium disabled:opacity-60"
                        style={{ background: 'var(--accent-primary)', color: 'white' }}
                    >
                        {chatSaving ? 'Saving…' : chat?.enabled ? 'Turn notifications off' : 'Turn notifications on'}
                    </button>
                    <button
                        onClick={test}
                        disabled={!chat?.configured}
                        className="px-3 py-1.5 rounded text-sm border flex items-center gap-1.5 disabled:opacity-50"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                    >
                        <Send className="w-3.5 h-3.5" /> Send a test
                    </button>
                </div>
            </section>
        </div>
    );
}
