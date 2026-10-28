import type { LucideIcon } from 'lucide-react';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { SkillDraft } from './skillModel.types';
import type { ListStatus, PickerAutomation, PickerKnowledgeBase } from './useSkillPickerData';

export interface CanUseCardProps {
    enabledIntegrations?: string[] | null;
    allowedAutomationIds?: string[] | null;
    knowledgeBaseIds?: string[] | null;
    dynamicActivation?: boolean;
    legacyAutomationId?: string | null;
    automations?: PickerAutomation[];
    knowledgeBases?: PickerKnowledgeBase[];
    listStatus?: ListStatus | null;
    onChange: (patch: Partial<SkillDraft>) => void;
    readOnly?: boolean;
}

/** One chip of the grant row. */
export interface PillProps {
    testid: string;
    kind: string;
    Icon: LucideIcon;
    color: string;
    label: string | number;
    onRemove: (() => void) | null;
    t: TranslateFn;
}

/** One entry of the link menu. */
export interface Pickable { group: 'automation' | 'kb'; id: string; label: string | number }
