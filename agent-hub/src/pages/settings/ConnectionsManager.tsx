import { Plus, Loader2 } from 'lucide-react';
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { authFetch } from '../../utils/helpers';
import { HTTP_AUTH_TYPES, splitHttpAuthValues, missingHttpAuthFields, type HttpAuthType } from '../../utils/httpCredentialTypes';
import type { ProviderField, ConnectionSecretMeta, Connection, Grant, GroupLabelProps, AddConnectionFormProps } from './ConnectionsManager.types';
import { BASE, PROVIDERS, PROVIDER_BY_ID, inputStyle, inputCls, errorFrom } from './ConnectionsManager.helpers';
import { ErrorLine, ConnectionRow } from './ConnectionRow';

const GroupLabel = ({ children }: GroupLabelProps) => (
    <p className="text-[11px] font-semibold uppercase tracking-widest px-1 mb-2 text-[var(--text-muted)]">{children}</p>
);

// ── Add-connection inline form ──────────────────────────────────────
const AddConnectionForm = ({ onAdded }: AddConnectionFormProps) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [providerId, setProviderId] = useState(PROVIDERS[0].id);
    const [authTypeId, setAuthTypeId] = useState(HTTP_AUTH_TYPES[0].id);
    const [label, setLabel] = useState('');
    const [fields, setFields] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const provider = PROVIDER_BY_ID[providerId];
    // Providers with per-auth-type field specs (http): the chosen auth type
    // supplies kind + fields; classic providers keep their static spec.
    const authType = provider.authTypes
        ? (provider.authTypes.find(t2 => t2.id === authTypeId) || provider.authTypes[0])
        : null;
    const activeFields = authType ? authType.fields : provider.fields;
    const reset = () => { setLabel(''); setFields({}); setErr(null); };

    const submit = async () => {
        let secret: Record<string, string> = {};
        let secretMeta: Record<string, string> | null = null;
        if (authType) {
            if (missingHttpAuthFields(authType, fields).length > 0) {
                setErr(t('connections.fill_required', 'Fill in all required fields'));
                return;
            }
            const split = splitHttpAuthValues(authType, fields);
            secret = split.secret;
            if (Object.keys(split.secretMeta).length > 0) secretMeta = split.secretMeta;
        } else {
            for (const f of provider.fields as ProviderField[]) { if (fields[f.key]) secret[f.key] = fields[f.key]; }
            if (Object.keys(secret).length === 0) {
                setErr(t('connections.fill_credentials', 'Fill in the credential fields'));
                return;
            }
        }
        setBusy(true); setErr(null);
        try {
            const res = await authFetch(BASE, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: providerId,
                    kind: authType ? authType.kind : provider.kind,
                    label: label.trim() || (authType ? `${provider.name} — ${t(authType.nameKey, authType.name)}` : provider.name),
                    secret,
                    ...(secretMeta ? { secretMeta } : {}),
                }),
            });
            if (!res.ok) {
                setErr(await errorFrom(res, t('connections.create_failed', 'Could not create')));
                // Drop the typed secrets even on failure — leaving them in
                // component state keeps them in the DOM indefinitely.
                setFields({});
            } else { reset(); setOpen(false); onAdded(); }
        } catch (e) { setErr((e as Error).message); setFields({}); }
        setBusy(false);
    };

    if (!open) {
        return (
            <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-2 text-[var(--accent-primary)]">
                <Plus size={14} /> {t('connections.add', 'Add a connection')}
            </button>
        );
    }
    return (
        <div className="p-3 space-y-2.5 [border-top:1px_solid_var(--border-subtle)]">
            <div className="flex gap-2">
                <select
                    value={providerId} onChange={e => { setProviderId(e.target.value); setFields({}); }}
                    aria-label={t('connections.provider_label', 'Provider')}
                    className={inputCls} style={inputStyle}
                >
                    {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input
                    value={label} onChange={e => setLabel(e.target.value)}
                    placeholder={t('connections.name_placeholder', 'Name (e.g. "{provider} – Work")', { provider: provider.name })}
                    aria-label={t('connections.name_label', 'Connection name')}
                    className={`flex-1 ${inputCls}`} style={inputStyle}
                />
            </div>
            {provider.authTypes && (
                <select
                    aria-label={t('connections.auth_type_label', 'Auth type')} value={(authType as HttpAuthType).id}
                    onChange={e => { setAuthTypeId(e.target.value); setFields({}); }}
                    className={`w-full ${inputCls}`} style={inputStyle}
                >
                    {provider.authTypes.map(at => <option key={at.id} value={at.id}>{t(at.nameKey, at.name)}</option>)}
                </select>
            )}
            {(activeFields as ProviderField[]).map(f => (
                <input
                    key={f.key} type={f.type} value={fields[f.key] || ''}
                    onChange={e => setFields(s => ({ ...s, [f.key]: e.target.value }))}
                    placeholder={t(f.labelKey, f.label)} aria-label={t(f.labelKey, f.label)}
                    autoComplete="off" className={`w-full ${inputCls}`} style={inputStyle}
                />
            ))}
            {err && <ErrorLine>{err}</ErrorLine>}
            <div className="flex gap-2">
                <button onClick={submit} disabled={busy} className="px-4 py-2 rounded-lg text-[13px] font-medium text-white disabled:opacity-40 bg-[var(--accent-primary)]">
                    {busy ? <Loader2 size={14} className="animate-spin" /> : t('connections.create', 'Create connection')}
                </button>
                <button onClick={() => { reset(); setOpen(false); }} className="px-4 py-2 rounded-lg text-[13px] [background:var(--bg-primary)] [color:var(--text-muted)]! [border:1px_solid_var(--border-default)]">
                    {t('connections.cancel', 'Cancel')}
                </button>
            </div>
        </div>
    );
};

