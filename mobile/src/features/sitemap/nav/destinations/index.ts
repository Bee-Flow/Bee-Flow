/**
 * The app's sitemap — every place a person can go, in one list.
 *
 * This exists as data rather than as JSX because two surfaces use the same
 * set: the A–Z map (/sitemap) and the global search's "places" group, each
 * filtering it by a search string and hiding the entries a given account
 * cannot reach. Hard-coding that twice is how a destination goes missing.
 *
 * The acceptance criterion is that EVERY Bee Flow screen is reachable from
 * here (src/meta/routes.test.ts checks it), so a new screen anywhere in the
 * app is expected to add a row to one of the group files beside this one.
 * Screens owned by other feature modules are linked, never described — the
 * route is the contract.
 */

import type { Destination } from '../types';
import { ACCOUNT } from './account';
import { CONTENT } from './content';
import { HELP } from './help';
import { ORGANISATION } from './organisation';
import { WORKSPACE } from './workspace';

export const DESTINATIONS: Destination[] = [
    ...WORKSPACE,
    ...CONTENT,
    ...ORGANISATION,
    ...ACCOUNT,
    ...HELP,
];
