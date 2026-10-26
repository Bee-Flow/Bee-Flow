import { useMemo } from 'react';
import { useSignupPlansQuery } from '../../api/queries/sharedReads';
import { plansFor } from '../../components/billing/planModel';
import type { SignupData } from './signupValidation';

const NO_PLANS: never[] = [];

/**
 * Plans offered during signup, filtered to the chosen account type. Public
 * endpoint: it must work before the user has an account. Hook order: the plans read, then the two memos.
 */
export function useSignupPlans(signupMode: boolean, signupData: SignupData) {
    const publicPlans = (useSignupPlansQuery(signupMode).data ?? NO_PLANS) as Parameters<typeof plansFor>[0];

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
