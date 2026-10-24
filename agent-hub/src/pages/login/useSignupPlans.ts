import { useState, useEffect, useMemo } from 'react';
import { plansFor } from '../../components/billing/planModel';
import { getPublicPlans } from './loginRequests';
import type { SignupData } from './signupValidation';
import { logger } from '../../utils/logger';

/**
 * Plans offered during signup, filtered to the chosen account type. Public
 * endpoint: it must work before the user has an account. Hook order: one
 * useState, then one effect, then the two memos.
 */
export function useSignupPlans(signupMode: boolean, signupData: SignupData) {
    const [publicPlans, setPublicPlans] = useState<Parameters<typeof plansFor>[0]>([]);

    useEffect(() => {
        if (!signupMode) return undefined;
        const ac = new AbortController();
        (async () => {
            try {
                const res = await getPublicPlans(ac.signal);
                if (!res.ok) return;
                const data: { plans?: unknown } = await res.json();
                setPublicPlans(Array.isArray(data?.plans) ? data.plans : []);
            } catch (err) { logger.debug('plan step is optional: signup proceeds without it', err); }
        })();
        return () => ac.abort();
    }, [signupMode]);

    const availablePlans = useMemo(
        () => plansFor(publicPlans, signupData.signupType === 'consumer' ? 'consumer' : 'organization'),
        [publicPlans, signupData.signupType],
    );

    // A ?plan= id only counts once it matches a plan this account type can buy.
    // Derived rather than written back into state: switching between an
    // organisation and a personal account changes the eligible list, and storing
    // the filtered value would fight that on every toggle.
    const selectedPlanId = useMemo(() => {
        const id = signupData.selectedPlanId;
        if (!id) return null;
        return availablePlans.some(p => p.id === id) ? id : null;
    }, [availablePlans, signupData.selectedPlanId]);

    return { availablePlans, selectedPlanId };
}