// ── Manager ─────────────────────────────────────────────────────────
const ConnectionsManager = () => {
    const { t } = useTranslation();
    const [connections, setConnections] = useState<Connection[]>([]);
    const [grants, setGrants] = useState<Grant[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoadError(null);
        try {
            const [cRes, gRes] = await Promise.all([
                authFetch(BASE),
                authFetch(`${BASE}/grants?mine=outgoing`),
            ]);
            // A failed list used to render as "No named connections yet.",
            // which reads as "your credentials are gone".
            if (!cRes.ok) throw new Error(await errorFrom(cRes, t('connections.load_failed', 'Could not load your connections')));
            const c = await cRes.json();
            const g = gRes.ok ? await gRes.json() : { grants: [] };
            setConnections(c.connections || []);
            setGrants(g.grants || []);
        } catch (e) {
            console.error('[ConnectionsManager]', e);
            setLoadError((e as Error).message || t('connections.load_failed', 'Could not load your connections'));
        }
        setLoading(false);
    }, [t]);

    useEffect(() => { load(); }, [load]);

    // Group connections by provider for display.
    const byProvider: Record<string, Connection[]> = {};
    for (const c of connections) (byProvider[c.provider] ||= []).push(c);

    return (
        <div className="space-y-1.5">
            <GroupLabel>{t('connections.title', 'Named connections')}</GroupLabel>
            <p className="text-[11px] px-1 -mt-1 mb-1 text-[var(--text-muted)]">
                {t('connections.description', 'Keep multiple named credentials per integration and lend a specific one to teammates. Recipients without a lent connection bring their own.')}
            </p>
            <div className="rounded-xl overflow-hidden [border:1px_solid_var(--border-subtle)]">
                {loading ? (
                    <div className="px-4 py-6 flex items-center gap-2 text-[13px] bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                        <Loader2 size={14} className="animate-spin" /> {t('connections.loading', 'Loading…')}
                    </div>
                ) : (
                    <div className="bg-[var(--bg-secondary)]">
                        {loadError ? (
                            <div className="px-4 py-4">
                                <ErrorLine>{loadError}</ErrorLine>
                                <button onClick={() => { setLoading(true); load(); }} className="text-[12px] underline mt-1 text-[var(--accent-primary)]">
                                    {t('connections.retry', 'Try again')}
                                </button>
                            </div>
                        ) : (
                            <>
                                {Object.keys(byProvider).length === 0 && (
                                    <p className="px-4 py-4 text-[12px] text-[var(--text-muted)]">
                                        {t('connections.empty', 'No named connections yet.')}
                                    </p>
                                )}
                                {Object.entries(byProvider).map(([provider, conns]) => (
                                    <div key={provider} className="[border-bottom:1px_solid_var(--border-subtle)]">
                                        <div className="px-3 pt-2.5 pb-1 text-[12px] font-semibold text-[var(--text-primary)]">
                                            {PROVIDER_BY_ID[provider]?.name || provider}
                                        </div>
                                        {conns.map(c => <ConnectionRow key={c.id} connection={c} grants={grants} onChanged={load} />)}
                                    </div>
                                ))}
                                <AddConnectionForm onAdded={load} />
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default ConnectionsManager;
