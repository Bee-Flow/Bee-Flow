// Prop types of AgentEditorHeader, kept apart so the header stays under the file budget.

import type { managedOf } from '../../../shared/managedPart';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { SaveState } from './SaveStateIndicator';
import type { ReactNode } from 'react';

/** The managed-part record the header and its banner read (see shared/managedPart). */
export type ManagedInfo = ReturnType<typeof managedOf>;

export interface AgentHeaderAgent {
    id?: string | null;
    [key: string]: unknown;
}

export interface AgentEditorHeaderProps {
    t: TranslateFn;
    ro?: boolean;
    managed?: ManagedInfo | null;
    agent?: AgentHeaderAgent | null;
    name?: string;
    avatar?: string | null;
    onBack?: () => void;
    onRename?: (value: string) => void;
    tabs?: { id: string; label: string; icon?: unknown; count?: number | undefined }[];
    activeTab?: string;
    onTab?: (id: string) => void;
    savingState?: SaveState | null;
    savedAt?: Date | null;
    saveErrorMsg?: string | null;
    onRetrySave?: () => void;
    saveDraft?: () => void;
    publishedVersion?: number;
    onPublishVersion?: () => void;
    publishing?: boolean;
    capsuleOpen?: boolean;
    onCapsuleToggle?: () => void;
    onCapsuleClose?: () => void;
    isPublished?: boolean;
    sharedGroups?: string[];
    orgGroups?: readonly { id: string; name?: string | null }[];
    embedEnabled?: boolean;
    onSetPersonal?: () => void;
    onSetEntireOrg?: () => void;
    onToggleGroup?: (groupId: string) => void;
    extras?: ReactNode;
}
