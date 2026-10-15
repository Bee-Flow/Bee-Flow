// Types for the JavaScript section header, so TypeScript callers see its real
// props (the .jsx infers every destructured prop without a default as required).
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

export const OBJHEAD: string;
export const OBJHEAD_FOLD: Readonly<Record<string, string>>;
export const PRIMARY_ACTION_STYLE: Readonly<CSSProperties>;

export interface SectionHeaderTab {
    id: string;
    label: string;
    count?: number;
}

export interface StudioSectionHeaderProps {
    kind?: string;
    icon?: LucideIcon | null;
    title: string;
    onRename?: (next: string) => void;
    renameRequest?: number;
    statusChip?: ReactNode;
    tabs?: SectionHeaderTab[] | false;
    activeTab?: string | null;
    onTab?: (tabId: string) => void;
    tabsFold?: 'compact' | string;
    titleMin?: boolean;
    capsule?: ReactNode;
    primary?: ReactNode;
    extras?: ReactNode;
    onBack?: () => void;
    backLabel?: string;
    className?: string;
    testId?: string;
}

export default function StudioSectionHeader(props: StudioSectionHeaderProps): ReactElement;
