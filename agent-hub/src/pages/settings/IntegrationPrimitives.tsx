import { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import type { IntegrationRowProps, ApiKeyFieldProps, DisconnectButtonProps } from './IntegrationsSection.types';

// ── Shared UI helpers ─────────────────────────────────────────────────────────
// Pull translations from the hook directly so parents don't have to thread `t`
// through. Historically callers forgot to pass t={t}, causing render-time
// crashes ("TypeError: t is not a function") the moment an integration was
// connected and this badge actually rendered.
const ConnectedBadge = () => {
    const { t } = useTranslation();
    return (
        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 [background:rgba(5,150,105,0.1)] [color:#059669]!">
            {t('settings.connected')}
        </span>
    );
};

// ── Integration row (expands inline) ─────────────────────────────────────────
// Shared by every row of Settings → Connections (IntegrationsSection,
// SimpleApiKeyIntegration, the OAuth cards, Microsoft 365, Scaleway billing).
export const IntegrationRow = ({ icon, name, description, connected, badge, children, last = false }: IntegrationRowProps) => {
    const [expanded, setExpanded] = useState(false);

    return (
        <div data-tour="integration-card" className={`${last ? '[border-bottom:none]' : '[border-bottom:1px_solid_var(--border-subtle)]'}`}>
            <button
                type="button"
                aria-expanded={expanded}
                className="w-full flex items-center gap-3 px-5 py-3.5 text-left transition-colors bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]"
                onClick={() => setExpanded(v => !v)}
            >
                <div className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {icon}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-[var(--text-primary)]">{name}</p>
                    <p className="text-[11px] truncate text-[var(--text-muted)]">{description}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    {/* An explicit badge renders alongside Connected (e.g. "Update
                        needed" when a connected integration needs re-consent). */}
                    {connected ? <>{badge || null}<ConnectedBadge /></> : badge || null}
                    <svg
                        className={`transition-transform [color:var(--text-muted)] [width:13px] [height:13px] ${expanded ? '[transform:rotate(90deg)]' : '[transform:none]'}`}
                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                </div>
            </button>

            {expanded && (
                <div className="px-5 pb-4 pt-2 space-y-3 [background:var(--bg-secondary)] [border-top:1px_solid_var(--border-subtle)]">
                    {children}
                </div>
            )}
        </div>
    );
};
// ── Field helpers ─────────────────────────────────────────────────────────────
// The Save / Disconnect labels come from the hook, not from a `t` prop: most
// rows never passed one, so their button read "Save" in every language.
export const ApiKeyField = ({ placeholder, value, onChange, onSave, saving, hint, canSave }: ApiKeyFieldProps) => {
    const { t } = useTranslation();
    return (
        <div>
            <div className="flex gap-2">
                <input
                    type="password"
                    value={value}
                    onChange={onChange}
                    placeholder={placeholder}
                    aria-label={placeholder}
                    // These are API tokens, not account passwords — without this the
                    // browser's password manager offers to save them.
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    className="flex-1 px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors [background:var(--bg-primary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!"
                    onKeyDown={e => e.key === 'Enter' && (canSave ?? value.trim()) && onSave()}
                />
                <button
                    type="button"
                    onClick={onSave}
                    disabled={saving || !(canSave ?? value.trim())}
                    className="px-4 py-2 rounded-lg text-[13px] font-medium text-white disabled:opacity-40 transition-opacity bg-[var(--accent-primary)]"
                >
                    {saving ? '…' : t('settings.save', 'Save')}
                </button>
            </div>
            {hint && <p className="text-[11px] mt-1.5 text-[var(--text-muted)]">{hint}</p>}
        </div>
    );
};

export const DisconnectButton = ({ onDisconnect, disconnecting }: DisconnectButtonProps) => {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onDisconnect}
            disabled={disconnecting}
            className="px-4 py-2 rounded-lg text-[13px] font-medium transition-opacity disabled:opacity-50 [background:var(--bg-primary)] [color:var(--text-muted)]! [border:1px_solid_var(--border-default)]"
        >
            {disconnecting ? '…' : t('settings.disconnect', 'Disconnect')}
        </button>
    );
};
