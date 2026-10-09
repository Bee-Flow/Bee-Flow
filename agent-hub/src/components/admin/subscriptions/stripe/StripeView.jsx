import { CreditCard, Settings, Shield, Euro, ExternalLink, CheckCircle, Loader2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { StripeKeyField } from './StripeKeyField';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Button } from '../../../shared/Button';
import { toast } from '../../../shared/Toast';
import { apiJson } from '../hooks/useApi';
import { Badge, Dot } from '../ui/Badge';
import { Banner } from '../ui/Banner';
import { Card, CardHeader } from '../ui/Card';
import { Field, Select, Input } from '../ui/Input';
import { SectionHeader } from '../ui/SectionHeader';
import { Spinner } from '../ui/Spinner';
import { Toggle } from '../ui/Toggle';

export function StripeView() {
    const { t } = useTranslation();
    const TAX_COUNTRIES = [
        { value: 'NL', label: `🇳🇱 ${t('admin_subscriptions.stripe_country_nl', 'Netherlands')}` },
        { value: 'DE', label: `🇩🇪 ${t('admin_subscriptions.stripe_country_de', 'Germany')}` },
        { value: 'BE', label: `🇧🇪 ${t('admin_subscriptions.stripe_country_be', 'Belgium')}` },
        { value: 'FR', label: `🇫🇷 ${t('admin_subscriptions.stripe_country_fr', 'France')}` },
        { value: 'IE', label: `🇮🇪 ${t('admin_subscriptions.stripe_country_ie', 'Ireland')}` },
        { value: 'ES', label: `🇪🇸 ${t('admin_subscriptions.stripe_country_es', 'Spain')}` },
        { value: 'IT', label: `🇮🇹 ${t('admin_subscriptions.stripe_country_it', 'Italy')}` },
        { value: 'AT', label: `🇦🇹 ${t('admin_subscriptions.stripe_country_at', 'Austria')}` },
        { value: 'SE', label: `🇸🇪 ${t('admin_subscriptions.stripe_country_se', 'Sweden')}` },
        { value: 'FI', label: `🇫🇮 ${t('admin_subscriptions.stripe_country_fi', 'Finland')}` },
    ];
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [config, setConfig] = useState({
        hasStripeSecretKey: false,
        hasStripeWebhookSecret: false,
        stripePublishableKey: '',
        stripeEnabled: false,
        stripeTaxEnabled: false,
        stripeTaxCountry: 'NL',
        subscriptionNotifyEmail: '',
    });
    const [secretKey, setSecretKey]         = useState('');
    const [webhookSecret, setWebhookSecret] = useState('');
    const [publishableKey, setPublishableKey] = useState('');
    const [notifyEmail, setNotifyEmail]     = useState('');

    const load = async () => {
        try {
            const data = await apiJson('/ai/config');
            setConfig({
                hasStripeSecretKey:     !!data.hasStripeSecretKey,
                hasStripeWebhookSecret: !!data.hasStripeWebhookSecret,
                stripePublishableKey:   data.stripePublishableKey || '',
                stripeEnabled:          !!data.stripeEnabled,
                stripeTaxEnabled:       !!data.stripeTaxEnabled,
                stripeTaxCountry:       data.stripeTaxCountry || 'NL',
                subscriptionNotifyEmail: data.subscriptionNotifyEmail || '',
            });
            setPublishableKey(data.stripePublishableKey || '');
            setNotifyEmail(data.subscriptionNotifyEmail || '');
        } catch (e) { /* ignore */ }
        finally { setLoading(false); }
    };

    useEffect(() => { load(); }, []);

    const saveField = async (payload) => {
        setSaving(true);
        try {
            await apiJson('/ai/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            toast.success(t('admin_subscriptions.stripe_saved', 'Saved.'));
            await load();
        } catch (e) { toast.error(e.message || t('admin_subscriptions.stripe_save_failed', 'Failed to save')); }
        finally { setSaving(false); }
    };

    const deleteKey = async (keyName) => {
        setSaving(true);
        try {
            await apiJson(`/ai/config/key/${keyName}`, { method: 'DELETE' });
            toast.success(t('admin_subscriptions.stripe_key_removed', 'Key removed.'));
            await load();
        } catch (e) { toast.error(t('admin_subscriptions.stripe_key_remove_failed', 'Failed to remove key')); }
        finally { setSaving(false); }
    };

    if (loading) return <Spinner label={t('admin_subscriptions.stripe_loading', 'Loading Stripe settings…')} />;

    const webhookURL = `${window.location.origin}/api/stripe/webhook`;

    return (
        <div className="px-6 py-6 max-w-2xl mx-auto">
            <SectionHeader
                title={t('admin_subscriptions.stripe_title', 'Stripe Payment Integration')}
                description={t('admin_subscriptions.stripe_desc', 'Connect Stripe to enable subscription billing for your plans.')}
            />

            {/* Connection status */}
            <Card className="mb-4" accent={config.stripeEnabled ? 'emerald' : undefined}>
                <CardHeader
                    icon={Settings}
                    iconClass="text-blue-400"
                    title={t('admin_subscriptions.stripe_status', 'Connection status')}
                    action={
                        <div className="flex items-center gap-2">
                            <span className={`text-[11px] font-bold uppercase tracking-wider ${config.stripeEnabled ? 'text-emerald-400' : 'text-[var(--text-muted)]'}`}>
                                {config.stripeEnabled ? t('admin_subscriptions.stripe_enabled', 'Enabled') : t('admin_subscriptions.stripe_disabled', 'Disabled')}
                            </span>
                            <Toggle
                                checked={config.stripeEnabled}
                                disabled={!config.hasStripeSecretKey && !config.stripeEnabled}
                                onChange={v => saveField({ stripeEnabled: v })}
                            />
                        </div>
                    }
                />
                <div className="flex flex-col gap-1.5 text-[12.5px]">
                    {[
                        { ok: config.hasStripeSecretKey,    label: t('admin_subscriptions.stripe_secret_key', 'Secret key') },
                        { ok: !!config.stripePublishableKey, label: t('admin_subscriptions.stripe_publishable_key', 'Publishable key') },
                        { ok: config.hasStripeWebhookSecret, label: t('admin_subscriptions.stripe_webhook_secret', 'Webhook secret') },
                    ].map(row => (
                        <div key={row.label} className="flex items-center gap-2">
                            <Dot tone={row.ok ? 'success' : 'danger'} />
                            <span className="text-[var(--text-secondary)]">{row.label}</span>
                            <span className={`ml-auto font-semibold ${row.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {row.ok ? t('admin_subscriptions.stripe_configured', 'Configured') : t('admin_subscriptions.stripe_not_configured', 'Not configured')}
                            </span>
                        </div>
                    ))}
                </div>
            </Card>

            {/* API keys */}
            <Card className="mb-4">
                <CardHeader
                    icon={Shield}
                    iconClass="text-blue-400"
                    title={t('admin_subscriptions.stripe_api_keys', 'API keys')}
                    subtitle={
                        <>{t('admin_subscriptions.stripe_get_keys', 'Get your keys from the')}{' '}
                            <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-semibold inline-flex items-center gap-0.5">
                                {t('admin_subscriptions.stripe_dashboard', 'Stripe Dashboard')} <ExternalLink className="w-3 h-3" />
                            </a>
                        </>
                    }
                />
                <StripeKeyField
                    label={t('admin_subscriptions.stripe_secret_key', 'Secret key')}
                    type="password"
                    configured={config.hasStripeSecretKey}
                    placeholderConfigured="••••••••••••••••••"
                    placeholderEmpty={t('admin_subscriptions.stripe_secret_ph', 'sk_live_… or sk_test_…')}
                    value={secretKey}
                    onChange={setSecretKey}
                    onSave={() => { saveField({ stripeSecretKey: secretKey }); setSecretKey(''); }}
                    onClear={() => deleteKey('stripe_secret_key')}
                    busy={saving}
                />
                <StripeKeyField
                    label={t('admin_subscriptions.stripe_publishable_key', 'Publishable key')}
                    type="text"
                    configured={!!config.stripePublishableKey}
                    placeholderConfigured={t('admin_subscriptions.stripe_publishable_ph', 'pk_live_… or pk_test_…')}
                    placeholderEmpty={t('admin_subscriptions.stripe_publishable_ph', 'pk_live_… or pk_test_…')}
                    value={publishableKey}
                    onChange={setPublishableKey}
                    onSave={() => saveField({ stripePublishableKey: publishableKey })}
                    busy={saving}
                />
                <StripeKeyField
                    label={t('admin_subscriptions.stripe_webhook_signing', 'Webhook signing secret')}
                    type="password"
                    configured={config.hasStripeWebhookSecret}
                    placeholderConfigured="••••••••••••••••••"
                    placeholderEmpty="whsec_…"
                    value={webhookSecret}
                    onChange={setWebhookSecret}
                    onSave={() => { saveField({ stripeWebhookSecret: webhookSecret }); setWebhookSecret(''); }}
                    onClear={() => deleteKey('stripe_webhook_secret')}
                    busy={saving}
                />
            </Card>

            {/* Tax & Region */}
            <Card className="mb-4">
                <CardHeader
                    icon={Euro}
                    iconClass="text-emerald-400"
                    title={t('admin_subscriptions.stripe_tax_title', 'Tax & region (EU compliance)')}
                    subtitle={
                        <>{t('admin_subscriptions.stripe_tax_subtitle', 'Configure Stripe Tax for automatic VAT calculation.')}{' '}
                            <a href="https://stripe.com/tax" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 font-semibold inline-flex items-center gap-0.5">
                                {t('admin_subscriptions.stripe_learn_more', 'Learn more')} <ExternalLink className="w-3 h-3" />
                            </a>
                        </>
                    }
                />
                <Toggle
                    checked={config.stripeTaxEnabled}
                    onChange={v => saveField({ stripeTaxEnabled: v })}
                    label={t('admin_subscriptions.stripe_tax_enable', 'Enable Stripe Tax')}
                    description={t('admin_subscriptions.stripe_tax_enable_desc', 'Automatically calculate and collect VAT on subscriptions.')}
                />
                {/* BFSF-250: flipping the toggle alone is not enough — prices
                    synced while it was off lack tax_behavior (checkout fails
                    against them) and Stripe Tax needs Dashboard registration.
                    Existing subscriptions are backfilled automatically on
                    enable; note the real-billing impact. */}
                <p className="mt-2 text-[11px] text-amber-500/90">
                    {t('admin_subscriptions.stripe_tax_warning', 'Enabling requires: (1) Stripe Tax activated in the Stripe Dashboard (origin address + NL VAT registration), and (2) re-syncing every plan so new Prices carry tax_behavior. Existing active subscriptions are backfilled automatically: their next invoice will include 21% BTW, so announce this to customers first.')}
                </p>
                <div className="mt-3">
                    <Field label={t('admin_subscriptions.stripe_nexus', 'Tax nexus country')} hint={t('admin_subscriptions.stripe_nexus_hint', 'where your business is registered for VAT')}>
                        <Select
                            value={config.stripeTaxCountry}
                            onChange={e => saveField({ stripeTaxCountry: e.target.value })}
                            className="max-w-xs"
                        >
                            {TAX_COUNTRIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </Select>
                    </Field>
                </div>
            </Card>

            {/* Notifications */}
            <Card className="mb-4">
                <CardHeader
                    icon={CreditCard}
                    iconClass="text-amber-400"
                    title={t('admin_subscriptions.stripe_notify_title', 'Subscription notifications')}
                    subtitle={t('admin_subscriptions.stripe_notify_subtitle', 'Get an email whenever a customer starts a new subscription.')}
                />
                <Field
                    label={t('admin_subscriptions.stripe_notify_label', 'Notify this email on new subscriptions')}
                    hint={t('admin_subscriptions.stripe_notify_hint', 'Leave empty to turn notifications off. One email is sent per new subscription.')}
                >
                    <div className="flex items-center gap-2 max-w-md">
                        <Input
                            type="email"
                            value={notifyEmail}
                            onChange={e => setNotifyEmail(e.target.value)}
                            placeholder="billing@yourcompany.com"
                        />
                        <Button
                            onClick={() => saveField({ subscriptionNotifyEmail: notifyEmail })}
                            busy={saving}
                            disabled={notifyEmail.trim() === (config.subscriptionNotifyEmail || '')}
                        >
                            {t('admin_subscriptions.stripe_save', 'Save')}
                        </Button>
                    </div>
                </Field>
            </Card>

            {/* Setup checklist */}
            <Card>
                <CardHeader title={t('admin_subscriptions.stripe_checklist', 'Setup checklist')} />
                <ol className="list-none p-0 m-0 space-y-2 text-[12.5px] text-[var(--text-secondary)]">
                    {[
                        { done: config.hasStripeSecretKey, label: t('admin_subscriptions.stripe_step_keys', 'Add the Secret Key and the Publishable Key from Stripe Dashboard → API keys') },
                        { done: config.hasStripeWebhookSecret, label: (
                            <>
                                {t('admin_subscriptions.stripe_step_webhook', 'Create a Webhook endpoint in Stripe Dashboard pointing to:')}{' '}
                                <code className="ml-1 px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[11px] text-blue-400">{webhookURL}</code>
                            </>
                        )},
                        { done: config.hasStripeWebhookSecret, label: (
                            <>
                                {t('admin_subscriptions.stripe_step_events', 'Subscribe to events:')}{' '}
                                {['checkout.session.completed','customer.subscription.updated','customer.subscription.deleted','invoice.payment_failed'].map((ev, i, arr) => (
                                    <React.Fragment key={ev}>
                                        <code className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[10.5px]">{ev}</code>{i < arr.length - 1 ? ', ' : ''}
                                    </React.Fragment>
                                ))}
                            </>
                        )},
                        { done: config.stripeEnabled, label: t('admin_subscriptions.stripe_step_enable', 'Enable Stripe payments using the toggle above') },
                        { done: false, label: t('admin_subscriptions.stripe_step_price', 'Set a price on your subscription plans in the Plans tab') },
                    ].map((item, i) => (
                        <li key={i} className="flex items-start gap-2.5">
                            {item.done
                                ? <CheckCircle className="shrink-0 w-4 h-4 mt-0.5 text-emerald-400" />
                                : <span className="shrink-0 w-4 h-4 mt-0.5 rounded border border-[var(--border-default)]" />}
                            <span className={item.done ? 'text-emerald-300' : ''}>{item.label}</span>
                        </li>
                    ))}
                </ol>
            </Card>
        </div>
    );
}
