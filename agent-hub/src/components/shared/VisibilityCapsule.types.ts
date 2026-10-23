import type { ReactNode } from 'react';
import type { TranslateFn } from '../../hooks/useTranslation';

// The shapes VisibilityCapsule.tsx and AudienceRows.tsx share, kept apart so the
// component stays under its size ceiling.

export type AudienceMode = 'personal' | 'org' | 'groups';

/** One entry of the org's group directory (useOrgDirectory). */
export interface OrgGroup {
    id: string;
    name?: string;
}

/** id → display name, as an object or a Map. */
export type GroupNames = Record<string, string> | Map<string, string>;

/** The thing being shared; its name is used in the confirm sentence. */
export interface AudienceEntity {
    id?: string;
    name?: string;
    title?: string;
}

export type GroupNamer = (id: string) => string;

export interface AudienceActionsOptions {
    t: TranslateFn;
    entity?: AudienceEntity | null;
    mode: AudienceMode;
    sharedGroups?: unknown;
    nameOf?: GroupNamer | null;
    confirmWidening?: boolean;
    onSetPersonal?: (() => void) | null;
    onSetEntireOrg?: (() => void) | null;
    onToggleGroup?: ((groupId: string) => void) | null;
    /** What to do when the LAST group is unticked; default is `onSetPersonal`. */
    onLastGroup?: (() => void) | null;
}

/** The props the capsule and AudienceRows have in common. */
export interface AudienceProps {
    /** translator; falls back to useTranslation() */
    t?: TranslateFn;
    agent?: AudienceEntity | null;
    isPublished?: boolean;
    sharedGroups?: string[] | null;
    orgGroups?: readonly OrgGroup[];
    /** overrides orgGroups for labels */
    groupNames?: GroupNames | null;
    onSetPersonal?: (() => void) | null;
    onSetEntireOrg?: (() => void) | null;
    onToggleGroup?: ((groupId: string) => void) | null;
    confirmWidening?: boolean;
    disabled?: boolean;
    className?: string;
}

export interface GroupChecklistProps {
    t: TranslateFn;
    orgGroups?: readonly OrgGroup[];
    groupsUnavailable?: boolean;
    sharedGroups?: string[];
    onToggle?: (groupId: string) => void;
    disabled?: boolean;
    className?: string;
}

/**
 * Props (all optional except the state pair and the callbacks):
 *   t                  translator; falls back to useTranslation()
 *   agent              the entity (its `name` is used in the confirm sentence)
 *   open / onToggle / onClose   menu state, owned by the caller
 *   isPublished, sharedGroups   the server's audience pair
 *   onSetPersonal / onSetEntireOrg / onToggleGroup(groupId)
 *   orgGroups          [{id, name}] — the org directory (useOrgDirectory)
 *   groupsUnavailable  that directory could not be READ. An empty list and a
 *                      failed read look identical on screen, and the panel
 *                      would simply drop the "Or specific groups" section —
 *                      indistinguishable from an org that has no groups. Set
 *                      it and the panel SAYS so instead
 *   onRetryGroups      re-ask, offered next to that sentence
 *   groupNames         Record<id, name> | Map — overrides orgGroups for labels
 *   embedEnabled       shows the "web embed is on" hint (agents)
 *   extraSection       extension slot under the options (webpages' share links)
 *   variant            'pill' | 'capsule'
 *   anchored           portal the panel through AnchoredMenu
 *   confirmWidening    ask before widening the audience
 *   disabled           trigger disabled (read-only viewers)
 */
export interface VisibilityCapsuleProps extends AudienceProps {
    open?: boolean;
    onToggle?: () => void;
    onClose?: (() => void) | null;
    embedEnabled?: boolean;
    /** the directory could not be READ (not the same as an org without groups) */
    groupsUnavailable?: boolean;
    onRetryGroups?: (() => void) | null;
    extraSection?: ReactNode;
    variant?: 'pill' | 'capsule';
    /** portal the panel through AnchoredMenu */
    anchored?: boolean;
}

export interface AudienceRowsProps extends AudienceProps {
    /** row-group heading */
    title?: ReactNode;
    /** the consequence line under the rows */
    hint?: ReactNode;
}
