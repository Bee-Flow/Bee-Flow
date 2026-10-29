import { CheckCircle, Copy, Mail } from 'lucide-react';
import { Button } from '@/components/shared/Button';
import type { TranslateFn } from '@/hooks/useTranslation';
import { TIER_PRESETS, EXPIRY_PRESETS } from '../constants';
import { Banner } from '../ui/Banner';
import { Card } from '../ui/Card';
import { Field, Input, Select, Textarea } from '../ui/Input';
import type { EmailDelivery, GrantForm, GrantOrg } from './GrantWizard';

// The steps of GrantWizard: scope and organisation, tier and expiry (with the
// advanced overrides), the review, and the granted blob.

type UpdateField = <K extends keyof GrantForm>(k: K, v: GrantForm[K]) => void;

interface ScopeStepProps {
    t: TranslateFn;
    form: GrantForm;
    update: UpdateField;
    orgs: GrantOrg[];
    isServerScope: boolean;
}

/** Step 1: bind to an organisation (and which one), or issue an unbound server licence. */
export function ScopeStep({ t, form, update, orgs, isServerScope }: ScopeStepProps) {
    return (
        <>
            <Field label={t('admin_subscriptions.grants_scope', 'Scope')} hint={t('admin_subscriptions.grants_scope_hint', 'A server license is not bound to an org: the receiver re-binds on import.')}>
                <div className="flex flex-col gap-2">
                    <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]">
                        <input
                            type="radio"
                            name="grant-scope"
                            value="organization"
                            checked={form.scope === 'organization'}
                            onChange={() => update('scope', 'organization')}
                            className="mt-0.5"
                        />
                        <span className="text-[13px]">
                            <span className="block font-semibold text-[var(--text-primary)]">{t('admin_subscriptions.grants_bind_org', 'Bind to organisation')}</span>
                            <span className="block text-[12px] text-[var(--text-muted)]">{t('admin_subscriptions.grants_bind_org_desc', 'Standard grant for a specific org on this install.')}</span>
                        </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]">
                        <input
                            type="radio"
                            name="grant-scope"
                            value="server"
                            checked={form.scope === 'server'}
                            onChange={() => update('scope', 'server')}
                            className="mt-0.5"
                        />
                        <span className="text-[13px]">
                            <span className="block font-semibold text-[var(--text-primary)]">{t('admin_subscriptions.grants_server_no_org', 'Server license (no org)')}</span>
                            <span className="block text-[12px] text-[var(--text-muted)]">{t('admin_subscriptions.grants_server_desc', 'Issue an unbound blob to hand to another install: they bind it locally.')}</span>
                        </span>
                    </label>
                </div>
            </Field>
            {!isServerScope && (
                <Field label={t('admin_subscriptions.grants_org', 'Organization')}>
                    <Select value={form.organizationId} onChange={e => update('organizationId', e.target.value)}>
                        <option value="">{t('admin_subscriptions.grants_select_org', 'Select organization')}</option>
                        {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </Select>
                </Field>
            )}
        </>
    );
}

interface DetailsStepProps {
    t: TranslateFn;
    form: GrantForm;
    update: UpdateField;
    tiers: string[] | undefined;
    expiryLabels: Record<number, string>;
    onExpiry: (days: number) => void;
}

/** Step 2: tier, billing interval, expiry (with presets), notes, the delivery e-mail and the advanced overrides. */
export function DetailsStep({ t, form, update, tiers, expiryLabels, onExpiry }: DetailsStepProps) {
    return (
        <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                <Field label={t('admin_subscriptions.grants_tier', 'Tier')}>
                    <Select value={form.tier} onChange={e => update('tier', e.target.value)}>
                        {(tiers || TIER_PRESETS).map(tier => <option key={tier} value={tier}>{tier}</option>)}
                    </Select>
                </Field>
                <Field label={t('admin_subscriptions.grants_billing_interval', 'Billing interval')}>
                    <Select value={form.billingInterval} onChange={e => update('billingInterval', e.target.value)}>
                        <option value="monthly">{t('admin_subscriptions.grants_monthly', 'Monthly')}</option>
                        <option value="yearly">{t('admin_subscriptions.grants_yearly', 'Yearly')}</option>
                    </Select>
                </Field>
            </div>

            <Field label={t('admin_subscriptions.grants_expires_on', 'Expires on')}>
                <Input type="date" value={form.expiresAt} onChange={e => update('expiresAt', e.target.value)} />
                <div className="flex flex-wrap gap-1.5 mt-2">
                    {EXPIRY_PRESETS.map(p => (
                        <button
                            key={p.label}
                            type="button"
                            onClick={() => onExpiry(p.days)}
                            className="px-2.5 py-1 text-[11px] font-semibold rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)]"
                        >
                            {expiryLabels[p.days] ?? p.label}
                        </button>
                    ))}
                </div>
            </Field>

            <Field label={t('admin_subscriptions.grants_notes', 'Notes')} hint={t('admin_subscriptions.grants_notes_hint', 'audit log only')}>
                <Textarea
                    value={form.notes}
                    onChange={e => update('notes', e.target.value)}
                    placeholder={t('admin_subscriptions.grants_notes_placeholder', 'e.g. Comp for partner X: internal trial through end of Q2')}
                    rows={2}
                />
            </Field>

            <Field label={t('admin_subscriptions.grants_email_blob', 'Email blob to customer')} hint={t('admin_subscriptions.grants_email_blob_hint', 'optional, requires service email configured')}>
                <Input
                    type="email"
                    value={form.deliverEmail}
                    onChange={e => update('deliverEmail', e.target.value)}
                    placeholder="customer@example.com"
                />
            </Field>

            <AdvancedOverrides t={t} form={form} update={update} />
        </>
    );
}

