/**
 * The billing-country picker's list: a port of the web's COUNTRIES
 * (agent-hub/src/components/admin/subscriptions/access/countries.ts), ISO
 * 3166-1 alpha-2 codes with English names, in the web's order. The code is
 * what PUT /auth/organizations/:id stores as `billingCountry`.
 * The list itself is a generated copy of the web file (shared-mirror
 * manifest), so it cannot drift.
 */

import { COUNTRIES as WEB_COUNTRIES } from '../mirror/countries';

export interface Country {
    code: string;
    name: string;
}

export const COUNTRIES: readonly Country[] = WEB_COUNTRIES;

/** The name for a stored code; the code itself when this list does not know it. */
export function countryName(code: string | undefined): string {
    if (!code) return '';
    return COUNTRIES.find((c) => c.code === code)?.name ?? code;
}
