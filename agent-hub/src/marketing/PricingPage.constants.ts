import React from 'react';

// Order matters: teams first (B2B-positioned product), individuals
// second. Anything missing a known planType is treated as an
// organisation plan, matching the server-side default.
export const SECTIONS = [
    {
        type: 'organization',
        heading: 'For teams',
        subtitle: 'Designed for organisations running Bee Flow at work.',
    },
    {
        type: 'consumer',
        heading: 'For individuals',
        subtitle: 'Personal plans — bring your own model usage where applicable.',
    },
];

export const BRAND = {
    primary: '#F5A623',
    text: '#1F2937',
    muted: '#6B7280',
    border: '#E5E7EB',
    bg: '#FFFFFF',
    soft: '#FAFAFA',
    badgeBg: '#FFF4DC',
    badgeText: '#8A5A00',
    pillBg: '#1F2937',
    pillText: '#FFFFFF',
};

export const CURRENCY_SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

export const pageStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: BRAND.bg,
    color: BRAND.text,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    display: 'flex',
    flexDirection: 'column',
};

export const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '20px 24px',
    borderBottom: `1px solid ${BRAND.border}`,
    background: BRAND.bg,
};

export const brandStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    textDecoration: 'none',
    color: BRAND.text,
};

export const ctaButtonStyle = {
    background: BRAND.primary,
    color: '#1F2937',
    padding: '10px 18px',
    borderRadius: 8,
    textDecoration: 'none',
    fontWeight: 600,
    fontSize: 14,
};

export const mainStyle = {
    flex: 1,
    maxWidth: 1080,
    width: '100%',
    margin: '0 auto',
    padding: '64px 24px 96px',
};

export const heroStyle: React.CSSProperties = {
    textAlign: 'center',
    marginBottom: 48,
};

export const heroTitleStyle = {
    fontSize: 44,
    lineHeight: 1.1,
    margin: '0 0 12px',
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: BRAND.text,
};

export const heroLeadStyle = {
    fontSize: 17,
    color: BRAND.muted,
    margin: 0,
};

export const gridStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: 20,
};

export const sectionStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
};

export const sectionStyleSpaced: React.CSSProperties = {
    ...({
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
    }),
    marginTop: 64,
};

export const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
};

export const sectionHeadingStyle = {
    fontSize: 22,
    fontWeight: 700,
    margin: 0,
    color: BRAND.text,
    letterSpacing: '-0.01em',
};

export const sectionSubtitleStyle = {
    fontSize: 14,
    color: BRAND.muted,
    margin: 0,
};

export const cardStyle: React.CSSProperties = {
    border: `1px solid ${BRAND.border}`,
    borderRadius: 14,
    padding: 28,
    background: BRAND.bg,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
};

export const skeletonCardStyle = {
    border: `1px solid ${BRAND.border}`,
    borderRadius: 14,
    minHeight: 360,
    background: BRAND.soft,
};

export const cardHeaderStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };

export const cardTitleRowStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
};

export const cardNameStyle = {
    fontSize: 20,
    fontWeight: 700,
    margin: 0,
    color: BRAND.text,
};

export const cardTaglineStyle = {
    fontSize: 14,
    color: BRAND.muted,
    margin: 0,
    lineHeight: 1.5,
};

export const recommendedPillStyle = {
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 999,
    background: BRAND.pillBg,
    color: BRAND.pillText,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
};

export const priceBlockStyle = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
};

export const priceAmountStyle = {
    fontSize: 36,
    fontWeight: 700,
    color: BRAND.text,
    letterSpacing: '-0.01em',
};

export const priceSuffixStyle = {
    fontSize: 15,
    color: BRAND.muted,
    fontWeight: 500,
};

export const trialBadgeStyle = {
    alignSelf: 'flex-start',
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 999,
    background: BRAND.badgeBg,
    color: BRAND.badgeText,
};

export const descriptionStyle = {
    fontSize: 14,
    lineHeight: 1.6,
    color: BRAND.text,
    margin: 0,
};

export const listStyle: React.CSSProperties = {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
};

export const listItemStyle = {
    fontSize: 14,
    lineHeight: 1.5,
    color: BRAND.text,
};

export const planCtaStyle: React.CSSProperties = {
    marginTop: 'auto',
    background: BRAND.primary,
    color: '#1F2937',
    padding: '12px 18px',
    borderRadius: 8,
    textDecoration: 'none',
    fontWeight: 600,
    fontSize: 15,
    textAlign: 'center',
};

export const emptyStyle: React.CSSProperties = {
    textAlign: 'center',
    padding: '64px 24px',
    border: `1px dashed ${BRAND.border}`,
    borderRadius: 14,
    background: BRAND.soft,
};

export const emptyTitle = {
    fontSize: 18,
    fontWeight: 600,
    margin: '0 0 8px',
    color: BRAND.text,
};

export const emptyBody = {
    fontSize: 15,
    color: BRAND.muted,
    margin: 0,
};

export const emptyLink = {
    color: BRAND.primary,
    textDecoration: 'underline',
    fontWeight: 500,
};

export const footerStyle = {
    borderTop: `1px solid ${BRAND.border}`,
    background: BRAND.soft,
    padding: '24px',
};

export const footerInner: React.CSSProperties = {
    maxWidth: 1080,
    margin: '0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: 14,
    flexWrap: 'wrap',
    gap: 12,
};

export const footerNav = {
    display: 'flex',
    gap: 20,
};

export const footerLinkStyle = {
    color: BRAND.text,
    textDecoration: 'none',
    fontWeight: 500,
};

export const cssRules = `
@media (max-width: 600px) {
    h1[data-pricing-title] { font-size: 32px !important; }
}
`;
