import type { LucideIcon } from 'lucide-react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { PickerData, PickerRow } from './useSkillPickerData';

export interface CanUseCardProps {
    enabledIntegrations?: string[] | null;
    allowedAutomationIds?: string[] | null;
    knowledgeBaseIds?: string[] | null;
    dynamicActivation?: boolean;
    legacyAutomationId?: string | null;
    automations?: PickerRow[];
    knowledgeBases?: PickerRow[];
    listStatus?: Partial<PickerData> | null;
    onChange: (patch: Record<string, unknown>) => void;
    readOnly?: boolean;
}

export interface PillProps {
    testid: string;
    kind: string;
    Icon: LucideIcon;
    color: string;
    label: string;
    onRemove: (() => void) | null;
    t: TranslateFn;
}

export interface MenuStatusProps {
    t: TranslateFn;
    loaded: boolean;
    gap: boolean;
    empty: boolean;
}
