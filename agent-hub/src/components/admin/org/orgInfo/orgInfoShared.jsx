import { CreditCard, KeyRound, Shield, Lock, Brain, DatabaseZap, Info, Globe, X, Plus } from 'lucide-react';
import { useState, useRef } from 'react';

// Map a 3-letter currency code to its glyph for inline display.
const currencySym = (c) => ({ EUR: '€', USD: '$', GBP: '£' }[String(c || 'EUR').toUpperCase()] || (c || '€'));

// Labelled form field wrapper. Defined at module scope (not inside the panel's
// render) so its component identity is stable across renders — otherwise React
// remounts the wrapped input on every keystroke and the field loses focus.
const Field = ({ label, hint, children }) => (
    <div>
        <label className="block text-sm font-medium mb-1.5 text-[var(--text-primary)]">{label}</label>
        {hint && <p className="text-[11px] text-[var(--text-muted)] mb-1.5">{hint}</p>}
        {children}
    </div>
);

// Skeleton loader
const Skeleton = () => (
    <div className="flex h-full animate-pulse">
        <div className="w-56 p-4 border-r border-[var(--border-subtle)] space-y-3">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-10 rounded-lg bg-[var(--bg-tertiary)]" />)}
        </div>
        <div className="flex-1 p-8 space-y-5">
            <div className="h-6 w-40 bg-[var(--bg-tertiary)] rounded-lg" />
            {[1, 2, 3].map(i => (
                <div key={i} className="space-y-1.5">
                    <div className="h-4 w-24 bg-[var(--bg-tertiary)] rounded" />
                    <div className="h-10 w-full bg-[var(--bg-tertiary)] rounded-xl" />
                </div>
            ))}
        </div>
    </div>
);

const AUTH_METHODS = [
    {
        id: 'password',
        nameKey: 'org.password_auth',
        descKey: 'org.password_auth_desc',
        icon: (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
        ),
        color: '#3b82f6',
    },
    {
        id: 'google',
        nameKey: 'org.google_auth',
        descKey: 'org.google_auth_desc',
        icon: (
            <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
        ),
        color: '#4285F4',
    },
    {
        id: 'microsoft',
        nameKey: 'org.microsoft_auth',
        descKey: 'org.microsoft_auth_desc',
        icon: (
            <svg className="w-5 h-5" viewBox="0 0 24 24">
                <rect x="1" y="1" width="10" height="10" fill="#F25022" />
                <rect x="13" y="1" width="10" height="10" fill="#7FBA00" />
                <rect x="1" y="13" width="10" height="10" fill="#00A4EF" />
                <rect x="13" y="13" width="10" height="10" fill="#FFB900" />
            </svg>
        ),
        color: '#00A4EF',
    },
];

const SECTIONS = [
    { id: 'license', labelKey: 'settings.license_usage', icon: CreditCard, color: '#3b82f6' },
    { id: 'auth', labelKey: 'settings.signin_method', icon: KeyRound, color: '#10b981' },
    { id: 'privacy', labelKey: 'settings.privacy_shield', icon: Shield, color: '#ef4444' },
    { id: 'encryption', labelKey: 'settings.encryption', icon: Lock, color: '#8b5cf6' },
    { id: 'ai_context', labelKey: 'settings.ai_context', icon: Brain, color: '#f59e0b' },
    { id: 'integration_cache', labelKey: 'settings.integration_cache', icon: DatabaseZap, color: '#06b6d4' },
    { id: 'info', labelKey: 'settings.org_info', icon: Info, color: '#14b8a6' },
];

