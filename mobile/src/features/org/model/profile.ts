/**
 * Organisation Info and Sign-in Method, as the web edits them
 * (orgInfo/OrgInfoSection.jsx, OrgAuthSection.jsx, orgInfoShared.jsx).
 */

import type { Organization } from './types';

/** The thirteen text fields of Organisation Info, in the web's order. */
export const PROFILE_FIELDS = [
    'name',
    'tagline',
    'description',
    'email',
    'phone',
    'website',
    'address',
    'billingLine2',
    'billingPostalCode',
    'billingCity',
    'billingCountry',
    'kvk',
    'vat',
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type ProfileForm = Record<ProfileField, string>;

/** The record as the form edits it: an absent field is an empty one, as on the web. */
export function profileFormOf(org: Organization): ProfileForm {
    const form = {} as ProfileForm;
    for (const key of PROFILE_FIELDS) form[key] = org[key] ?? '';
    return form;
}

/** The web's AUTH_METHODS ids, in its order. */
export const AUTH_METHOD_IDS = ['password', 'google', 'microsoft'] as const;
export type AuthMethodId = (typeof AUTH_METHOD_IDS)[number];

/** orgInfoShared.jsx AllowedDomainsEditor, and the same test on the server (orgRoutes.js). */
export const DOMAIN_RX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;

export function normalizeDomain(raw: string): string {
    return raw.trim().toLowerCase();
}

export function isValidDomain(domain: string): boolean {
    return DOMAIN_RX.test(domain);
}

/** A stored image (logo, avatar): a server-relative path is resolved against the server; absolute URLs pass through. */
export function serverImageUri(logo: string | null | undefined, resolve: (path: string) => string): string | null {
    if (!logo) return null;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an anchored alternation of literal prefixes with no quantifier
    if (/^(https?:|data:)/.test(logo)) return logo;
    try {
        return resolve(logo.startsWith('/') ? logo : `/${logo}`);
    } catch {
        return null;
    }
}
