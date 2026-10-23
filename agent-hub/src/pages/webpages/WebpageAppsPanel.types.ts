import type useAutomationApi from '../../hooks/useAutomationApi';
import type React from 'react';
import type { CatalogApp } from '../../components/automation/Builder/flow/stepPalette.types';

/**
 * WebpageAppsPanel — the "Apps & data" sidebar pane of the webpage IDE.
 *
 * Makes the bridge grants (server: integrations/webpageGrants.js, routes:
 * routes/webpagesGrants.js) visible and manageable WITHOUT going through the
 * AI chat — previously the only way to grant/revoke. Two jobs:
 *
 *   1. Show which integrations + automations this page may call (with a live
 *      status: connected / needs reconnect / unknown), and revoke them.
 *   2. Add new ones from the apps the author ALREADY has access to — the same
 *      strict catalog the automations builder uses (GET /api/automation/
 *      catalog). Apps the author hasn't connected are greyed out with a
 *      Connect deep link to Settings → Connections (with a ?return= back
 *      here); the server also refuses such grants with 409
 *      connection_required, so a stale catalog can't produce a broken grant.
 *
 * Owner-only surface (the bridge runs acts-as-author): non-owners get a note,
 * matching the owner gate in WebpageIDE.
 */

export interface AutomationOption { id?: string; automationId?: string; title?: string }

export interface GrantedIntegration {
    tool: string;
    label?: string;
    integrationLabel?: string;
    hasFixedArgs?: boolean;
    available: boolean | null;
}

export interface GrantedAutomation { automationId: string; label?: string }

export interface Grants {
    integrations?: GrantedIntegration[];
    automations?: GrantedAutomation[];
    discoveryFailed?: boolean;
}

export type AutomationApi = ReturnType<typeof useAutomationApi>;

export interface StatusPillProps {
    available: boolean | null;
}

export interface ConnectLinkProps {
    webpageId: string;
    children?: React.ReactNode;
}

export interface AddAppFormProps {
    webpageId: string;
    catalog: { apps: CatalogApp[] } | null;
    onGranted: () => void;
    onError: (message: string | null) => void;
}

export interface AddAutomationFormProps {
    webpageId: string | number | boolean;
    automations: AutomationOption[];
    onGranted: () => void;
    onError: (message: string | null) => void;
}

export interface WebpageAppsPanelProps {
    webpageId: string;
    readOnly?: boolean;
}
