// The licence tier the dashboard's gates read: a read that fails (a 429 on a
// fast reload, a dropped connection) or is still out never takes rail rows away
// that the last answer gave.
import { renderHook } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import LicenseContext from '@/components/licensing/LicenseContext';
import { TIER_RANK } from '@/components/licensing/licenseTiers';
import { forgetLicenceTier, useSteadyLicenceTier } from './useSteadyLicenceTier';
import { setCurrentUser } from '@/utils/scopedStorage';

type LicenseValue = React.ComponentProps<typeof LicenseContext.Provider>['value'];

const rankAtLeast = (tier: string) => (required: string) => (TIER_RANK[tier] ?? -1) >= (TIER_RANK[required] ?? 99);

function licence(over: Partial<LicenseValue>): LicenseValue {
    const tier = over.tier ?? 'community';
    return { tier, loading: false, error: null, hasTier: rankAtLeast(tier), ...over } as LicenseValue;
}

function renderTier(initial: Partial<LicenseValue>) {
    let value = licence(initial);
    const wrapper = ({ children }: { children: React.ReactNode }) => <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
    const hook = renderHook(() => useSteadyLicenceTier(), { wrapper });
    return {
        ...hook,
        set(over: Partial<LicenseValue>) {
            value = licence(over);
            hook.rerender();
        },
    };
}

beforeEach(() => {
    window.sessionStorage.clear();
    setCurrentUser('user-a');
});

describe('useSteadyLicenceTier', () => {
    it('reads the tier of an answer as it is', () => {
        const { result } = renderTier({ tier: 'enterprise' });
        expect(result.current.tier).toBe('enterprise');
        expect(result.current.hasTier('enterprise')).toBe(true);
        expect(result.current.pending).toBe(false);
    });

    it('keeps the last answer while a re-read fails (the tier would otherwise read as Community)', () => {
        const hook = renderTier({ tier: 'enterprise' });
        hook.set({ tier: 'community', error: 'HTTP 429' });
        expect(hook.result.current.tier).toBe('enterprise');
        expect(hook.result.current.hasTier('enterprise')).toBe(true);
        expect(hook.result.current.pending).toBe(false);
    });

    it('keeps the last answer of this tab across a full reload whose read fails or is still out', () => {
        renderTier({ tier: 'enterprise' }).unmount();
        const failed = renderTier({ tier: 'community', error: 'HTTP 429' });
        expect(failed.result.current.hasTier('enterprise')).toBe(true);
        failed.unmount();
        const loading = renderTier({ tier: 'community', loading: true });
        expect(loading.result.current.tier).toBe('enterprise');
        expect(loading.result.current.pending).toBe(false);
    });

    it('follows a new answer, also a lower one', () => {
        const hook = renderTier({ tier: 'enterprise' });
        hook.set({ tier: 'community' });
        expect(hook.result.current.hasTier('enterprise')).toBe(false);
        hook.set({ tier: 'community', error: 'HTTP 429' });
        expect(hook.result.current.hasTier('enterprise')).toBe(false);
    });

    // Changed on review: an unknown tier never opens a paid surface (some have no server tier gate);
    // with nothing remembered no tier-gated row was shown, so none can vanish.
    it('reads a failed read with nothing known as the context does (Community), and waits on a first read', () => {
        const failed = renderTier({ tier: 'community', error: 'HTTP 429' });
        expect(failed.result.current.hasTier('enterprise')).toBe(false);
        expect(failed.result.current.pending).toBe(false);
        failed.unmount();
        const loading = renderTier({ tier: 'community', loading: true });
        expect(loading.result.current.hasTier('enterprise')).toBe(false);
        expect(loading.result.current.pending).toBe(true);
    });

    // Logout does not reload the page: the next person to sign in in this tab
    // must never read the tier the previous one's licence answered.
    it('never hands one person\'s remembered tier to the next one who signs in in this tab', () => {
        renderTier({ tier: 'enterprise' }).unmount();
        setCurrentUser('user-b');
        const next = renderTier({ tier: 'community', error: 'HTTP 429' });
        expect(next.result.current.hasTier('enterprise')).toBe(false);
        expect(next.result.current.tier).toBe('community');
    });

    it('forgets the remembered tier on logout (clearSessionCaches)', () => {
        renderTier({ tier: 'enterprise' }).unmount();
        forgetLicenceTier();
        const after = renderTier({ tier: 'community', error: 'HTTP 429' });
        expect(after.result.current.hasTier('enterprise')).toBe(false);
    });
});
