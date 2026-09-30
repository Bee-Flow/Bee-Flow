/**
 * Studio app shapes, from server/stores/studioAppStore.js mapAppMetaRow() /
 * mapAppRow() and the run bridge in server/routes/studioAppsRun.js.
 */

import type { RunStatus } from '@/features/automations';

export interface StudioAppMeta {
    id: string;
    userId: string;
    organizationId: string | null;
    projectId: string | null;
    name: string;
    description: string;
    icon: string | null;
    accentColor: string | null;
    definitionVersion: number;
    publishedVersion: number | null;
    isPublished: boolean;
    publishedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

/**
 * One node of an app definition. The full schema is a 40-type component tree
 * (server/appStudio/componentSpecs.js); this declares the shape every node
 * shares plus the props the mobile renderer actually reads. Everything else
 * stays `unknown` rather than being half-modelled.
 */
export interface AppNode {
    id: string;
    type: string;
    props?: Record<string, unknown>;
    style?: Record<string, unknown>;
    children?: AppNode[];
    /** Action ids — the keys of `definition.actions`. */
    onSubmit?: string | null;
    onClick?: string | null;
    visible?: boolean;
    /**
     * Role keys allowed to see this node. Absent or empty means everyone —
     * mirroring roleAllows() in server/routes/studioAppRunGate.js.
     */
    visibleToRoles?: string[] | null;
    /** Formula gates. The phone does not evaluate these; see appDefinition.ts. */
    visibleWhen?: unknown;
    enabledWhen?: unknown;
}

export interface AppSection {
    id: string;
    style?: Record<string, unknown>;
    children?: AppNode[];
}

export interface AppScreen {
    id: string;
    name?: string;
    icon?: string | null;
    showInNav?: boolean;
    sections?: AppSection[];
}

export interface AppAction {
    /** Only `run_automation` is runnable from the phone — see api/endpoints.ts. */
    kind: string;
    automationId?: string | null;
    inputMapping?: Record<string, unknown>;
    steps?: unknown[];
    message?: string;
    url?: string;
    screenId?: string;
}

export interface AppDefinition {
    schemaVersion?: number;
    meta?: { name?: string; description?: string; icon?: string };
    theme?: Record<string, unknown>;
    homeScreenId?: string;
    screens?: AppScreen[];
    actions?: Record<string, AppAction>;
}

/** GET /api/studio-apps/:id/runtime. */
export interface StudioAppRuntime {
    id: string;
    name: string;
    icon: string | null;
    accentColor: string | null;
    definition: AppDefinition;
    viewer: { id?: string; name?: string; email?: string; isOwner?: boolean; roleKey?: string | null };
    appVersion: number | null;
    draft?: boolean;
}

/** POST /api/studio-apps/:id/actions/:actionId/run, and its poll response. */
export interface AppActionResult {
    runId?: string | null;
    status?: RunStatus | 'pending' | 'skipped';
    output?: unknown;
    error?: string | null;
    message?: string;
    approvalId?: string;
}

/** A form's collected values. The server only forwards primitives. */
export type AppFormValues = Record<string, string | number | boolean | null>;
