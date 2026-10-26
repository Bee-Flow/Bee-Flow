import { useEffect } from 'react';
import { usePublicPlansQuery } from '../api/queries/publicSite';
import { API_BASE } from '../utils/helpers';
import ContactSection from './sections/ContactSection';
import beeFlowLogo from '../assets/bee-flow-logo.svg';
import type { Plan } from './PricingPage.types';
import { SECTIONS, BRAND, CURRENCY_SYMBOL, pageStyle, headerStyle, brandStyle, ctaButtonStyle, mainStyle, heroStyle, heroTitleStyle, heroLeadStyle, gridStyle, sectionStyle, sectionStyleSpaced, sectionHeaderStyle, sectionHeadingStyle, sectionSubtitleStyle, cardStyle, skeletonCardStyle, cardHeaderStyle, cardTitleRowStyle, cardNameStyle, cardTaglineStyle, recommendedPillStyle, priceBlockStyle, priceAmountStyle, priceSuffixStyle, trialBadgeStyle, descriptionStyle, listStyle, listItemStyle, planCtaStyle, emptyStyle, emptyTitle, emptyBody, emptyLink, footerStyle, footerInner, footerNav, footerLinkStyle, cssRules } from './PricingPage.constants';
// Public /pricing page. Fetches plans flagged `is_public` from the
// no-auth /api/billing/public-plans endpoint and renders a card grid
// for each `planType` so organisation and consumer plans stay visually
// separate. Reachable when the admin flips "Visible on public pricing
// page" on a plan in the admin Plans panel. Visual chrome mirrors
// HomePage so the public pages feel like one site.

function formatPrice(price: number | string | null, currency: string, billingInterval: string) {
    const symbol = CURRENCY_SYMBOL[currency] || `${currency} `;
    const suffix = billingInterval === 'yearly' ? '/year' : '/month';
    if (price == null) return { amount: 'Contact us', suffix: '' };
    const amount = Number(price);
    if (!Number.isFinite(amount)) return { amount: 'Contact us', suffix: '' };
    if (amount === 0) return { amount: 'Free', suffix: '' };
    const formatted = Number.isInteger(amount)
        ? `${symbol}${amount}`
        : `${symbol}${amount.toFixed(2)}`;
    return { amount: formatted, suffix };
}

function formatLimit(value: number|null, singular: string, plural?: string) {
    if (value == null) return null;
    const word = value === 1 ? singular : (plural || `${singular}s`);
    return `${value.toLocaleString()} ${word}`;
}

export default function PricingPage() {
    const plansQuery = usePublicPlansQuery<Plan>(API_BASE, false);
    // An error reads as the same friendly empty state (nothing is surfaced to anonymous visitors).
    const state = { status: plansQuery.isPending ? 'loading' : 'ok', plans: plansQuery.data ?? [] };

    useEffect(() => {
        const prev = document.title;
        document.title = 'Pricing — Bee Flow';
        return () => { document.title = prev; };
    }, []);

    return (
        <div style={pageStyle}>
            <style>{cssRules}</style>

            <header style={headerStyle}>
                <a href="/" style={brandStyle}>
                    <img
                        src={beeFlowLogo}
                        alt="Bee Flow"
                        className="h-[28px] w-[auto]"
                    />
                </a>
                <a href="/app" style={ctaButtonStyle}>Open the app →</a>
            </header>

            <main style={mainStyle}>
                <section style={heroStyle}>
                    <h1 style={heroTitleStyle}>Pricing</h1>
                    <p style={heroLeadStyle}>
                        Choose the plan that fits. Cancel any time.
                    </p>
                </section>

                {state.status === 'loading' ? (
                    <section style={gridStyle}>
                        <div style={skeletonCardStyle} aria-hidden="true" />
                    </section>
                ) : state.plans.length === 0 ? (
                    <section style={emptyStyle}>
                        <p style={emptyTitle}>Pricing details are coming soon.</p>
                        <p style={emptyBody}>
                            <a href="#contact" style={emptyLink}>Reach out to us</a>
                            {' '}for an early conversation.
                        </p>
                    </section>
                ) : (
                    <PlanSections plans={state.plans} />
                )}

                <ContactSection />
            </main>

            <footer style={footerStyle}>
                <div style={footerInner}>
                    <span style={{ color: BRAND.muted }}>
                        © {new Date().getFullYear()} Bee Flow B.V.
                    </span>
                    <nav style={footerNav}>
                        <a href="/privacy" style={footerLinkStyle}>Privacy</a>
                        <a href="/terms" style={footerLinkStyle}>Terms</a>
                        <a href="#contact" style={footerLinkStyle}>Contact</a>
                    </nav>
                </div>
            </footer>
        </div>
    );
}