// ── Allowed Domains editor (tag-input) ──
const AllowedDomainsEditor = ({ domains = [], onChange, t }) => {
    const [inputValue, setInputValue] = useState('');
    const [error, setError] = useState('');
    const inputRef = useRef(null);

    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;

    const addDomain = () => {
        const domain = inputValue.trim().toLowerCase();
        if (!domain) return;

        if (!domainRegex.test(domain)) {
            setError(`Invalid domain format: "${domain}"`);
            return;
        }
        if (domains.includes(domain)) {
            setError(`Domain "${domain}" is already added`);
            return;
        }

        setError('');
        onChange([...domains, domain]);
        setInputValue('');
        inputRef.current?.focus();
    };

    const removeDomain = (domainToRemove) => {
        onChange(domains.filter(d => d !== domainToRemove));
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addDomain();
        }
        if (e.key === 'Backspace' && !inputValue && domains.length > 0) {
            removeDomain(domains[domains.length - 1]);
        }
    };

    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 space-y-3">
            <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-[var(--accent-primary)]" />
                <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {t('org.allowed_domains', 'Allowed Domains')}
                </span>
            </div>
            <p className="text-xs text-[var(--text-muted)] ml-6">
                {t('org.allowed_domains_desc', 'Email domains that are allowed to join this organisation via SSO. Users with matching email domains will be automatically linked to this organisation.')}
            </p>

            {/* Domain tags */}
            <div
                className="flex flex-wrap gap-2 min-h-[38px] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3 py-2 cursor-text transition-colors focus-within:border-[var(--accent-primary)]"
                onClick={() => inputRef.current?.focus()}
            >
                {domains.map(domain => (
                    <span
                        key={domain}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-[var(--accent-primary)] text-white"
                    >
                        {domain}
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); removeDomain(domain); }}
                            className="ml-0.5 hover:bg-white/20 rounded-full p-0.5 transition-colors"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    </span>
                ))}
                <div className="flex items-center gap-1 flex-1 min-w-[120px]">
                    <input
                        ref={inputRef}
                        type="text"
                        value={inputValue}
                        onChange={(e) => { setInputValue(e.target.value); setError(''); }}
                        onKeyDown={handleKeyDown}
                        placeholder={domains.length === 0 ? 'company.com' : 'Add domain...'}
                        className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none min-w-0"
                    />
                    {inputValue && (
                        <button
                            type="button"
                            onClick={addDomain}
                            className="p-1 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--accent-primary)] transition-colors"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </div>

            {error && (
                <p className="text-xs text-red-400 ml-6">{error}</p>
            )}
        </div>
    );
};

// ── Usage bar component ──
const UsageBar = ({ label, icon: Icon, used, limit, unit, color = '#3b82f6', pctLabel, percentOnly = false }) => {
    const isUnlimited = limit === null || limit === undefined || limit === -1;
    const pct = isUnlimited ? 0 : limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const isWarning = pct >= 80 && pct < 95;
    const isCritical = pct >= 95;
    const barColor = isCritical ? '#ef4444' : isWarning ? '#f59e0b' : color;

    const formatValue = (val) => {
        if (val === null || val === undefined || val === -1) return '∞';
        if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
        if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
        return val.toLocaleString();
    };

    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                    <Icon className="w-3.5 h-3.5" style={{ color }} />
                    {label}
                </div>
                {!percentOnly && (
                    <span className="text-xs text-[var(--text-muted)]">
                        {formatValue(used)}{unit ? ` ${unit}` : ''} / {formatValue(limit)}{unit ? ` ${unit}` : ''}
                    </span>
                )}
            </div>
            <div className="h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                        width: isUnlimited ? '0%' : `${pct}%`,
                        background: isUnlimited ? 'transparent' : barColor,
                    }}
                />
            </div>
            {!isUnlimited && (
                <div className="flex justify-end">
                    <span className={`text-[10px] font-medium ${isCritical ? 'text-red-500' : isWarning ? 'text-amber-500' : 'text-[var(--text-muted)]'}`}>
                        {pctLabel || `${pct}% used`}
                    </span>
                </div>
            )}
        </div>
    );
};

export { currencySym, Field, Skeleton, AUTH_METHODS, SECTIONS, AllowedDomainsEditor, UsageBar };
