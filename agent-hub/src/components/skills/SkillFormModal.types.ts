import type { TranslateParams } from '../../hooks/useTranslation';
import type { Skill } from '../../hooks/useSkills';
import type { SkillRecord } from './SkillCard';
import type { OrgGroup } from '../../api/queries/orgGroups';

export type TextTab = 'instructions' | 'workflow' | 'rules' | 'examples';

export interface FormState {
    name: string;
    description: string;
    instructions: string;
    workflow: string;
    rules: string;
    examples: string;
    icon: string;
    isShared: boolean;
    dynamicActivation: boolean;
    sharedGroups: string[];
}

export interface CharCountProps {
    value: string;
    limit: number;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface SkillFormModalProps {
    skill: Skill | SkillRecord | null;
    onSave: (body: Record<string, unknown>) => unknown;
    groups?: OrgGroup[];
    orgId?: string | null;
    user?: { id?: string | number; organizationId?: string | null } | null;
    onCancel: () => void;
    saving: boolean;
}
