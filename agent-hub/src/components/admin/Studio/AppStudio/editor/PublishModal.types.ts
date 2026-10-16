import type { CSSProperties, ReactNode } from 'react';
import type { DryRunIssue } from './dryRunIssues';
import type { HeaderApp } from './header/headerModel';
import type { AppDefinition } from '../inspector/appDefinition';

// Re-exported so PublishModal.tsx takes all its types from one import: the file is at its line ceiling.
export type { TranslateFn } from '../../../../../hooks/useTranslation';

/** The issues the server's refusal or the dry run lists, split by weight. */
export interface Findings {
    errors: DryRunIssue[];
    warnings: DryRunIssue[];
}

/** A component or screen a "Show me" can jump to. */
export interface IssueTarget {
    screenId?: string;
    screenName?: string;
    nodeId?: string | null;
}

/** What a publish asks the server for: private, org-wide, or specific groups. */
export interface PublishPayload {
    isPublished: boolean;
    sharedGroups?: string[];
}

export interface PublishModalProps {
    open: boolean;
    onClose?: () => void;
    app: HeaderApp;
    onPublished?: (app: HeaderApp) => void;
    definition?: AppDefinition | null;
    onRevealNode?: (target: { nodeId?: string | null; screenId?: string }) => void;
    managed?: boolean;
}

export interface BlockerListProps {
    errors: DryRunIssue[];
    warnings: DryRunIssue[];
    revealTarget: (issue: DryRunIssue) => IssueTarget | null;
    onReveal: (target: IssueTarget) => void;
    context?: 'publish' | 'check';
}

export interface IssuePanelProps {
    issues: DryRunIssue[];
    icon: ReactNode;
    title: string;
    note: string;
    panelStyle: CSSProperties;
    revealTarget: (issue: DryRunIssue) => IssueTarget | null;
    onReveal: (target: IssueTarget) => void;
}

export interface IssueRowProps {
    issue: DryRunIssue;
    target: IssueTarget | null;
    onReveal: (target: IssueTarget) => void;
}
