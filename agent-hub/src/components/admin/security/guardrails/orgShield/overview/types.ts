import type { CustomDataType } from '../ownData/ownDataModel';

/**
 * The shapes the Overview reads. `orgShieldPosture.js` and `useOrgShield.js`
 * are still plain JavaScript, so their outputs are named here once rather
 * than re-guessed in every component.
 */

export type Tone = 'ok' | 'note' | 'warn' | 'error' | 'suggest';

/** Every field any posture row may carry in `value`; each row uses a few. */
export interface PostureValue {
    n?: number;
    total?: number;
    presetId?: string;
    customPct?: number;
    action?: string;
    unlicensed?: boolean;
    on?: boolean;
    mode?: string | null;
    external?: number;
    internal?: number;
    leakedCount?: number | null;
    leakedCategories?: string[];
    toolPii?: number | null;
    sample?: string[];
    terms?: number;
    publicOrgs?: boolean;
    configured?: boolean;
    reachable?: boolean;
    licensed?: boolean;
}

export interface PostureRow {
    id: string;
    tab: string | null;
    icon?: string;
    tone: Tone;
    value: PostureValue;
}

export interface Posture {
    off: boolean;
    rows: PostureRow[];
    attention: number;
    review: number;
}

export interface GuardStatus {
    configured?: boolean;
    reachable?: boolean;
}

/** The slice of the shield form the Overview reads (and the one switch it writes). */
export interface OverviewFields {
    enabled: boolean;
    setEnabled: (next: boolean) => void;
    piiAction?: string;
    showRawPayload?: boolean;
    dlpEnabled?: boolean;
    dlpMode?: string;
    piiCategories?: string[];
    customDataTypes?: CustomDataType[];
}

export type GoTo = (tab: string) => void;

export const isGuardDown = (guard: GuardStatus | null | undefined): boolean =>
    !!guard && (guard.configured === false || guard.reachable === false);
