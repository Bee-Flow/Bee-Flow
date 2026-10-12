import React from 'react';
import { TextField, Toggle } from '../fields';
import { InlineHint, CollapsibleCard, FieldSelect } from '../primitives';
import { set } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Pricing ───────────────────────────────────────────────────────────
//
// Dynamic pricing block. Plans come from the subscription database via
// `GET /api/billing/public-plans`. The admin picks an audience
// (`planType`: organization or consumer); the marketing block fetches
// and renders matching plans live. To show both audiences on one page,
// drop two pricing blocks — one per audience — onto the page.
//
// Editor exposes only: heading/subheading + audience + monthly/yearly
// toggle controls + CTA / empty-state copy. Plan content itself is
// managed at /app/admin/subscriptions and is NOT editable here.

const pricingPlanTypes = (t) => [
    { value: 'organization', label: t('cms_site.blocks.pricing.plan_type_organizations', 'Organisations') },
    { value: 'consumer',     label: t('cms_site.blocks.pricing.plan_type_consumers', 'Consumers') },
];

const pricingIntervalOptions = (t) => [
    { value: 'monthly', label: t('cms_site.blocks.pricing.interval_monthly', 'Monthly') },
    { value: 'yearly',  label: t('cms_site.blocks.pricing.interval_yearly', 'Yearly') },
];

