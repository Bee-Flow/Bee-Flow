import type { KnowledgeBase } from './knowledgeApi';
import type { UsageRow } from '../../../../hooks/useUsage';
import type { OrgGroup } from '../../../shared/VisibilityCapsule.types';
import type { TranslateFn } from '../../../../hooks/useTranslation';

export interface SettingsTabProps {
    kb: KnowledgeBase | null;
    usage?: UsageRow[] | null;
    unchecked?: string[];
    currentUserId?: string | null;
    onDeleted?: (() => unknown) | null;
    onDuplicated?: ((copy: { id: string }) => unknown) | null;
    onNavigate?: ((target: string) => void) | null;
    canManage?: boolean;
    orgGroups?: readonly OrgGroup[];
    orgId?: string | null;
    onSaved: () => Promise<void>;
}

/** Name and description. Both commit on blur — a PATCH per keystroke is a PATCH per keystroke. */
export interface NameFieldsProps {
    t: TranslateFn;
    onCommitName: (value: string) => void;
    onCommitDescription: (value: string) => void;
    fieldStyle: { background: string; borderColor: string; color: string; outlineColor: string; };
    name: string;
    description: string;
    setName: (value: string) => void;
    setDescription: (value: string) => void;
    disabled: boolean;
}

/**
 * One surface toggle. Active is the artboard's 2px ink border, drawn the way
 * AudienceRows draws it (1px border + 1px inset ring) so ticking one does not
 * shift the row by a pixel.
 */
export interface SurfaceCardProps {
    id: string;
    active: boolean;
    disabled: boolean;
    attached: number;
    onToggle: () => void;
    t: TranslateFn;
}

/**
 * A base with no organisation cannot be shared at all: publishing refuses it,
 * and every non-owner is turned away before the published flag is even read.
 * Until K5 there was no way out of that state — the only way to share such a
 * base was to build it again inside an organisation.
 */
export interface PersonalNoticeProps {
    t: TranslateFn;
    canMove: boolean;
    onMove: () => Promise<void>;
    busy: boolean;
}
