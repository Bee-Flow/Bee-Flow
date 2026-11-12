import type { TranslateFn } from '@/hooks/useTranslation';
import type { ReadState } from '../agentEditor.types';
import type { ToolApp } from './toolCatalogTypes';
import type { chooserRequest } from './toolChooser';
import type { automationRows } from './toolGrants';

export type { ToolApp, TranslateFn };

/** One app row, as `toolGrants.toolRows` builds it (that module is JavaScript, so the shape is stated here). */
export interface ToolCardRow {
    appId: string;
    label: string;
    granted: '*' | string[];
    grantedNames: string[] | null;
    grantedCount: number | null;
    totalActions: number | null;
    actionsKnown: boolean;
    available: boolean | null;
    availabilityKind: string | null;
    availabilityKinds: string[];
    sends: boolean | null;
    narrowedBy: string[];
    confirm: 'direct' | 'ask';
    confirmLocked: boolean;
    actAsKind: 'user' | 'platform' | 'unknown';
    actAs: 'viewer' | 'owner';
    canActAsOwner: boolean;
    ownerRefused: boolean;
    ownerLendsUncurated: boolean;
    ownerLendingUnset: boolean;
    supportsMailAccess: boolean;
    mailAccess: 'read' | 'draft' | 'send_reply' | null;
    /** Other apps: may a run started by an e-mail use this app? */
    mailRuns: boolean;
    /** Gmail and Outlook: may a reply in the thread also go to the others on the mail? */
    replyAll: boolean;
}
/** One automation grant, as `toolGrants.automationRows` builds it. */
export type AutomationCardRow = ReturnType<typeof automationRows>[number];
type OpenChooser = (request: ReturnType<typeof chooserRequest>) => void;
type ChangeConfirm = (appId: string, next: string) => void;
type ChangeActAs = (appId: string, next: string) => void;
type ChangeMailAccess = (appId: string, next: string) => void;
type ChangeMailRunOption = (appId: string, option: string, on: boolean) => void;

export interface ToolsCardProps {
    t: TranslateFn;
    ro?: boolean;
    rows?: ToolCardRow[];
    apps?: ToolApp[] | null;
    catalogState?: ReadState;
    catalogDegraded?: boolean;
    onRetryCatalog?: () => void;
    lentState?: ReadState;
    onRetryLent?: () => void;
    automationRows?: AutomationCardRow[];
    automationsState?: ReadState;
    onChangeConfirm?: ChangeConfirm;
    onChangeActAs?: ChangeActAs;
    onChangeMailAccess?: ChangeMailAccess;
    onChangeMailRunOption?: ChangeMailRunOption;
    onOpenChooser?: OpenChooser;
}


/** Props of one app row of the Tools card. */
export interface ToolRowProps {
    t: TranslateFn;
    ro?: boolean;
    row: ToolCardRow;
    app: ToolApp | null;
    onChangeConfirm?: ChangeConfirm;
    onChangeActAs?: ChangeActAs;
    onChangeMailAccess?: ChangeMailAccess;
    onChangeMailRunOption?: ChangeMailRunOption;
    onOpenChooser?: OpenChooser;
}
