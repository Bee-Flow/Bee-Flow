import { ArrowLeft, ArrowRight, Plus, CheckCircle, Save } from 'lucide-react';
import React, { useState } from 'react';
import { TranslateParams, useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import { Button } from '@/components/shared/Button';
import { toast } from '@/components/shared/Toast';
import { apiJson } from '../hooks/useApi';
import { Banner } from '../ui/Banner';
import { IconButton } from '../ui/IconButton';
import { DetailsStep, GrantResult, GrantReview, ScopeStep } from './GrantWizardSteps';

/** One organization in `GET /auth/organizations`, as the wizard lists it. */
export interface GrantOrg {
    id: string;
    name: string;
}

interface GrantWizardProps {
    orgs: GrantOrg[];
    tiers?: string[];
    onBack: () => void;
    onCreated: () => void;
}

/** The wizard's working copy; the e-mail, JSON and seat count stay text until submit. */
export interface GrantForm {
    scope: string;
    organizationId: string;
    tier: string;
    expiresAt: string;
    billingInterval: string;
    notes: string;
    showAdvanced: boolean;
    featuresOverride: string;
    limitsOverrideJson: string;
    maxSeats: string;
    deliverEmail: string;
}

/** The body `POST /api/admin/licenses/grant` takes. */
interface GrantBody {
    scope: string;
    organizationId: string | null;
    tier: string;
    expiresAt: string;
    billingInterval: string;
    notes: string | null;
    deliverEmail?: string;
    featuresOverride?: string[];
    limitsOverride?: unknown;
    maxSeats?: number;
}

/** What the server says about the optional e-mail delivery of the blob. */
export interface EmailDelivery {
    success?: boolean;
    messageId?: string;
    error?: string;
}

export function GrantWizard({ orgs, tiers, onBack, onCreated }: GrantWizardProps) {
    const { t } = useTranslation();
    const STEPS = [
        { id: 'org',     label: t('admin_subscriptions.grants_step_org', 'Organization') },
        { id: 'details', label: t('admin_subscriptions.grants_step_details', 'Tier & expiry') },
        { id: 'review',  label: t('admin_subscriptions.grants_step_review', 'Review & deliver') },
    ];
    const [step, setStep] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null | undefined>(null);
    const [result, setResult] = useState<{ blob: string; delivery: EmailDelivery | null } | null>(null);
    const [form, setForm] = useState<GrantForm>({
        scope: 'organization',
        organizationId: '',
        tier: 'enterprise',
        expiresAt: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
        billingInterval: 'yearly',
        notes: '',
        showAdvanced: false,
        featuresOverride: '',
        limitsOverrideJson: '',
        maxSeats: '',
        deliverEmail: '',
    });
    const update = <K extends keyof GrantForm>(k: K, v: GrantForm[K]) => setForm(f => ({ ...f, [k]: v }));
    const selectedOrg = orgs.find(o => o.id === form.organizationId);
    const isServerScope = form.scope === 'server';

    const EXPIRY_LABELS: Record<number, string> = {
        30: t('admin_subscriptions.grants_expiry_30', '30 days'),
        90: t('admin_subscriptions.grants_expiry_90', '90 days'),
        365: t('admin_subscriptions.grants_expiry_365', '1 year'),
        730: t('admin_subscriptions.grants_expiry_730', '2 years'),
    };
    const applyExpiry = (days: number) => update('expiresAt', new Date(Date.now() + days * 86400000).toISOString().slice(0, 10));

    const canNext =
        (step === 0 && (isServerScope || form.organizationId)) ||
        (step === 1 && form.tier && form.expiresAt) ||
        step === 2;

    const submit = async () => {
        setError(null);
        setBusy(true);
        try {
            const body: GrantBody = {
                scope: form.scope,
                organizationId: isServerScope ? null : form.organizationId,
                tier: form.tier,
                expiresAt: new Date(form.expiresAt + 'T23:59:59Z').toISOString(),
                billingInterval: form.billingInterval,
                notes: form.notes || null,
            };
            if (form.deliverEmail.trim()) body.deliverEmail = form.deliverEmail.trim();
            if (form.showAdvanced) {
                if (form.featuresOverride.trim()) {
                    body.featuresOverride = form.featuresOverride.split(',').map(s => s.trim()).filter(Boolean);
                }
                if (form.limitsOverrideJson.trim()) {
                    try { body.limitsOverride = JSON.parse(form.limitsOverrideJson); }
                    catch { throw new Error(t('admin_subscriptions.grants_limits_invalid', 'Limits override must be valid JSON, e.g. {example}', { example: '{"max_users":50}' })); }
                }
                if (form.maxSeats) body.maxSeats = parseInt(form.maxSeats, 10);
            }
            const res = await apiJson('/api/admin/licenses/grant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            setResult({ blob: res.blob, delivery: res.emailDelivery || null });
            toast.success(t('admin_subscriptions.grants_granted', 'License granted.'));
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const copyBlob = async () => {
        if (!result?.blob) return;
        try { await navigator.clipboard.writeText(result.blob); toast.success(t('admin_subscriptions.grants_blob_copied_clip', 'Blob copied to clipboard.')); }
        catch { window.prompt(t('admin_subscriptions.grants_copy_prompt', 'Copy this blob:'), result.blob); }
    };

    const finish = () => {
        onCreated();
    };

    return (
        <div className="absolute inset-0 flex flex-col bg-[var(--bg-primary)]">
            <GrantWizardHeader onBack={onBack} t={t} isServerScope={isServerScope} selectedOrg={selectedOrg} STEPS={STEPS} step={step} />

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-xl mx-auto px-6 py-8 pb-32 space-y-5">
                    {error && <Banner tone="danger">{error}</Banner>}

                    {step === 0 && <ScopeStep t={t} form={form} update={update} orgs={orgs} isServerScope={isServerScope} />}

                    {step === 1 && <DetailsStep t={t} form={form} update={update} tiers={tiers} expiryLabels={EXPIRY_LABELS} onExpiry={applyExpiry} />}

                    {step === 2 && !result && <GrantReview t={t} form={form} isServerScope={isServerScope} selectedOrg={selectedOrg} />}

                    {result && <GrantResult t={t} result={result} onCopy={copyBlob} />}
                </div>
            </div>

            <GrantWizardFooter onBack={onBack} t={t} step={step} result={result} setStep={setStep} canNext={canNext} submit={submit} busy={busy} finish={finish} />
        </div>
    );
}

function GrantWizardFooter({ onBack, t, step, result, setStep, canNext, submit, busy, finish }: { onBack: () => void; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; step: number; result: { blob: string; delivery: EmailDelivery | null; } | null; setStep: React.Dispatch<React.SetStateAction<number>>; canNext: string | boolean; submit: () => Promise<void>; busy: boolean; finish: () => void; }) {
    return <footer className="shrink-0 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] px-6 py-3 flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>{t('admin_subscriptions.grants_cancel', 'Cancel')}</Button>
        <div className="flex items-center gap-2">
            {step > 0 && !result && <Button variant="secondary" icon={ArrowLeft} onClick={() => setStep(s => s - 1)}>{t('admin_subscriptions.grants_back_btn', 'Back')}</Button>}
            {step < 2 && !result && (
                <Button
                    variant="primary"
                    iconRight={<ArrowRight className="w-4 h-4" />}
                    onClick={() => setStep(s => s + 1)}
                    disabled={!canNext}
                >
                    {t('admin_subscriptions.grants_next', 'Next')}
                </Button>
            )}
            {step === 2 && !result && (
                <Button variant="primary" icon={Plus} onClick={submit} busy={busy}>
                    {busy ? t('admin_subscriptions.grants_granting', 'Granting…') : t('admin_subscriptions.grants_grant', 'Grant license')}
                </Button>
            )}
            {result && (
                <Button variant="primary" icon={Save} onClick={finish}>{t('admin_subscriptions.grants_done', 'Done')}</Button>
            )}
        </div>
    </footer>;
}

function GrantWizardHeader({ onBack, t, isServerScope, selectedOrg, STEPS, step }: { onBack: () => void; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; isServerScope: boolean; selectedOrg: GrantOrg | undefined; STEPS: { id: string; label: string; }[]; step: number; }) {
    return <header className="shrink-0 flex items-center gap-3 px-6 py-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
        <IconButton icon={ArrowLeft} size="sm" onClick={onBack} title={t('admin_subscriptions.grants_back', 'Back to grants')} />
        <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">{t('admin_subscriptions.grants_wizard_title', 'Issue admin license')}</div>
            <h1 className="text-[16px] font-bold text-[var(--text-primary)] truncate">
                {isServerScope ? t('admin_subscriptions.grants_server_no_org', 'Server license (no org)') : (selectedOrg?.name || t('admin_subscriptions.grants_pick_org', 'Pick organization'))}
            </h1>
        </div>
        <div className="ml-auto hidden sm:flex items-center gap-2">
            {STEPS.map((s, idx) => (
                <div key={s.id} className="flex items-center gap-2">
                    <div className={`w-6 h-6 rounded-full inline-flex items-center justify-center text-[11px] font-bold ${idx < step ? 'bg-emerald-500 text-white' :
                            idx === step ? 'bg-blue-500 text-white' :
                                'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'}`}>
                        {idx < step ? <CheckCircle className="w-3.5 h-3.5" /> : idx + 1}
                    </div>
                    <span className={`text-[12px] ${idx === step ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{s.label}</span>
                    {idx < STEPS.length - 1 && <span className="text-[var(--text-muted)]">→</span>}
                </div>
            ))}
        </div>
    </header>;
}
