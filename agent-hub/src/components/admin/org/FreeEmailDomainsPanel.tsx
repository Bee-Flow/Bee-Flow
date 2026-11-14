import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { freeEmailDomainsKey, useFreeEmailDomains, type FreeEmailDomains } from '@/api/queries/orgAdminReads';
import type { KeyboardEvent } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { ALERT_ERROR, ALERT_SUCCESS, CHIP, PRIMARY_BTN, QUIET_BTN } from '@/components/mcpLibrary/ui';
import SectionHeader from '@/components/shared/SectionHeader';
import { FIELD_INPUT, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import Spinner from '@/components/shared/Spinner';
import { Loader2, Plus, Trash2, AtSign, ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { errorBody, RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

interface DomainMessage {
    type: 'success' | 'error';
    text: string;
}

/**
 * FreeEmailDomainsPanel — super-admin editor for the free/public email-provider
 * blocklist. Domains on this list can never auto-bind a user to an organisation
 * via email-domain matching (OAuth login, Nextcloud connector, password signup).
 *
 * The built-in floor (gmail.com, …) is shown read-only and can never be removed;
 * admins add extra domains, persisted via PUT /auth/free-email-domains.
 */
/** The error note of a failed first read, or none. */
function loadFailedNote(failed: boolean, text: string): DomainMessage | null {
    return failed ? { type: 'error', text } : null;
}

export default function FreeEmailDomainsPanel() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const { builtin, extra, loading, loadFailed } = useFreeEmailDomains();
    const [newDomain, setNewDomain] = useState('');
    const [saving, setSaving] = useState(false);
    const [actionMessage, setMessage] = useState<DomainMessage | null>(null);
    // A refused or failed read shows its note for as long as the read stays failed.
    const message = actionMessage ?? loadFailedNote(loadFailed, t('admin.fed_load_failed', 'Failed to load email domains'));
    const [showBuiltin, setShowBuiltin] = useState(false);

    // One pending clear at a time: the timer of an earlier note must not wipe a later one.
    const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const notify = (type: DomainMessage['type'], text: string) => {
        setMessage({ type, text });
        if (noteTimer.current) clearTimeout(noteTimer.current);
        noteTimer.current = setTimeout(() => { noteTimer.current = null; setMessage(null); }, 3000);
    };
    useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);


    // Persist a new extra list. Sends {extra} and adopts the server-normalised
    // list from the response so the UI reflects exactly what was stored.
    const persist = async (nextExtra: string[]) => {
        setSaving(true);
        try {
            const res = await apiRequest('PUT /auth/free-email-domains', { body: { extra: nextExtra } });
            const data = await res.json().catch(() => ({}));
            queryClient.setQueryData<FreeEmailDomains | null>(freeEmailDomainsKey, (prev) => ({ builtin: prev?.builtin ?? [], extra: Array.isArray(data.extra) ? data.extra : nextExtra }));
            notify('success', t('admin.fed_saved', 'Email-domain blocklist updated'));
            return true;
        } catch (err) {
            if (err instanceof RefusedError) {
                notify('error', (errorBody(err) ?? {}).error || t('admin.fed_save_failed', 'Failed to save'));
                return false;
            }
            notify('error', t('admin.fed_save_failed', 'Failed to save'));
            return false;
        } finally {
            setSaving(false);
        }
    };

    const addDomain = async () => {
        const raw = newDomain.trim().toLowerCase();
        if (!raw) return;
        // split() always returns ≥1 element, so pop() is a string.
        const domain = raw.includes('@') ? raw.split('@').pop() as string : raw;
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
            notify('error', t('admin.fed_invalid', 'Not a valid domain: "{domain}"').replace('{domain}', domain));
            return;
        }
        if (builtin.includes(domain)) {
            notify('error', t('admin.fed_builtin_dup', '"{domain}" is already a built-in domain').replace('{domain}', domain));
            return;
        }
        if (extra.includes(domain)) {
            notify('error', t('admin.fed_dup', '"{domain}" is already on the list').replace('{domain}', domain));
            return;
        }
        const ok = await persist([...extra, domain]);
        if (ok) setNewDomain('');
    };

    const removeDomain = async (domain: string) => {
        await persist(extra.filter(d => d !== domain));
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); addDomain(); }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 p-4 text-sm text-[var(--text-tertiary)]">
                <Spinner size="sm" />
                {t('admin.fed_loading', 'Loading email domains…')}
            </div>
        );
    }

    return (
        <div className="flex max-w-3xl flex-col gap-6">
            <SectionHeader
                title={t('admin.fed_title', 'Free email-provider domains')}
                description={t('admin.fed_desc', 'Users signing in with an address at one of these domains are never automatically added to an organisation by email-domain matching. This stops a shared consumer domain (like gmail.com) from binding a stranger into someone else’s workspace. The built-in list always applies; add any extra domains your organisation should also treat as public.')}
            />
            {message && (
                <div role="status" className={message.type === 'success' ? ALERT_SUCCESS : ALERT_ERROR}>{message.text}</div>
            )}

            <SettingsGroup title={<>{t('admin.fed_custom', 'Custom domains')} ({extra.length})</>}>
                <SettingsList>
                    <div className="flex gap-2 px-4 py-3">
                        <input
                            type="text"
                            value={newDomain}
                            onChange={(e) => setNewDomain(e.target.value)}
                            onKeyDown={onKeyDown}
                            placeholder={t('admin.fed_placeholder', 'e.g. proton.me or someone@proton.me')}
                            disabled={saving}
                            className={FIELD_INPUT}
                        />
                        <button type="button" onClick={addDomain} disabled={saving || !newDomain.trim()} className={`${PRIMARY_BTN} shrink-0`}>
                            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                            {t('admin.fed_add', 'Add')}
                        </button>
                    </div>
                    <div className="px-4 py-3">
                        {extra.length === 0 ? (
                            <p className="m-0 text-xs text-[var(--text-tertiary)]">{t('admin.fed_none', 'No custom domains added.')}</p>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {extra.map(domain => (
                                    <span key={domain} className={`${CHIP} text-[var(--text-primary)]`}>
                                        <AtSign className="h-3 w-3 text-[var(--text-tertiary)]" aria-hidden="true" />
                                        {domain}
                                        <button
                                            type="button"
                                            onClick={() => removeDomain(domain)}
                                            disabled={saving}
                                            title={t('admin.fed_remove', 'Remove')}
                                            aria-label={`${t('admin.fed_remove', 'Remove')} ${domain}`}
                                            className="ml-0.5 inline-flex text-[var(--text-tertiary)] hover:text-[var(--error-ink)] disabled:opacity-50"
                                        >
                                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </SettingsList>
            </SettingsGroup>

            <section className="flex flex-col gap-2">
                <button type="button" onClick={() => setShowBuiltin(v => !v)} aria-expanded={showBuiltin} className={`${QUIET_BTN} self-start`}>
                    {showBuiltin ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('admin.fed_builtin', 'Built-in domains')} ({builtin.length})
                </button>
                {showBuiltin && (
                    <div className="flex flex-wrap gap-1.5">
                        {builtin.map(domain => <span key={domain} className={CHIP}>{domain}</span>)}
                    </div>
                )}
            </section>
        </div>
    );
}