/** The collapsible overrides: features, limits (JSON) and a seat cap. */
function AdvancedOverrides({ t, form, update }: { t: TranslateFn; form: GrantForm; update: UpdateField }) {
    return (
        <details
            className="mt-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)]"
            open={form.showAdvanced}
        >
            <summary
                className="px-3 py-2 text-[12.5px] font-semibold cursor-pointer text-[var(--text-secondary)]"
                onClick={e => { e.preventDefault(); update('showAdvanced', !form.showAdvanced); }}
            >
                {t('admin_subscriptions.grants_advanced', 'Advanced overrides')}
            </summary>
            {form.showAdvanced && (
                <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-[var(--border-default)]">
                    <Field label={t('admin_subscriptions.grants_features_override', 'Features override')} hint={t('admin_subscriptions.grants_features_override_hint', 'comma-separated; blank = tier defaults')} className="sm:col-span-2">
                        <Input
                            value={form.featuresOverride}
                            onChange={e => update('featuresOverride', e.target.value)}
                            placeholder="automations, multi_user, kb_unlimited"
                        />
                    </Field>
                    <Field label={t('admin_subscriptions.grants_limits_override', 'Limits override (JSON)')} hint={t('admin_subscriptions.grants_limits_override_hint', 'merged into tier defaults')}>
                        <Input
                            value={form.limitsOverrideJson}
                            onChange={e => update('limitsOverrideJson', e.target.value)}
                            placeholder='{"max_users":100,"max_agents":50}'
                        />
                    </Field>
                    <Field label={t('admin_subscriptions.grants_max_seats', 'Max seats')}>
                        <Input
                            type="number"
                            min="0"
                            value={form.maxSeats}
                            onChange={e => update('maxSeats', e.target.value)}
                            placeholder={t('admin_subscriptions.grants_max_seats_placeholder', '(empty = no cap)')}
                        />
                    </Field>
                </div>
            )}
        </details>
    );
}

/** Step 3: what will be granted, before it is. */
export function GrantReview({ t, form, isServerScope, selectedOrg }: { t: TranslateFn; form: GrantForm; isServerScope: boolean; selectedOrg: GrantOrg | undefined }) {
    return (
        <Card>
            <div className="text-[12px] uppercase tracking-wider font-bold text-[var(--text-muted)] mb-3">{t('admin_subscriptions.grants_review', 'Review')}</div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-[var(--text-muted)]">{t('admin_subscriptions.grants_review_scope', 'Scope')}</dt>
                <dd className="text-[var(--text-primary)] font-semibold">{isServerScope ? t('admin_subscriptions.grants_server_no_org', 'Server license (no org)') : t('admin_subscriptions.grants_review_org', 'Organisation')}</dd>
                {!isServerScope && (
                    <>
                        <dt className="text-[var(--text-muted)]">{t('admin_subscriptions.grants_org', 'Organization')}</dt>
                        <dd className="text-[var(--text-primary)] font-semibold">{selectedOrg?.name}</dd>
                    </>
                )}
                <dt className="text-[var(--text-muted)]">{t('admin_subscriptions.grants_tier', 'Tier')}</dt><dd className="text-[var(--text-primary)] font-semibold capitalize">{form.tier}</dd>
                <dt className="text-[var(--text-muted)]">{t('admin_subscriptions.grants_review_billing', 'Billing')}</dt><dd className="text-[var(--text-primary)] font-semibold capitalize">{form.billingInterval}</dd>
                <dt className="text-[var(--text-muted)]">{t('admin_subscriptions.grants_review_expires', 'Expires')}</dt><dd className="text-[var(--text-primary)] font-semibold">{new Date(form.expiresAt).toLocaleDateString()}</dd>
                {form.deliverEmail && (<><dt className="text-[var(--text-muted)]">{t('admin_subscriptions.grants_review_email', 'Email to')}</dt><dd className="text-[var(--text-primary)]">{form.deliverEmail}</dd></>)}
                {form.notes && (<><dt className="text-[var(--text-muted)]">{t('admin_subscriptions.grants_notes', 'Notes')}</dt><dd className="text-[var(--text-primary)]">{form.notes}</dd></>)}
            </dl>
        </Card>
    );
}

/** The granted blob with Copy, and how the e-mail delivery went. */
export function GrantResult({ t, result, onCopy }: { t: TranslateFn; result: { blob: string; delivery: EmailDelivery | null }; onCopy: () => void }) {
    return (
        <Banner tone="success" icon={CheckCircle} title={t('admin_subscriptions.grants_granted_title', 'License granted: copy the blob to re-import on another install:')}>
            <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 p-2 rounded bg-[var(--bg-tertiary)] text-[10.5px] break-all text-[var(--text-secondary)]">{result.blob}</code>
                <Button size="sm" icon={Copy} onClick={onCopy}>{t('admin_subscriptions.grants_copy', 'Copy')}</Button>
            </div>
            {result.delivery && (
                <div className={`mt-2 text-[11.5px] inline-flex items-center gap-1.5 ${result.delivery.success ? 'text-emerald-300' : 'text-amber-300'}`}>
                    <Mail className="w-3.5 h-3.5" />
                    {result.delivery.success
                        ? t('admin_subscriptions.grants_emailed', 'Emailed to customer (message id: {id})', { id: result.delivery.messageId || t('admin_subscriptions.grants_na', 'n/a') })
                        : t('admin_subscriptions.grants_email_failed', 'Email delivery failed: {error}. Copy the blob and send manually.', { error: result.delivery.error || t('admin_subscriptions.grants_unknown_error', 'unknown error') })}
                </div>
            )}
        </Banner>
    );
}
