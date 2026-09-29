import { useEffect } from 'react';
import { MOBILE_ALLOWED_PAGES, isApprovalsStudioPath } from './appRoutes';
import { useLicenseContext } from '../components/licensing/LicenseContext';
import { useSubscriptionContext } from '../components/licensing/SubscriptionContext';

/**
 * Invisible app-shell gate. When the org has no active subscription
 * (status !== 'active' / 'trialing'), force navigate to the License &
 * Usage page so the admin can buy one. Skips for the hardcoded platform
 * operator and for consumer accounts (no orgId).
 */
// Null-rendering guard (same pattern as SubscriptionGate) that enforces the
// mobile allow-list for cases navigateToPage can't intercept: a hard deep-link
// or refresh onto a disallowed URL, and the viewport becoming mobile (resize/
// rotate) while sitting on a disallowed page. Idempotent — once it lands on
// 'agents' the condition is false. Mounted only under isAuthenticated, so it
// never runs for the embed/CMS/legal/pricing routes that return earlier.
export function MobileRouteGuard({ isMobile, currentPage, navigateToPage }) {
    useEffect(() => {
        if (!isMobile || MOBILE_ALLOWED_PAGES.has(currentPage)) return;
        // The one Studio slice that must work on a phone: the approval a bell
        // notification just linked to. Deciding from wherever you are is the
        // point of assignable approvals; ApprovalsStudio renders single-column
        // on small screens. Everything else in Studio stays desktop-only.
        // isApprovalsStudioPath comes from appRoutes.js, where mobilePageKey
        // reads the same slice: this file used to keep its own copy of the
        // regex, and two files knowing the same thing about a frozen path is
        // how one of them ends up wrong.
        if (currentPage === 'studio' && isApprovalsStudioPath(window.location.pathname)) return;
        navigateToPage('agents');
    }, [isMobile, currentPage, navigateToPage]);
    return null;
}

export function SubscriptionGate({ user, currentPage, deploymentMode, navigateToPage }) {
    const { hasActiveSub, loading } = useSubscriptionContext();
    const { serverOverride, loading: licLoading } = useLicenseContext();
    const isPlatformOperator = user?.id === 'admin';
    const isConsumer = !(user?.organizationId || user?.orgId);
    const isSelfHosted = deploymentMode === 'self-hosted';

    useEffect(() => {
        // Wait for BOTH the subscription and licence probes before deciding,
        // so a server-licensed install isn't briefly redirected on first load.
        if (loading || licLoading || hasActiveSub) return;
        // A server-wide licence covers the whole install — the licence is
        // authoritative, no Stripe subscription is required (mirrors the
        // backend bypass in server/core/limits.js).
        if (isPlatformOperator || isConsumer || isSelfHosted || serverOverride) return;
        // Already on the License & Usage page (or its loading path) — let
        // it render so the admin can finish the checkout flow. Stripe
        // bounces back to the same URL with `?checkout=success`; allow
        // those query strings too.
        const path = window.location.pathname;
        const onLicensePage = path === '/app/settings/organisation/license'
            || path.startsWith('/app/settings/organisation/license');
        if (onLicensePage) return;
        navigateToPage('settings/organisation/license');
    }, [loading, licLoading, hasActiveSub, isPlatformOperator, isConsumer, isSelfHosted, serverOverride, currentPage, navigateToPage]);

    return null;
}
