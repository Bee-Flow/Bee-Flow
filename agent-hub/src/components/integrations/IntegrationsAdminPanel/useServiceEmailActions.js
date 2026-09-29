// Service Email (Gmail API via OAuth) actions of the IntegrationsAdminPanel —
// connect popup, disconnect and display-name save, moved verbatim from
// IntegrationsAdminPanel.jsx.
import { API_BASE, authFetch } from '../../../utils/helpers';

export default function useServiceEmailActions({
    setConnectingServiceEmail, setHasServiceEmail, setServiceEmailAddress, load,
    setSavingServiceEmail, setShowTestEmail, serviceEmailDisplayName,
    setMessage,
}) {
    // ── Service Email (Gmail API via OAuth) ──────────────────────────────────
    // Opens Google consent in a popup; the server callback posts a
    // `service-email-oauth` message back when the account is connected.
    const startServiceEmailConnect = async () => {
        setConnectingServiceEmail(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/service-email/oauth/start`);
            const data = await res.json();
            if (!res.ok || !data.url) {
                setMessage({ type: 'error', text: data.error || 'Could not start Google connect' });
                setConnectingServiceEmail(false);
                setTimeout(() => setMessage(null), 4000);
                return;
            }
            const popup = window.open(data.url, 'service-email-oauth', 'width=520,height=660');
            // window.open returns null when the browser blocks the popup — it
            // does not throw, so without this guard the code below installed a
            // `message` listener and an 800ms interval whose only exit is
            // `popup && popup.closed`, unreachable for a null popup. Both then
            // ran for the life of the tab, and — worse for the admin — the
            // spinner never cleared, leaving a permanently disabled "Connect
            // Google account" button with no hint as to why. Same guard, and
            // the same wording, as the shared lib/googleOAuthPopup helper
            // (this flow can't use it: it has its own oauth/start endpoint and
            // its own `service-email-oauth` callback message).
            if (!popup) {
                setConnectingServiceEmail(false);
                setMessage({
                    type: 'error',
                    text: 'The Google sign-in popup was blocked — allow popups for this site and try again.',
                });
                setTimeout(() => setMessage(null), 6000);
                return;
            }
            const onMsg = (ev) => {
                if (!ev.data || ev.data.type !== 'service-email-oauth') return;
                window.removeEventListener('message', onMsg);
                clearInterval(timer);
                setConnectingServiceEmail(false);
                if (ev.data.ok) {
                    setHasServiceEmail(true);
                    if (ev.data.message) setServiceEmailAddress(ev.data.message);
                    setMessage({ type: 'success', text: `Connected ${ev.data.message || 'Google account'}` });
                    load();
                } else {
                    setMessage({ type: 'error', text: ev.data.message || 'Connection failed' });
                }
                setTimeout(() => setMessage(null), 4000);
            };
            window.addEventListener('message', onMsg);
            // Fallback: clear the spinner if the popup is closed without a message.
            const timer = setInterval(() => {
                if (popup.closed) {
                    clearInterval(timer);
                    window.removeEventListener('message', onMsg);
                    setConnectingServiceEmail(false);
                }
            }, 800);
        } catch (e) {
            setConnectingServiceEmail(false);
            setMessage({ type: 'error', text: 'Could not start Google connect' });
            setTimeout(() => setMessage(null), 4000);
        }
    };

    const disconnectServiceEmail = async () => {
        setSavingServiceEmail(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/service-email/disconnect`, { method: 'POST' });
            if (res.ok) {
                setHasServiceEmail(false);
                setServiceEmailAddress('');
                setShowTestEmail(false);
                setMessage({ type: 'success', text: 'Service email disconnected' });
            } else {
                setMessage({ type: 'error', text: 'Failed to disconnect' });
            }
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to disconnect' });
        }
        setSavingServiceEmail(false);
        setTimeout(() => setMessage(null), 3000);
    };

    const saveServiceEmailDisplayName = async () => {
        setSavingServiceEmail(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serviceEmailDisplayName }),
            });
            setMessage(res.ok
                ? { type: 'success', text: 'Display name saved' }
                : { type: 'error', text: 'Failed to save display name' });
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to save display name' });
        }
        setSavingServiceEmail(false);
        setTimeout(() => setMessage(null), 3000);
    };

    return { startServiceEmailConnect, disconnectServiceEmail, saveServiceEmailDisplayName };
}
