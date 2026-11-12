import type { Dispatch, SetStateAction } from 'react';
import { PII_CATEGORIES } from '../../config/piiCategories';
import type { SignupData } from './signupValidation';

/** The page's `onLogin` prop: the user the server returned, plus a recovery key when one was minted. */
export type OnLogin = { bivarianceHack(user: unknown, recoveryKey?: string): void }['bivarianceHack'];

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
    mfaMethods?: string[];
    emailVerificationRequired?: boolean;
}

// Default Privacy-Shield selection for a new org: all PII categories on,
// block on detection. The wizard's All/None lets the founder pare it down.
const DEFAULT_PII_CATEGORIES: string[] = PII_CATEGORIES.map(c => c.id);

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

// One look for every sign-in screen (login, MFA, password reset, signup, verify):
// the theme's own surfaces, and honey only on the primary action.
const FIELD = "bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-md text-[var(--text-primary)] placeholder-[var(--text-tertiary)] hover:border-[var(--text-tertiary)] focus:outline-none focus:border-[var(--text-primary)] focus:ring-2 focus:ring-[var(--focus-ring)] transition-colors";
export const INPUT_CLASS = `w-full pl-10 pr-4 py-2.5 ${FIELD}`;
export const INPUT_CLASS_SIMPLE = `w-full px-4 py-2.5 text-sm ${FIELD}`;
export const LABEL_CLASS = "block text-sm font-medium text-[var(--text-primary)] mb-1.5";

/** The page behind the card. */
export const LOGIN_PAGE_CLASS = "min-h-screen flex items-center justify-center p-4 relative bg-[var(--bg-primary)]";
/** The card every sign-in screen sits in. */
export const LOGIN_CARD_CLASS = "relative rounded-xl p-6 sm:p-8 border bg-[var(--bg-card)] border-[var(--border-default)] shadow-[var(--shadow-lg)] backdrop-blur-xl";
/** The one honey button: the action that moves the sign-in forward. */
export const PRIMARY_BUTTON_CLASS = "w-full py-2.5 px-4 rounded-md text-base font-semibold bg-amber-400 hover:bg-amber-500 active:bg-amber-500 text-stone-950 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-[var(--bg-card)]";
/** Every other button: another way to sign in, creating an account. */
export const SECONDARY_BUTTON_CLASS = "w-full py-2.5 px-4 rounded-md font-medium bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border-default)] transition-colors flex items-center justify-center gap-2.5 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]";
/** A quiet text action under a form (back, another method). */
export const LINK_BUTTON_CLASS = "w-full py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex items-center justify-center gap-1.5 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]";