export function PricingEditor({ data = {}, onChange }) {
    const { t } = useTranslation();
    const setField = (key, value) => onChange(set(data, key, value));

    const planType        = data.planType === 'consumer' ? 'consumer' : 'organization';
    const enableToggle    = data.enableToggle !== false;
    const defaultInterval = data.defaultInterval === 'yearly' ? 'yearly' : 'monthly';

    // Live preview of which plans the visitor will see, given the
    // currently-selected planType. Refetched on Refresh — admins can
    // change plans in /app/admin/subscriptions and confirm here without
    // reopening the editor.
    const [preview, setPreview] = React.useState({ loading: true, error: null, plans: [] });
    const reloadPreview = React.useCallback(() => {
        setPreview(p => ({ ...p, loading: true, error: null }));
        fetch('/api/billing/public-plans', { credentials: 'include' })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(payload => {
                const plans = Array.isArray(payload?.plans) ? payload.plans : [];
                setPreview({ loading: false, error: null, plans });
            })
            .catch(err => setPreview({ loading: false, error: err.message || 'Failed', plans: [] }));
    }, []);
    React.useEffect(() => { reloadPreview(); }, [reloadPreview]);
    const matchingPlans = preview.plans.filter(p => p?.planType === planType);

    return (
        <>
            <InlineHint>
                {t('cms_site.blocks.pricing.pricing_cards_are_pulled_live_from_your', 'Pricing cards are pulled live from your published subscription plans. For both audiences on one page, add a second pricing block with the other audience.')}{' '}
                {t('cms_site.blocks.pricing.manage_plans_at', 'Manage plans at')}{' '}
                <a href="/app/admin/subscriptions" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>/app/admin/subscriptions</a>
            </InlineHint>

            <CollapsibleCard title={t('cms_site.blocks.pricing.heading', 'Heading')} defaultOpen={true} persistKey="blk.pricing.heading">
                <TextField
                    label={t('cms_site.blocks.pricing.heading', 'Heading')}
                    value={data.heading || ''}
                    onChange={v => setField('heading', v)}
                    placeholder={t('cms_site.blocks.pricing.pricing', 'Pricing')}
                />
                <TextField
                    label={t('cms_site.blocks.pricing.subheading', 'Subheading')}
                    value={data.subheading || ''}
                    onChange={v => setField('subheading', v)}
                    placeholder={t('cms_site.blocks.pricing.short_line_that_sits_under_the', 'Short line that sits under the heading.')}
                />
            </CollapsibleCard>

            <CollapsibleCard title={t('cms_site.blocks.pricing.audience', 'Audience')} persistKey="blk.pricing.audience">
                <FieldSelect
                    label={t('cms_site.blocks.pricing.show_plans_for', 'Show plans for')}
                    value={planType}
                    options={pricingPlanTypes(t)}
                    onChange={v => setField('planType', v)}
                />

                {/* Live preview list — tells the admin exactly which plans
                    will show up for this audience right now. */}
                <div className="mt-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
                    <div className="flex items-center justify-between mb-2">
                        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                            {t('cms_site.blocks.pricing.plans_the_visitor_will_see', 'Plans the visitor will see')}
                        </div>
                        <button
                            type="button"
                            onClick={reloadPreview}
                            className="text-xs underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >
                            {t('cms_site.blocks.pricing.refresh', 'Refresh')}
                        </button>
                    </div>
                    {preview.loading ? (
                        <div className="text-xs text-[var(--text-muted)]">{t('cms_site.blocks.pricing.loading', 'Loading…')}</div>
                    ) : preview.error ? (
                        <div className="text-xs text-red-500">{t('cms_site.blocks.pricing.failed_error', 'Failed: {error}', { error: preview.error })}</div>
                    ) : matchingPlans.length === 0 ? (
                        <div className="text-xs text-[var(--text-muted)]">
                            {t('cms_site.blocks.pricing.no_public_plans_for_this_audience', 'No public plans for this audience. Create one at /app/admin/subscriptions.')}
                        </div>
                    ) : (
                        <ul className="text-xs text-[var(--text-secondary)] space-y-1 list-disc pl-4">
                            {matchingPlans.map(p => (
                                <li key={p.id}>
                                    <strong>{p.name}</strong>
                                    {p.price != null
                                        ? t('cms_site.blocks.pricing.plan_price_line', ' — {currency} {price} / {interval}', { currency: p.currency || 'EUR', price: p.price, interval: p.billingInterval || '—' })
                                        : t('cms_site.blocks.pricing.plan_custom_pricing', ' — Custom pricing')}
                                    {p.trialDays > 0 ? t('cms_site.blocks.pricing.plan_trial_line', ' · {days}d trial', { days: p.trialDays }) : ''}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </CollapsibleCard>

            <CollapsibleCard title={t('cms_site.blocks.pricing.billing_interval_toggle', 'Billing interval toggle')} persistKey="blk.pricing.interval">
                <Toggle
                    label={t('cms_site.blocks.pricing.show_monthly_yearly_toggle_to_visitors', 'Show monthly/yearly toggle to visitors')}
                    value={enableToggle}
                    onChange={v => setField('enableToggle', v)}
                />
                {enableToggle ? (
                    <>
                        <FieldSelect
                            label={t('cms_site.blocks.pricing.default_side', 'Default side')}
                            value={defaultInterval}
                            options={pricingIntervalOptions(t)}
                            onChange={v => setField('defaultInterval', v)}
                        />
                        <TextField
                            label={t('cms_site.blocks.pricing.monthly_label', 'Monthly label')}
                            value={data.toggleLabelMonthly || ''}
                            onChange={v => setField('toggleLabelMonthly', v)}
                            placeholder={t('cms_site.blocks.pricing.toggle_monthly_placeholder', 'Monthly')}
                        />
                        <TextField
                            label={t('cms_site.blocks.pricing.yearly_label', 'Yearly label')}
                            value={data.toggleLabelYearly || ''}
                            onChange={v => setField('toggleLabelYearly', v)}
                            placeholder={t('cms_site.blocks.pricing.toggle_yearly_placeholder', 'Yearly')}
                        />
                    </>
                ) : (
                    <FieldSelect
                        label={t('cms_site.blocks.pricing.show_only_this_interval', 'Show only this interval')}
                        value={defaultInterval}
                        options={pricingIntervalOptions(t)}
                        onChange={v => setField('defaultInterval', v)}
                    />
                )}
            </CollapsibleCard>

            <CollapsibleCard title={t('cms_site.blocks.pricing.featured_tier', 'Featured tier')} persistKey="blk.pricing.featured">
                <FieldSelect
                    label={t('cms_site.blocks.pricing.highlight_plan', 'Highlight plan')}
                    value={data.featuredPlanId || ''}
                    options={[
                        { value: '', label: t('cms_site.blocks.pricing.featured_none', 'None (all buttons filled)') },
                        ...matchingPlans.map(p => ({ value: p.id, label: p.name })),
                    ]}
                    onChange={v => setField('featuredPlanId', v)}
                />
                {data.featuredPlanId ? (
                    <FieldSelect
                        label={t('cms_site.blocks.pricing.highlight_style', 'Highlight style')}
                        value={data.featuredStyle === 'flip' ? 'flip' : 'border'}
                        options={[
                            { value: 'border', label: t('cms_site.blocks.pricing.featured_style_border', 'Accent border + glow') },
                            { value: 'flip',   label: t('cms_site.blocks.pricing.featured_style_flip', 'Dark card (polarity flip)') },
                        ]}
                        onChange={v => setField('featuredStyle', v)}
                    />
                ) : null}
            </CollapsibleCard>

            <CollapsibleCard title={t('cms_site.blocks.pricing.price_copy', 'Price copy')} persistKey="blk.pricing.copy">
                <TextField
                    label={t('cms_site.blocks.pricing.monthly_suffix', 'Monthly suffix')}
                    value={data.suffixMonthly || ''}
                    onChange={v => setField('suffixMonthly', v)}
                    placeholder={t('cms_site.blocks.pricing.suffix_monthly_placeholder', '/month')}
                />
                <TextField
                    label={t('cms_site.blocks.pricing.yearly_suffix', 'Yearly suffix')}
                    value={data.suffixYearly || ''}
                    onChange={v => setField('suffixYearly', v)}
                    placeholder={t('cms_site.blocks.pricing.suffix_yearly_placeholder', '/year')}
                />
                <TextField
                    label={t('cms_site.blocks.pricing.custom_price_text', 'Custom-price text')}
                    value={data.customPriceText || ''}
                    onChange={v => setField('customPriceText', v)}
                    placeholder={t('cms_site.blocks.pricing.custom_price_placeholder', 'On request')}
                    hint={t('cms_site.blocks.pricing.shown_for_plans_without_a_fixed', 'Shown for plans without a fixed price.')}
                />
                <TextField
                    label={t('cms_site.blocks.pricing.trial_text', 'Trial text')}
                    value={data.trialText || ''}
                    onChange={v => setField('trialText', v)}
                    placeholder={t('cms_site.blocks.pricing.trial_placeholder', '{days} days free trial')}
                    hint={t('cms_site.blocks.pricing.days_is_replaced_by_the_plan_s', "{days} is replaced by the plan's trial length.")}
                />
            </CollapsibleCard>

            <CollapsibleCard title={t('cms_site.blocks.pricing.call_to_action', 'Call to action')} defaultOpen={false} persistKey="blk.pricing.cta">
                <TextField
                    label={t('cms_site.blocks.pricing.button_label', 'Button label')}
                    value={data.ctaLabel || ''}
                    onChange={v => setField('ctaLabel', v)}
                    placeholder={t('cms_site.blocks.pricing.cta_placeholder', 'Choose plan')}
                    hint={t('cms_site.blocks.pricing.buttons_link_to_app_billing_plan', 'Buttons link to /app/billing?plan=<id>. The plan id is added automatically per card.')}
                />
                <TextField
                    label={t('cms_site.blocks.pricing.empty_state_text', 'Empty-state text')}
                    value={data.emptyText || ''}
                    onChange={v => setField('emptyText', v)}
                    placeholder={t('cms_site.blocks.pricing.empty_placeholder', 'No plans available')}
                    hint={t('cms_site.blocks.pricing.shown_when_no_public_plans_match', 'Shown when no public plans match the selected audience and interval.')}
                />
            </CollapsibleCard>
        </>
    );
}
