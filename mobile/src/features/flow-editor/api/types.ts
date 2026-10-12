/**
 * The flow editor's payloads, written from the server code that sends them:
 * routes/automation/{crud,activate,versions,runs,webhooksAndRunOps,catalog}.js
 * and the stores they read (stores/automationStore/*). The field lists are
 * pinned by src/core/api/serverContract.test.ts.
 *
 * The automation row itself is the automations feature's (rowToAutomation); here
 * it only swaps its loosely typed definition for the editor's strict one.
 */

import type { Automation, AutomationIssue, AutomationPatch, AutomationRun, AutomationRunStep } from '@/features/automations';

import type { FlowDefinition } from '../model/types';

/** An automation row with the editor's definition (normalised: steps and edges are arrays). */
export interface FlowAutomation extends Omit<Automation, 'definition'> {
    definition: FlowDefinition;
}

/**
 * A finding, exactly as the automations feature reads one. It is also a model
 * `ValidationIssue`, so it goes into model/issues.ts as it is (checked by
 * api.compat.test.ts).
 */
export type FlowIssue = AutomationIssue;

/** A set of findings, split the way every surface shows them. */
export interface IssueSet {
    errors: FlowIssue[];
    warnings: FlowIssue[];
}

/** PUT /api/automation/:id — the automations feature's patch, with the editor's definition. */
export interface FlowPatch extends Omit<AutomationPatch, 'definition'> {
    definition?: FlowDefinition;
}

/**
 * What the form's answers table did on this save (automation/formAnswers).
 * Carried, not interpreted: the form builder reads it.
 */
export type AnswersOutcome = Record<string, unknown>;

/** PUT, POST, activate: the row, and the findings that did not block. */
export interface SaveResult {
    automation: FlowAutomation | null;
    warnings: FlowIssue[];
    answers: AnswersOutcome | null;
}

// ── Versions (routes/automation/versions.js) ─────────────────────────

/** One change a version made, as a code the client words (automation/fieldDiff.js describeVersion). */
export interface VersionDescriptionEntry {
    code: string;
    params: Record<string, unknown>;
}

export interface FlowVersionSummary {
    id: string;
    automationId: string;
    version: number;
    savedByUserId: string | null;
    savedAt: string | null;
    changeSummary: string | null;
    savedByName: string | null;
    // Handoff 5 (routes/automation/versionHistory.js). A server from before it
    // sends none of these: no milestone, no live or editing flag, no counts.
    /** A milestone name; null = not a milestone. */
    name: string | null;
    description: string | null;
    descriptionJson: VersionDescriptionEntry[];
    isLive: boolean;
    liveSince: string | null;
    /** The working copy: the version the editor is on. */
    isEditing: boolean;
    runs: { total: number; failed: number } | null;
}

export interface FlowVersion {
    id: string;
    automationId: string;
    version: number;
    definition: FlowDefinition;
    savedByUserId: string | null;
    savedAt: string | null;
}

/** The server's coarse structural diff (summariseDefinitionDiff). */
export interface FlowVersionDiff {
    a: FlowVersion | null;
    b: FlowVersion | null;
    summary: {
        steps: { added: string[]; removed: string[]; changed: string[] };
        edgesChanged: boolean;
        triggerChanged: boolean;
    };
}

export interface RestoreResult {
    automation: FlowAutomation | null;
    restoredFromVersion: number | null;
    answers: AnswersOutcome | null;
}

// ── Test runs (routes/automation/runs.js) ────────────────────────────

/** `only` runs the step; `from` runs it and everything after; `upTo` runs the flow up to it. */
export type StepRunMode = 'only' | 'from' | 'upTo';
export const STEP_RUN_MODES: readonly StepRunMode[] = ['only', 'from', 'upTo'];

export interface TestRunResult {
    run: AutomationRun | null;
    steps: AutomationRunStep[];
}

export interface StepRunResult extends TestRunResult {
    /** The row of the step that was asked for, when the run recorded one. */
    stepRecord: AutomationRunStep | null;
}

// ── Templates (routes/automation/crud.js + automation/templates.js) ──

export interface FlowTemplateSummary {
    id: string;
    title: string;
    description: string;
    category: string;
    icon: string | null;
    tags: string[];
    requiredIntegrations: string[];
    /** 'ready' | 'push-pending' | 'unsupported' — whether its trigger can fire today. */
    triggerReadiness: string;
}

export interface FlowTemplate {
    id: string;
    title: string;
    description: string;
    category: string;
    icon: string | null;
    tags: string[];
    definition: FlowDefinition;
}

export interface FlowTemplateList {
    templates: FlowTemplateSummary[];
    categories: string[];
}

// ── Export / import (automation/portability.js) ──────────────────────

/** GET /:id/export. The envelope is carried whole: it is a file, not a screen. */
export interface FlowExport {
    envelope: Record<string, unknown> | null;
    warnings: string[];
}

// ── Webhooks and form links (routes/automation/webhooksAndRunOps.js) ─

export interface FlowWebhook {
    /** The slug: the URL's only credential. */
    id: string;
    automationId: string;
    triggerStepId: string | null;
    url: string;
    allowMethods: string[] | null;
    lastSeenAt: string | null;
    createdAt: string | null;
    /** The HMAC secret — present ONLY on create and rotate, shown once. */
    secret: string | null;
}

export interface FlowFormLink {
    /** The token: the public URL AND its only credential. */
    id: string;
    automationId: string;
    triggerStepId: string | null;
    url: string;
    createdAt: string | null;
    lastSeenAt: string | null;
    submissions: number;
    /** 'restricted' | 'org' | … — who may fill it in (automation/formAudience). */
    audience: string;
    sharedGroups: string[];
    sharedUserIds: string[];
}

// ── Folders (stores/automationStore/folders.js) ──────────────────────

export interface FlowFolder {
    id: string;
    organizationId: string | null;
    name: string;
    icon: string;
    color: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    /** How many of THIS user's automations sit in it; only on the list. */
    automationCount: number | null;
}

export interface FolderBody {
    name: string;
    icon?: string;
    color?: string | null;
}

// ── The ai_step agent capsule (routes/automation/catalog.js) ─────────

export interface AgentPreview {
    id: string;
    canUse: boolean;
    name: string | null;
    runtimeSource: string | null;
    permissions: Record<string, unknown>;
    allowed: string[];
    /** Held back, each with the reason the gate recorded ('permission' | 'confirm' | 'unavailable'). */
    withheld: { name: string; reason: string }[];
    degraded: boolean;
    error: string | null;
}

export interface AgentPreviewQuery {
    startAutomations?: boolean;
    useKnowledge?: boolean;
    useTools?: boolean;
    /** The step's tool allow-list; an EMPTY list is "no tools", absent is "no list". */
    tools?: string[];
}
