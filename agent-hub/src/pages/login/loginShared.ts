import type { Dispatch, SetStateAction } from 'react';
import { PII_CATEGORIES } from '../../config/piiCategories';
import type { SignupData } from './signupValidation';

/** The page's `onLogin` prop: the user the server returned, plus a recovery key when one was minted. */
export type OnLogin = (user: unknown, recoveryKey?: string) => void;

/** A plain state setter (a value, not an updater). */
export type Setter<T> = (value: T) => void;

/** A state setter that also takes an updater function. */
export type StateSetter<T> = Dispatch<SetStateAction<T>>;

/** What a `/auth/*` login-shaped answer may carry; every field is optional on purpose. */
export interface AuthAnswer {
    success?: boolean;
    user?: unknown;
    recoveryKey?: string;
    error?: string;
    code?: string;
    useOpaque?: boolean;
    mfaRequired?: boolean;
    mfaMethods?: unknown;
    emailVerificationRequired?: boolean;
}

// Default Privacy-Shield selection for a new org: all PII categories on,
// block on detection. The wizard's All/None lets the founder pare it down.
export const DEFAULT_PII_CATEGORIES: string[] = PII_CATEGORIES.map(c => c.id);

/** Signup mode starts on for a ?signup=1 or ?invite= deep link. */
export function initialSignupMode(search: string): boolean {
    const params = new URLSearchParams(search);
    if (params.get('signup') === '1' || params.get('invite')) {
        return true;
    }
    return false;
}

/** The signup form as it starts out; a ?plan=<id> / ?type=consumer deep link preselects. */
export function initialSignupData(search: string): SignupData {
    // A ?plan=<id> deep link (from the pricing page) preselects that plan.
    // It is validated against the fetched plan list and dropped if it
    // does not match: an unknown id must not reach checkout.
    const params = new URLSearchParams(search);
    const type = params.get('type') === 'consumer' ? 'consumer' : 'new';
    return {
        username: '', password: '', confirmPassword: '', firstName: '', lastName: '', email: '',
        signupType: type, organizationId: '',
        newOrgName: '', orgTagline: '', orgDescription: '', orgAddress: '', orgEmail: '', orgPhone: '', orgWebsite: '', orgKvk: '', orgVat: '', orgCountry: '', orgAllowSignup: false,
        authMethod: '', shieldEnabled: true, piiCategories: DEFAULT_PII_CATEGORIES, piiAction: 'block', euModeEnabled: false,
        selectedPlanId: params.get('plan') || null,
    };
}

/** The signup form after "back": same as a fresh start but without `orgCountry` and `selectedPlanId` keys. */
export type ClearedSignupData = Omit<SignupData, 'orgCountry' | 'selectedPlanId'>;

export function clearedSignupData(): ClearedSignupData {
    return {
        username: '', password: '', confirmPassword: '', firstName: '', lastName: '', email: '',
        signupType: 'new', organizationId: '',
        newOrgName: '', orgTagline: '', orgDescription: '', orgAddress: '', orgEmail: '', orgPhone: '', orgWebsite: '', orgKvk: '', orgVat: '', orgAllowSignup: false,
        authMethod: '', shieldEnabled: true, piiCategories: DEFAULT_PII_CATEGORIES, piiAction: 'block', euModeEnabled: false,
    };
}

export const INPUT_CLASS = "w-full pl-10 pr-4 py-3 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] focus:border-transparent transition-all";
export const INPUT_CLASS_SIMPLE = "w-full px-4 py-3 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] focus:border-transparent transition-all text-sm";
export const LABEL_CLASS = "block text-sm font-medium text-[var(--text-secondary)] mb-1.5";
