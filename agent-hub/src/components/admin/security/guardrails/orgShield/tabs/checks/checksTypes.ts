/**
 * The slice of `useOrgShield().fields` the checks pane reads and writes.
 * Listed here rather than typed from the (JavaScript) hook, so the pane says
 * exactly which settings it owns.
 */

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';

type Setter<T> = (next: T) => void;

export interface ChecksFields {
    piiCategories?: string[];
    piiAction: string;
    setPiiAction: Setter<string>;
    showRawPayload: boolean;
    setShowRawPayload: Setter<boolean>;
    scanKnowledgeBases: boolean;
    setScanKnowledgeBases: Setter<boolean>;
    applyToAutomations: boolean;
    setApplyToAutomations: Setter<boolean>;
    dlpEnabled: boolean;
    setDlpEnabled: Setter<boolean>;
    dlpMode: string;
    setDlpMode: Setter<string>;
    dlpAlwaysReview: boolean;
    setDlpAlwaysReview: Setter<boolean>;
    euModeEnabled: boolean;
    setEuModeEnabled: Setter<boolean>;
    webSearchGuard: boolean;
    setWebSearchGuard: Setter<boolean>;
    disableSearchOnUpload: boolean;
    setDisableSearchOnUpload: Setter<boolean>;
    monitorIntegrations: boolean;
    setMonitorIntegrations: Setter<boolean>;
}

export interface ChecksLicence {
    canTokenizePii: boolean;
    canUseWebSearchGuard: boolean;
    upgradeUrl?: string;
}

export interface ChecksEnv {
    hasEuModelsConfigured: boolean;
    hasWebSearchEnabled: boolean;
}

/** Only the matrix is ever a destination from this pane. */
export type GoTo = (tab: string) => void;

export type { TranslateFn };
