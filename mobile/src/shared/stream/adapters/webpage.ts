/**
 * The webpage builder: POST /ai/chat/webpage/stream (server/routes/ai/
 * webpageChat.js). The answer streams like any other, and around it the
 * builder reports what it did to the page:
 *
 *   webpage_doc_update       a slot (html/css/js) rewritten — the WHOLE new
 *                            body, which is what the server saves at the end
 *                            of the turn, so the latest one per slot is kept;
 *   webpage_extra_update /   a project file (`src/App.jsx`) written or
 *   webpage_extra_deleted    removed — the path only;
 *   webpage_plan_proposed    in ask/plan mode the builder stops and proposes;
 *                            nothing is edited until the plan is approved;
 *   webpage_source_added     research saved as a knowledge source;
 *   webpage_framework/runtime_changed  the page now builds differently.
 *
 * The screen reads these off the finished turn to refresh what changed; none
 * of them is drawn while streaming except the plan.
 */

import { IGNORE, type FrameAdapter, type FrameData } from '../chatFrameReducer';
import {
    appendText,
    appendThinking,
    blockedBy,
    DLP_BLOCKED_REASON,
    failed,
    GUARDRAIL_REASON,
    kbSources,
    replaceText,
    replaceTextUnlessEmpty,
    str,
    thinkingStarted,
    thinkingStopped,
    toolEnded,
    toolStarted,
} from '../handlers';
import type { KbSource, ToolActivity, TurnBase, TurnBlock } from '../types';
import { phaseLabel } from './agent';

export type WebpagePlanAction = 'edit' | 'create' | 'rewrite';

export interface WebpagePlanStep {
    file: string;
    action: WebpagePlanAction;
    why: string;
    preview?: string;
}

/** integrations/webpagePlanTool.js executeProposeWebpagePlan. */
export interface WebpagePlan {
    planId: string;
    title: string;
    summary: string;
    steps: WebpagePlanStep[];
}

export type WebpageSlot = 'html' | 'css' | 'js';

export interface WebpageTurn extends TurnBase {
    text: string;
    thinking: string;
    thinkingActive: boolean;
    phase: string | null;
    tools: ToolActivity[];
    sources: KbSource[];
    blocked: TurnBlock | null;
    /** A plan waiting for approval; the turn ends with it. */
    plan: WebpagePlan | null;
    /** The latest body of every slot the builder rewrote this turn. */
    slots: Partial<Record<WebpageSlot, string>>;
    /** Project files written or removed this turn. */
    extraPaths: string[];
    /** Knowledge sources the builder added this turn. */
    sourcesAdded: number;
    /** Set when the builder switched the page's framework or runtime. */
    settingsChanged: boolean;
}

export function emptyWebpageTurn(): WebpageTurn {
    return {
        text: '',
        thinking: '',
        thinkingActive: false,
        phase: null,
        tools: [],
        sources: [],
        blocked: null,
        plan: null,
        slots: {},
        extraPaths: [],
        sourcesAdded: 0,
        settingsChanged: false,
        error: null,
        done: false,
    };
}

const PLAN_ACTIONS: readonly WebpagePlanAction[] = ['edit', 'create', 'rewrite'];

function readStep(raw: unknown): WebpagePlanStep {
    const d = (raw && typeof raw === 'object' ? raw : {}) as FrameData;
    const action = PLAN_ACTIONS.includes(d.action as WebpagePlanAction) ? (d.action as WebpagePlanAction) : 'edit';
    const preview = str(d.preview);
    return { file: str(d.file), action, why: str(d.why), ...(preview ? { preview } : {}) };
}

/** The frame's `{ planId, plan: { title, summary, steps } }`, or null without an id. */
export function readPlan(d: FrameData): WebpagePlan | null {
    const planId = str(d.planId);
    const plan = (d.plan && typeof d.plan === 'object' ? d.plan : {}) as FrameData;
    if (!planId) return null;
    return {
        planId,
        title: str(plan.title),
        summary: str(plan.summary),
        steps: Array.isArray(plan.steps) ? plan.steps.map(readStep) : [],
    };
}

const SLOTS: readonly WebpageSlot[] = ['html', 'css', 'js'];

function touchedPath(turn: WebpageTurn, d: FrameData): false | void {
    const path = str(d.path);
    if (!path) return false;
    if (!turn.extraPaths.includes(path)) turn.extraPaths = [...turn.extraPaths, path];
}

function settingsChanged(turn: WebpageTurn): void {
    turn.settingsChanged = true;
}

export const WEBPAGE_FRAMES: FrameAdapter<WebpageTurn> = {
    content: appendText,
    content_replace: replaceText,
    content_redact: replaceTextUnlessEmpty,

    thinking: appendThinking,
    thinking_start: thinkingStarted,
    thinking_stop: thinkingStopped,

    phase: (turn, d) => {
        turn.phase = phaseLabel(d);
    },
    // Only sent in auto tier; the chosen model is not shown on this surface.
    model_selected: IGNORE,

    tool_start: toolStarted,
    tool_end: toolEnded,
    kb_sources: kbSources,
    // A screenshot the builder took to check its own layout. The builder
    // looks at it; on a phone it would be a large image nobody asked for.
    image: IGNORE,

    webpage_plan_proposed: (turn, d) => {
        const plan = readPlan(d);
        if (!plan) return false;
        turn.plan = plan;
    },
    webpage_doc_update: (turn, d) => {
        const slot = str(d.file) as WebpageSlot;
        if (!SLOTS.includes(slot) || typeof d.content !== 'string') return false;
        turn.slots = { ...turn.slots, [slot]: d.content };
    },
    webpage_extra_update: touchedPath,
    webpage_extra_deleted: touchedPath,
    webpage_source_added: (turn) => {
        turn.sourcesAdded += 1;
    },
    webpage_framework_changed: settingsChanged,
    webpage_runtime_changed: settingsChanged,
    // The page's own database changed; nothing on the phone shows it.
    webpage_db_update: IGNORE,
    // Post-build lint findings the builder already acts on in the same turn.
    webpage_validation: IGNORE,

    dlp_blocked: blockedBy(DLP_BLOCKED_REASON),
    guardrail_blocked: blockedBy(GUARDRAIL_REASON),
    guardrail_violation: blockedBy(GUARDRAIL_REASON),

    done: (turn) => {
        turn.done = true;
        turn.thinkingActive = false;
        turn.phase = null;
    },
    error: failed,

    // The heartbeat and the privacy-shield telemetry, which fills a desktop
    // side panel. Listed so ignoring them is a decision.
    ping: IGNORE,
    pii_tokenized: IGNORE,
    privacy_payload: IGNORE,
    privacy_token_map: IGNORE,
    tokenisation_info: IGNORE,
    token_savings: IGNORE,
    document_truncated: IGNORE,
};
