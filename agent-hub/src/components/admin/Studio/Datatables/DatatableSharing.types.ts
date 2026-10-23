import type { DtTable } from './rowBrowser/rowBrowserModel';
import type { DirectoryEntry } from '../AppStudio/rbac/useAppRoles';
import type React from 'react';
import type { TranslateParams } from '../../../../hooks/useTranslation';
import type { DatatableGrant } from './grants';

/**
 * Who can read this table, and — SEPARATELY — who can change it
 * (Datatables artboard 1f, "Tab · Delen").
 *
 * The separation is the whole design. On the server an empty `shared_groups`
 * on a published table means the ENTIRE ORGANISATION (auth/audience.js), so if
 * one setting governed both, "share this with the company" would silently mean
 * "let the company delete rows". Reading is the audience; writing is either an
 * explicit invitation list or a deliberate second choice to open it to that
 * same audience. The consequence sentence below always states both, and never
 * softens the loud combination.
 *
 * ── THE ARTBOARD'S LIST, OVER THE TWO-AXIS MODEL ────────────────────
 * 1f draws one list of rows with a role dropdown each: "Everyone in the
 * organisation → may read", "Team Finance → may read and change", the owner.
 * That reading is adopted for the SHAPE — a card of rows, a 28px tile, a
 * subtitle, the invite affordance at the foot — but not for the CONTROL. A
 * single "no access / read / read and change" dropdown on the organisation
 * row would collapse the two axes back into one: it cannot express
 * "published to everyone, writable only by the people I invited", which is
 * the default this whole section exists to protect, and the two rows of the
 * dropdown that DO map onto it ({org, grants} and {org, audience}) would hide
 * the write decision inside a menu instead of asking for it. So the audience
 * stays three real radios in one fieldset (one choice, three mutually
 * exclusive answers — `aria-pressed` buttons announced a single setting as
 * three independent toggles), and the write axis stays its own labelled tick.
 *
 * Sharing is also the licence boundary — reading and writing rows on a table
 * you already hold a grade on stays free, so a lapsed licence can never turn a
 * nightly automation into a hole in the org's data. A 402 here therefore reads
 * as "this is the paid part", not as a failure.
 *
 * WIDENING ASKS, NARROWING DOES NOT. Going private → groups, private →
 * organisation, groups → organisation, or turning on write-by-audience each
 * hand real people access they did not have a second ago, so each goes through
 * a confirmation that names WHO and WHAT. Taking access away stays one click:
 * making "stop sharing this" slower than starting to share it is backwards.
 */
/** The datatable as the sharing panel reads it. */
export interface SharedTable extends DtTable {
    name?: string;
    scopeKind?: string;
    isPublished?: boolean;
    sharedGroups?: string[] | null;
    writeMode?: string;
    ownerUserId?: string;
}

/** A person or group of the directory, with the e-mail a person has. */
export type Principal = DirectoryEntry & { email?: string };

/** What a failed request carries besides its message. */
export interface RequestError {
    status?: number;
    code?: string | null;
}

export interface DatatableSharingProps {
    table: SharedTable;
    canEdit: boolean;
    onChanged: () => Promise<void>;
}

export interface OrgSharingProps {
    table: SharedTable;
    canEdit: boolean;
    onChanged: () => Promise<void>;
}

/** One row of the audience card: a real radio, a tile, a title and a sentence. */
export interface AudienceRowProps {
    icon: React.JSX.Element;
    title: string;
    description: string;
    checked: boolean;
    onSelect: () => void | Promise<void>;
    last?: boolean;
}

/**
 * Says what the two settings TOGETHER mean, in one sentence each — the foot
 * of the audience card (2c has no second banner), warning-tinted only when
 * the setting is the widest there is.
 */
export interface ConsequenceLineProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    access: { readers: string; writers: string; audience: string; broad: boolean };
}

/**
 * The people and teams invited by name — the artboard's row list, with the
 * owner at the foot of it.
 *
 * The owner row is not a control: ownership is not a grade you can hand over
 * from here, and a dropdown that looked like one would be a promise the API
 * does not keep.
 */
export interface GrantListProps {
    table: SharedTable;
    grants: DatatableGrant[];
    canEdit: boolean;
    directory: { groups: Principal[]; users: Principal[]; isLoading: boolean; available: boolean; };
    onChanged: () => Promise<void>;
    onPaywalled: () => void;
}

/** Initials in a 28px tile — a person or a team, never a fetched photo. */
export interface AvatarProps {
    name: string;
    group?: boolean;
}
