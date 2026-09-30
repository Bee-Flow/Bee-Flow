/**
 * The Studio registry's shapes: a port of the descriptor in
 * agent-hub/src/components/admin/Studio/studioApps.jsx, minus what only a
 * browser can hold (the lazy component, its props) and plus what only a phone
 * needs (where each section opens here).
 */

import type { LockReason } from '@/core/access';
import type { IconName, KindKey } from '@/shared/ui';

/** STUDIO_CATEGORIES ids: the sidebar's headings, in order. */
export type StudioCategoryId = 'build' | 'ai' | 'bundle' | 'modules';

export interface StudioCategory {
    id: StudioCategoryId;
    labelKey: string;
    labelFallback: string;
}

/** The web's section ids (studioApps.jsx `id`), which the counts and search name too. */
export type StudioSectionId =
    | 'agents'
    | 'skills'
    | 'knowledge'
    | 'aiTasks'
    | 'approvals'
    | 'datatables'
    | 'webpages'
    | 'documents'
    | 'apps'
    | 'forms'
    | 'playbooks'
    | 'solutions'
    | 'runs'
    | 'meetingNotes';

/**
 * The web's `gate(ctx)` as data. Every id in every list must pass:
 *
 *   license  hasLicenseFeature(id)  does this INSTALLATION have it
 *   canUse   canUse(id)             is this ORGANISATION in the programme
 *   can      can(id)                the effective entitlement set
 *   perms    hasPermission(id)      may this PERSON reach it (org role)
 *
 * An empty requirement is the web's `gate: () => true`.
 */
export interface StudioRequirements {
    license?: readonly string[];
    canUse?: readonly string[];
    can?: readonly string[];
    perms?: readonly string[];
}

/**
 * Where a section (or one of its objects) opens on the phone.
 *
 *   route  a native screen; `detail` opens one object by the id the web's
 *          `/app/studio/<segment>/<id>` carries, when the phone has that screen
 *   web    a section only the web has, at the server's `path`: no built-in
 *          section uses it; it remains for a section a later web release
 *          adds. The phone opens the Studio hub for it (model/links.ts), as
 *          its deep link does — never a browser tab, which the web's Studio
 *          turns away on a phone
 */
export type StudioTarget =
    | { kind: 'route'; href: string; detail?: (id: string) => string }
    | { kind: 'web'; path: string };

/** A section's entry in the "New" menu (the web's `create`). */
export interface StudioCreate {
    labelKey: string;
    labelFallback: string;
    /**
     * Where "new" goes: the list screen that hosts the phone's create flow,
     * or — for a kind with no mobile builder — the web's own `…/new` address.
     */
    target: StudioTarget;
}

export interface StudioSection {
    id: StudioSectionId;
    /** The canonical `/app/studio/<segment>`. */
    segment: string;
    /** Older segments the web still accepts for this section (`legacySegments`). */
    legacySegments?: readonly string[];
    category: StudioCategoryId;
    labelKey: string;
    labelFallback: string;
    descKey: string;
    descFallback: string;
    /** The web descriptor's lucide `Icon`, by name. */
    icon: IconName;
    /** kindColors.js key; null for a section that is not a kind (Approvals, Runs). */
    kind: KindKey | null;
    /** The key in GET /api/studio/counts (the web's `countKey || id`). */
    countKey: string;
    requires: StudioRequirements;
    /** The entitlement a failed gate is asked about (`lockReason`). */
    gateCapability: string | null;
    /** `disable` shows a licence/capability-locked section locked; `hide` removes it. */
    lockOn: 'hide' | 'disable';
    /** Routable, but not a row in the Studio group (Approvals has its own). */
    hiddenFromNav: boolean;
    create: StudioCreate | null;
    target: StudioTarget;
}

/** A section as a person sees it: gate passed, or shown locked with the reason. */
export interface ResolvedSection extends StudioSection {
    locked: LockReason | null;
}

export interface StudioGroup {
    category: StudioCategory;
    sections: ResolvedSection[];
}

/**
 * A row of the hub's Workspace group — Cowork, Apps, Forms, Notebooks: the
 * things a member uses rather than builds. Handed to the hub by its host
 * (features/shell), already worded and already gated, because deciding them
 * reads features Studio must not import.
 */
export interface HubLink {
    id: string;
    icon: IconName;
    label: string;
    description: string;
    count?: number | null;
    href: string;
}