function PlanSections({ plans }: { plans: Plan[] }) {
    // Group by planType, preserving server-side sort_order within each
    // group. SECTIONS drives the visible order; unknown types collapse
    // into the organisation bucket so we don't silently drop plans.
    const groups = new Map<string, Plan[]>(SECTIONS.map((s): [string, Plan[]] => [s.type, []]));
    plans.forEach((plan) => {
        const key = groups.has(plan.planType) ? plan.planType : 'organization';
        (groups.get(key) as Plan[]).push(plan);
    });
    const visibleSections = SECTIONS
        .map(s => ({ ...s, plans: groups.get(s.type) || [] }))
        .filter(s => s.plans.length > 0);
    const showHeadings = visibleSections.length > 1;

    return (
        <>
            {visibleSections.map((section, i) => (
                <section
                    key={section.type}
                    style={i === 0 ? sectionStyle : sectionStyleSpaced}
                >
                    {showHeadings ? (
                        <header style={sectionHeaderStyle}>
                            <h2 style={sectionHeadingStyle}>{section.heading}</h2>
                            <p style={sectionSubtitleStyle}>{section.subtitle}</p>
                        </header>
                    ) : null}
                    <div style={gridStyle}>
                        {section.plans.map(plan => (
                            <PlanCard key={plan.id} plan={plan} />
                        ))}
                    </div>
                </section>
            ))}
        </>
    );
}

function PlanCard({ plan }: { plan: Plan }) {
    const { amount, suffix } = formatPrice(plan.price, plan.currency, plan.billingInterval);
    const limits = [
        formatLimit(plan.maxUsers, 'user'),
        formatLimit(plan.maxAgents, 'agent'),
        plan.maxMessagesPerMonth != null
            ? `${plan.maxMessagesPerMonth.toLocaleString()} messages / month`
            : null,
        formatLimit(plan.maxKnowledgeSources, 'knowledge source'),
    ].filter(Boolean);

    const features = Array.isArray(plan.allowedFeatures) ? plan.allowedFeatures : [];
    const visibleFeatures = features.slice(0, 6);
    const extraFeatureCount = Math.max(0, features.length - visibleFeatures.length);

    const showRecommended = plan.ncRecommended || plan.isDefault;

    return (
        <article style={cardStyle}>
            <header style={cardHeaderStyle}>
                <div style={cardTitleRowStyle}>
                    <h2 style={cardNameStyle}>{plan.name}</h2>
                    {showRecommended ? (
                        <span style={recommendedPillStyle}>Recommended</span>
                    ) : null}
                </div>
                {plan.tagline ? (
                    <p style={cardTaglineStyle}>{plan.tagline}</p>
                ) : null}
            </header>

            <div style={priceBlockStyle}>
                <span style={priceAmountStyle}>{amount}</span>
                {suffix ? <span style={priceSuffixStyle}>{suffix}</span> : null}
            </div>

            {plan.trialDays > 0 ? (
                <span style={trialBadgeStyle}>
                    {plan.trialDays}-day free trial
                </span>
            ) : null}

            {plan.description ? (
                <p style={descriptionStyle}>{plan.description}</p>
            ) : null}

            {limits.length > 0 ? (
                <ul style={listStyle}>
                    {limits.map(l => (
                        <li key={l} style={listItemStyle}>{l}</li>
                    ))}
                </ul>
            ) : null}

            {visibleFeatures.length > 0 ? (
                <ul style={listStyle}>
                    {visibleFeatures.map((f: string) => (
                        <li key={f} style={listItemStyle}>{f}</li>
                    ))}
                    {extraFeatureCount > 0 ? (
                        <li style={{ ...listItemStyle, color: BRAND.muted }}>
                            +{extraFeatureCount} more
                        </li>
                    ) : null}
                </ul>
            ) : null}

            <a
                href={`/app?plan=${encodeURIComponent(plan.id)}`}
                style={planCtaStyle}
            >
                Get started
            </a>
        </article>
    );
}

