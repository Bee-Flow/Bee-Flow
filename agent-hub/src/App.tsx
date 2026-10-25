import { Suspense } from 'react';
import { shouldWarmAuthedApp } from './utils/warmup';
import { AppRoutes } from './AppRoutes';
// Warm-up: a signed-in user landing on /app — or the SPA booting inside
// Nextcloud, where the pathname is NC's proxy route — should not pay for the
// lazy boundary with a serial round trip: start fetching the app chunk AND
// the i18n catalogue while React is still mounting. Marketing paths skip
// both. Path matching lives in utils/warmup so the embed variants stay
// covered by tests.
if (typeof window !== 'undefined' && shouldWarmAuthedApp(window.location.pathname)) {
    import('./AuthedApp');
    ensureI18nDefaults();
}

import { ensureI18nDefaults } from './hooks/useTranslation';
import type { AnalyticsConfig, SiteContent } from './marketing/ProductWebsite.types';

/* Matches the shell background painted by index.html, so a chunk fetch never
   shows through as white. AuthedApp.jsx carries its own copy — importing
   across the boundary would defeat the split. */
function AppBackdrop() {
    return <div className="[background:#06090F] min-h-[100vh]" />;
}

// Root wrapper — handles embed route before App's hooks
function AppRoot() {
    /* One boundary around every branch below. Several of them (the embed,
       AuthedApp) resolve lazy chunks, and returning a bare lazy element from a
       component with no Suspense above it throws. */
    return (
        <Suspense fallback={<AppBackdrop />}>
            <AppRoutes />
        </Suspense>
    );
}

export default AppRoot;
