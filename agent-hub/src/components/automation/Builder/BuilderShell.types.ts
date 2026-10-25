import type { BuilderTab, BuilderUrlState, BuilderRunStatePatch } from './useBuilderTabUrl';
import type { AppRef } from '../../admin/Studio/AppStudio/inspector/appDefinition';
import type { PatternOrigin } from './usePatternOrigin';
import type { ManagedPart } from '../../shared/managedPart';
import type { AppUserLike } from '../../projects/workspace/types';

/**
 * Split-view conversational builder.
 *
 * Reuses the EXACT same <InputArea> as direct chat (directMode=true) so
 * users get apps menu, model-tier selector, web search toggle, and file
 * attachments. State (tier, web-search, disabled media) lives in
 * scopedStorage so it persists across sessions just like direct chat.
 */
/**
 * Whether the builder should auto-fire an `autoSendInput` spec ("Build it
 * directly" from a suggestion card). Only on a brand-new builder (no
 * automationId) with no existing conversation — never into an automation the
 * user is already editing. Pure so it can be unit-tested without the shell.
 */
export interface CanAutoSendArgs {
    autoSendInput: string | null;
    automationId: string | null;
    messageCount: number;
}

// Hosting hooks for a page that DRIVES the builder (Studio Playbooks):
//   onTurnEnd({ finalized, aborted, error, automationId, messageCount })
//     fires once per turn when the stream stops — the only way a host can
//     tell a finished build from one that asked a question or aborted
//     (onBuilderStateChange is URL state, onPublished is Step mode only).
//   forcedTier — a tier the host pins for every send of this mount; never
//     written to the user's remembered preference.
//   backLabel — the header's back destination in the host's words.
//   forceAssistantOpen — the host is about to auto-send a brief, so the
//     chat must be visible: `automationsAssistantOpen` is a per-user
//     preference and defaults to CLOSED, which meant a playbook could fire
//     its brief into a pane nobody could see and the room watched a static
//     canvas. The person may still close it; only the initial state is
//     forced, and the host's mount never writes the preference back.
//   seedMetadata — { title?, description? } a host already knows for the
//     draft the first send CREATES (the playbook stage reads `Title "…"`
//     off its brief). Sent with every send; the server honours it only
//     when that send creates the draft, so a re-send cannot rename.
//   patternOrigin — the "Find repeating work" pattern this new build
//     was opened from ({ signature?, suggestion }); usePatternOrigin
//     records `built` for it once the build is done.
export interface BuilderShellProps {
    user?: AppUserLike | null;
    autoSendInput?: string | null;
    initialTab?: BuilderTab | null;
    initialRunId?: string | null;
    onTurnEnd?: ((info: { finalized: boolean; aborted: boolean; error: string | null; automationId: string | null; messageCount: number }) => void) | null;
    automationId: string | null;
    onBack: (() => void) | null;
    onOpenList?: (() => void) | null;
    onExportJson?: (() => Promise<void>) | null | undefined;
    initialChatInput?: string;
    onAutomationIdResolved?: ((automationId: string) => void) | null;
    initialScopeKey?: string | null;
    onScopeChange?: ((scopeKey: string | null) => void) | null;
    mode?: 'automation' | 'step';
    onPublished?: (() => void) | null;
    initialRunStepId?: string | null;
    onBuilderStateChange?: ((state?: Partial<BuilderUrlState>) => void) | null;
    initialAppRef?: AppRef | null;
    forcedTier?: string | null;
    backLabel?: string | null;
    forceAssistantOpen?: boolean;
    seedMetadata?: { title: string; } | null;
    patternOrigin?: PatternOrigin | null;
}

/**
 * The strips the header renders itself, so they follow the bar into BuildTab's
 * ribbon instead of only existing on the other views.
 *
 * Two strips that answer different questions: the breadcrumb says "you came
 * from here" (one button, from the URL or from the trigger), the capsule says
 * "this is run by these" (every app button, from the index). An automation
 * opened through a link shows both; one opened from the list shows only the
 * second.
 *
 * Not for a reusable Step: AUTOMATIONS call it, not app buttons, and
 * `automation_usage` is not about that.
 */
export interface BreadcrumbSlotArgs {
    appRef: AppRef | null;
    isStep: boolean;
    persistedAutomationId: string | null;
    readOnly: boolean;
    managedPart: ManagedPart | null;
    managedNotDeployed: boolean;
}

/** A Step lists its executions, an automation its runs; neither before it has an id. */
export interface HistorySlotArgs {
    automationId: string | null;
    isStep: boolean;
    active: boolean;
    initialRunId: string | null;
    initialRunStepId: string | null;
    onRunStateChange: (patch?: BuilderRunStatePatch, opts?: { replace?: boolean; }) => void;
    onOpenEditor: (stepId?: string | null) => void;
}
