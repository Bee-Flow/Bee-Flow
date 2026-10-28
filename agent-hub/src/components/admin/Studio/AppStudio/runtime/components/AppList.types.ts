import type { TranslateParams } from '@/hooks/useTranslation';
import type { BindingInput } from '../resolveBinding.types';
import type { PeekGroupLabel } from '../listPeek';

export interface PeekPanelOpts {
    peekTitle: string | null;
    peekTitleKey: string | null;
    peekTextKey: string | null;
    peekLimit: number;
    peekMoreText: string | null;
    showGroups: boolean;
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
}

export interface ListProps {
    source?: BindingInput;
    peekSource?: BindingInput;
    titleKey?: string;
    subtitleKey?: string | null;
    metaKey?: string | null;
    timestampKey?: string | null;
    badgeKey?: string | null;
    badgeToneMap?: PeekGroupLabel[];
    unreadKey?: string | null;
    badgePlacement?: string;
    selectedWhen?: string | null;
    selectedDetailKey?: string | null;
    groupKey?: string | null;
    groupOrder?: unknown[];
    groupLabelMap?: PeekGroupLabel[];
    icon?: string | null;
    emptyText?: string;
    look?: string;
    peekMatchKey?: string | null;
    peekRowKey?: string | null;
    peekTitleKey?: string | null;
    peekTextKey?: string | null;
    peekGroupKey?: string | null;
    peekGroupLabelMap?: PeekGroupLabel[];
    peekCountKey?: string | null;
    peekLimit?: number;
    peekTitle?: string | null;
    peekMoreText?: string | null;
    peekBadge?: boolean;
}
