import { Shield, Globe, Search, Save, Check, ScanEye, Eye } from 'lucide-react';
import React, { useState, useEffect, useMemo } from 'react';
import PiiActionPicker from '../../components/privacy/PiiActionPicker';
import PiiCategoryGrid from '../../components/privacy/PiiCategoryGrid';
import PiiSensitivityPicker from '../../components/privacy/PiiSensitivityPicker';
import Toggle from '../../components/shared/Toggle';
import { piiCategoriesLocalized } from '../../config/piiCategories';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';
import { mutate, ApiError } from '../../api/mutate';

/** The user's own Privacy Shield config (GET /api/org-privacy-shield/user/me). */
interface ConsumerShieldConfig {
    enabled: boolean;
    euModeEnabled: boolean;
    disableSearchOnUpload: boolean;
    piiDetectionEnabled: boolean;
    piiDetectionCategories: string[];
    piiDetectionConfidenceThreshold: number;
    piiDetectionAction: string;
    piiFailureMode: string;
    showRawPayload: boolean;
}

/** GET /api/org-privacy-shield/user/guard-status. */
interface GuardStatus {
    configured?: boolean;
    reachable?: boolean;
}

/**
 * Consumer Privacy Shield section.
 * User-level privacy controls for consumer accounts (no org). Mirrors the
 * organisation Privacyschild panel but scoped to a single user:
 *   - EU Data Residency
 *   - Disable Search on File Upload
 *   - PII Detection (categories, confidence threshold, action)
 *   - Show raw payload & token mapping (transparency)
 */
