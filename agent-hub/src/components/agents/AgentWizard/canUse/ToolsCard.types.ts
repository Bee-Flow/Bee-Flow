import type { TranslateFn } from '../../../../hooks/useTranslation';
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
}
/** One automation grant, as `toolGrants.automationRows` builds it. */
export type AutomationCardRow = ReturnType<typeof automationRows>[number];
type OpenChooser = (request: ReturnType<typeof chooserRequest>) => void;
type ChangeConfirm = (appId: string, next: string) => void;
type ChangeActAs = (appId: string, next: string) => void;

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
    onOpenChooser?: OpenChooser;
}
