import type { LucideIcon } from 'lucide-react';

/** One capability row, as the group-access / org-availability payloads carry it. */
export interface AccessCapability {
    id: string;
    name: string;
    kind: string;
    category?: string;
    description?: string;
    groupScoped?: boolean;
}

/** One group row of the group-access payload. */
interface AccessGroup {
    id: string;
    name: string;
    granted?: string[];
}

/** GET .../group-access and .../org-availability (the fields these screens read). */
export interface AccessData {
    orgId?: string | null;
    mode?: string;
    ceiling?: string[];
    capabilities?: AccessCapability[];
    everyone?: string[];
    groups?: AccessGroup[];
    betaGoverned?: boolean;
    unrestricted?: boolean;
    available?: string[];
}

/** Save / load status shown next to the heading. */
export interface AccessMessage {
    type: 'ok' | 'error';
    text: string;
}

export interface AccessKindSection {
    kind: string;
    labelKey: string;
    label: string;
    icon: LucideIcon;
}