const ConsumerPrivacySection = () => {
    const { t } = useTranslation();
    // Full canonical category list, localised. We surface every category
    // here regardless of detector coverage: the on-server PII Guard
    // (GLiNER + regex tier) is the single backend and covers most of them.
    // Unchecked categories are filtered server-side, so listing all of
    // them is safe — at worst a checked-but-unsupported category yields
    // zero hits.
    const PII_CATEGORIES = useMemo(() => piiCategoriesLocalized(t), [t]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    // A refused or failed save used to leave the button as it was, which read
    // as "saved"; now the failure is said next to the button.
    const [saveError, setSaveError] = useState(false);
    // Whether the values shown are the secure defaults in force rather than a
    // saved choice (BFSF-289) — the panel labels them so "on" isn't mistaken
    // for something the user configured.
    const [implicitDefault, setImplicitDefault] = useState(false);
    // null = still probing. Tells the user whether PII detection can actually
    // run; without it "shield on, guard not installed" looked identical to
    // "shield on and working" while detection silently failed open.
    const [guardStatus, setGuardStatus] = useState<GuardStatus | null>(null);
    const [config, setConfig] = useState<ConsumerShieldConfig>({
        // Secure by default — mirrors server/core/userShieldDefaults.js.
        enabled: true,
        euModeEnabled: false,
        disableSearchOnUpload: false,
        piiDetectionEnabled: true,
        piiDetectionCategories: [],
        piiDetectionConfidenceThreshold: 0.7,
        piiDetectionAction: 'tokenize',
        // Fail closed by default: if detection is unavailable, don't send
        // unmasked text to the AI (BFSF-269).
        piiFailureMode: 'fail_closed',
        showRawPayload: false,
    });

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/org-privacy-shield/user/me`);
                if (res.ok) {
                    const { implicitDefault: isImplicit, ...data } = await res.json();
                    setConfig(prev => ({ ...prev, ...data }));
                    setImplicitDefault(!!isImplicit);
                }
            } catch (e) {
                console.error('[ConsumerPrivacy] fetch error:', e);
            } finally {
                setLoading(false);
            }
        };
        const fetchGuardStatus = async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/org-privacy-shield/user/guard-status`);
                if (res.ok) setGuardStatus(await res.json());
            } catch (e) {
                console.error('[ConsumerPrivacy] guard-status error:', e);
            }
        };
        fetchConfig();
        fetchGuardStatus();
    }, []);

    const handleSave = async () => {
        setSaving(true);
        setSaved(false);
        setSaveError(false);
        try {
            const res = await mutate(`${API_BASE}/api/org-privacy-shield/user/me`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                setSaved(true);
                setImplicitDefault(false); // now an explicit, stored choice
                setTimeout(() => setSaved(false), 3000);
            } else {
                setSaveError(true);
            }
        } catch (e) {
            console.error('[ConsumerPrivacy] save error:', e);
            setSaveError(true);
        } finally {
            setSaving(false);
        }
    };

    const update = <K extends keyof ConsumerShieldConfig>(key: K, value: ConsumerShieldConfig[K]) => {
        setConfig(prev => ({ ...prev, [key]: value }));
    };

    if (loading) return (
        <div className="space-y-6 animate-pulse">
            <div className="h-6 w-48 bg-[var(--bg-tertiary)] rounded-lg" />
            <div className="h-40 bg-[var(--bg-tertiary)] rounded-2xl" />
        </div>
    );

    return (
        <div className="space-y-6 animate-fadeIn">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                        {t('settings.privacy_shield', 'Privacy Shield')}
                    </h2>
                    <p className="text-sm text-[var(--text-muted)] mt-1">
                        {t('settings.consumer_privacy.subtitle', 'Control data privacy and model routing for your account')}
                    </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                    {saveError && (
                        <span role="alert" className="text-xs font-medium text-[var(--error-ink)]">
                            {t('common.save_failed', 'Save failed')}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-white disabled:opacity-50 transition-all hover:opacity-90"
                        style={{ background: saved ? '#10b981' : 'var(--accent-primary)' }}
                    >
                        {saving ? (
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                        ) : saved ? (
                            <Check className="w-4 h-4" />
                        ) : (
                            <Save className="w-4 h-4" />
                        )}
                        {saving ? t('common.saving', 'Saving…') : saved ? t('common.saved', 'Saved') : t('common.save', 'Save')}
                    </button>
                </div>
            </div>

            {/* Guard availability — an enabled shield with no guard service
                detects nothing, and used to say so nowhere at all. */}
            {config.enabled && guardStatus && !(guardStatus.configured && guardStatus.reachable) && (
                <div className="flex items-start gap-3 p-4 rounded-2xl border bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] border-[color-mix(in_srgb,var(--warning)_35%,transparent)]">
                    <ScanEye className="w-5 h-5 shrink-0 mt-0.5 text-[var(--warning)]" />
                    <div>
                        <p className="text-sm font-semibold text-[var(--warning-ink)]">
                            {t('privacy.guard_status_unavailable', 'Personal-data check unavailable')}
                        </p>
                        <p className="text-xs mt-0.5 text-[var(--warning-ink)]">
                            {t('privacy.guard_status_unavailable_desc', 'The service that scans for personal data is not set up on this server. Your settings are saved, but nothing is being checked. Ask your administrator to switch it on.')}
                        </p>
                    </div>
                </div>
            )}

            {/* Master toggle + reveal */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
                <div className="flex items-center justify-between p-5">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center [background:linear-gradient(135deg,#ef4444,#f59e0b)]">
                            <Shield className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <p className="text-sm font-semibold text-[var(--text-primary)]">{t('settings.consumer_privacy.enable', 'Enable Privacy Shield')}</p>
                                {implicitDefault && config.enabled && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success-ink)]">
                                        {t('privacy.implicit_default_badge', 'On by default')}
                                    </span>
                                )}
                            </div>
                            <p className="text-xs text-[var(--text-muted)]">
                                {implicitDefault && config.enabled
                                    ? t('privacy.implicit_default_note', 'These settings are already in force with the secure defaults. Save to make them your own.')
                                    : t('settings.consumer_privacy.enable_desc', 'Activate privacy controls for your account')}
                            </p>
                        </div>
                    </div>
                    <Toggle
                        checked={!!config.enabled}
                        onChange={v => update('enabled', v)}
                        color="emerald"
                        className="shrink-0"
                        ariaLabel={t('settings.consumer_privacy.enable', 'Enable Privacy Shield')}
                    />
                </div>

                {config.enabled && (
                    <div className="border-t border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                        {/* EU Mode */}
                        <div className="flex items-center justify-between p-5">
                            <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--bg-tertiary)]">
                                    <Globe className="w-4 h-4 text-blue-500" />
                                </div>
                                <div>
                                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('settings.consumer_privacy.eu_title', 'EU Data Residency')}</p>
                                    <p className="text-xs text-[var(--text-muted)]">
                                        {t('settings.consumer_privacy.eu_desc', 'Route all AI requests through EU-based model endpoints only')}
                                    </p>
                                </div>
                            </div>
                            <Toggle
                                checked={!!config.euModeEnabled}
                                onChange={v => update('euModeEnabled', v)}
                                color="sky"
                                className="shrink-0"
                                ariaLabel={t('settings.consumer_privacy.eu_title', 'EU Data Residency')}
                            />
                        </div>

                        {/* Disable Search on Upload */}
                        <div className="flex items-center justify-between p-5">
                            <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--bg-tertiary)]">
                                    <Search className="w-4 h-4 text-amber-500" />
                                </div>
                                <div>
                                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('settings.consumer_privacy.search_title', 'Disable Search on File Upload')}</p>
                                    <p className="text-xs text-[var(--text-muted)]">
                                        {t('settings.consumer_privacy.search_desc', 'Prevent web searches when files are attached to conversations')}
                                    </p>
                                </div>
                            </div>
                            <Toggle
                                checked={!!config.disableSearchOnUpload}
                                onChange={v => update('disableSearchOnUpload', v)}
                                color="amber"
                                className="shrink-0"
                                ariaLabel={t('settings.consumer_privacy.search_title', 'Disable Search on File Upload')}
                            />
                        </div>

                        {/* PII Detection toggle */}
                        <div className="flex items-center justify-between p-5">
                            <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--bg-tertiary)]">
                                    <ScanEye className="w-4 h-4 text-emerald-500" />
                                </div>
                                <div>
                                    <p className="text-sm font-medium text-[var(--text-primary)]">{t('settings.consumer_privacy.pii_title', 'Look for personal data')}</p>
                                    <p className="text-xs text-[var(--text-muted)]">
                                        {t('settings.consumer_privacy.pii_desc', 'Check your messages for personal details — names, email addresses, phone numbers, passwords — and hide them from the AI, or stop the message altogether')}
                                    </p>
                                </div>
                            </div>
                            <Toggle
                                checked={!!config.piiDetectionEnabled}
                                onChange={v => update('piiDetectionEnabled', v)}
                                color="emerald"
                                className="shrink-0"
                                ariaLabel={t('settings.consumer_privacy.pii_title', 'Look for personal data')}
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* PII configuration — only when both Shield + PII are on */}
            {config.enabled && config.piiDetectionEnabled && (
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-4">
                    {/* Detection sensitivity — three named levels; the raw
                        threshold slider lives behind the picker's advanced fold. */}
                    <div>
                        <PiiSensitivityPicker
                            value={config.piiDetectionConfidenceThreshold || 0.7}
                            onChange={v => update('piiDetectionConfidenceThreshold', v)}
                        />
                        {config.piiDetectionConfidenceThreshold >= 0.85 && (
                            <div className="mt-3 flex items-start gap-2 text-[11px] px-3 py-2 rounded-lg border bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] border-[color-mix(in_srgb,var(--warning)_30%,transparent)] text-[var(--warning-ink)]">
                                <span>⚠️</span>
                                <span className="leading-relaxed">
                                    {t('settings.consumer_privacy.threshold_warning', 'At this level some personal data can slip through. Email addresses, phone numbers and bank account numbers are still recognised by their exact shape, but names and addresses depend on the detector.')}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Action picker */}
                    <PiiActionPicker
                        value={config.piiDetectionAction}
                        onChange={v => update('piiDetectionAction', v)}
                    />

                    {/* Failure policy is not exposed in the UI — it stays at its
                        safe server-side default (fail_closed) via config.piiFailureMode. */}

                    {/* Transparency toggle (only when tokenizing) */}
                    {config.piiDetectionAction === 'tokenize' && (
                        <div className="p-4 rounded-xl border bg-[var(--bg-tertiary)] border-[var(--border-subtle)]">
                            <label className="flex items-start gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={!!config.showRawPayload}
                                    onChange={e => update('showRawPayload', e.target.checked)}
                                    className="mt-0.5 w-4 h-4 rounded border-gray-600 bg-gray-700 text-[var(--accent-primary)] focus:ring-0"
                                />
                                <span className="flex-1">
                                    <span className="text-xs font-medium flex items-center gap-1.5 text-[var(--text-primary)]">
                                        <Eye className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                        {t('settings.consumer_privacy.raw_payload_title', 'Show me what was sent to the AI')}
                                    </span>
                                    <span className="text-[10px] block mt-1 leading-relaxed text-[var(--text-muted)]">
                                        {t('settings.consumer_privacy.raw_payload_desc', 'Adds a section to the “How I got this answer” panel showing your original message, the version that went to the AI, and which placeholder stood for which value. Only you can see it, in your own conversation.')}
                                    </span>
                                </span>
                            </label>
                        </div>
                    )}

                    {/* Categories */}
                    <PiiCategoryGrid
                        value={config.piiDetectionCategories}
                        onChange={v => update('piiDetectionCategories', v)}
                        categories={PII_CATEGORIES}
                    />
                </div>
            )}

            {/* Info Card */}
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5">
                <div className="flex gap-3">
                    <span className="text-lg">💡</span>
                    <div>
                        <p className="text-sm font-medium text-[var(--text-primary)] mb-1">{t('settings.consumer_privacy.about_title', 'About Privacy Shield')}</p>
                        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                            {t('settings.consumer_privacy.about_body', 'Privacy Shield gives you control over what happens to your data. With EU data residency on, every request to an AI model goes through European data centres only. The personal-data check reads your messages on this server and swaps sensitive details for placeholders — or stops the message — before it reaches the AI.')}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ConsumerPrivacySection;
