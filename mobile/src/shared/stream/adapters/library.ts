/**
 * Notebook chat and template chat: server/routes/ai/notebookChat.js and
 * templateChat.js. Two runtimes with an overlapping vocabulary that is not the
 * direct-chat one — no swarm, no DLP round-trip, tool frames carry only a
 * name — plus three notebook-only frames:
 *
 *   notebook_doc_update   — the model rewrote the notebook's document. Carries
 *                           the CAS `version`; adopting it is what stops the
 *                           next save from a false 409.
 *   notebook_source_added — a research tool saved a new source mid-answer.
 *   history_locked        — the encrypted history could not be opened with
 *                           this session's key; the composer has to lock.
 */

import { IGNORE, type FrameAdapter } from '../chatFrameReducer';
import {
    appendText,
    appendThinkingText,
    blockedBy,
    blockedWith,
    DLP_BLOCKED_REASON,
    failed,
    GUARDRAIL_REASON,
    kbSources,
    modelSelected,
    phaseByName,
    replaceText,
    replaceTextUnlessEmpty,
    str,
    thinkingStarted,
    thinkingStopped,
} from '../handlers';
import type { KbSource, ToolActivity, TurnBlock } from '../types';

export interface LibraryTurn {
    text: string;
    thinking: string;
    thinkingActive: boolean;
    phase: string | null;
    tools: ToolActivity[];
    /** Retrieved chunks the answer cites. */
    sources: KbSource[];
    modelId: string | null;
    /** The server stopped for a policy reason. Not an error — its own UI. */
    blocked: TurnBlock | null;
    /** Set by `history_locked`; the composer disables itself on it. */
    locked: boolean;
    error: string | null;
    done: boolean;
}

export function emptyLibraryTurn(): LibraryTurn {
    return {
        text: '',
        thinking: '',
        thinkingActive: false,
        phase: null,
        tools: [],
        sources: [],
        modelId: null,
        blocked: null,
        locked: false,
        error: null,
        done: false,
    };
}

/** The frames that are not about the turn, handed to the screen instead. */
export interface LibraryFrameCallbacks {
    /** A notebook document rewrite: HTML body, optional title, CAS version. */
    onDocumentUpdate?: (content: string, title?: string, version?: number) => void;
    /** A tool saved a research result into the notebook's sources (the raw row). */
    onSourceAdded?: (source: object) => void;
}

/** `callbacks` is read per frame, so a re-rendered screen's latest ones are used. */
export function libraryFrames(callbacks: () => LibraryFrameCallbacks): FrameAdapter<LibraryTurn> {
    return {
        content: appendText,
        content_replace: replaceText,
        content_redact: replaceTextUnlessEmpty,

        thinking: appendThinkingText,
        thinking_start: thinkingStarted,
        thinking_stop: thinkingStopped,

        phase: phaseByName,
        model_selected: modelSelected,

        // These runtimes name a tool and nothing else, so the name is the id.
        tool_start: (turn, d) => {
            const tool: ToolActivity = {
                id: str(d.name) || `tool-${turn.tools.length}`,
                name: str(d.name) || 'Tool',
                status: 'running',
            };
            turn.tools = [...turn.tools, tool];
        },
        tool_end: (turn, d) => {
            const name = str(d.name);
            turn.tools = turn.tools.map((t) => (t.name === name ? { ...t, status: 'done' as const } : t));
        },

        kb_sources: kbSources,

        notebook_doc_update: (_turn, d) => {
            callbacks().onDocumentUpdate?.(
                str(d.content),
                str(d.title) || undefined,
                typeof d.version === 'number' ? d.version : undefined,
            );
            return false;
        },
        notebook_source_added: (_turn, d) => {
            const source = d.source;
            if (source && typeof source === 'object') callbacks().onSourceAdded?.(source);
            return false;
        },
        history_locked: (turn) => {
            turn.locked = true;
            turn.blocked = {
                reason: 'This notebook’s chat history is encrypted with a key this session does not have.',
                detail: 'Unlock encryption on this device to keep chatting here.',
            };
        },

        dlp_blocked: blockedBy(DLP_BLOCKED_REASON),
        // notebookChat.js names the rules that fired; the other shape says why.
        guardrail_violation: blockedBy(GUARDRAIL_REASON, guardrailDetail),
        guardrail_blocked: blockedBy(GUARDRAIL_REASON, guardrailDetail),
        unicode_smuggling_detected: blockedWith({
            reason: 'Hidden characters were removed from this message before it was sent.',
        }),

        done: (turn) => {
            turn.done = true;
            turn.thinkingActive = false;
        },
        error: failed,

        // The heartbeat and the privacy-shield telemetry, which exists to fill
        // a desktop side panel. Listed so "we ignore this" is a decision.
        ping: IGNORE,
        document_truncated: IGNORE,
        pii_tokenized: IGNORE,
        privacy_payload: IGNORE,
        privacy_token_map: IGNORE,
        tokenisation_info: IGNORE,
        token_savings: IGNORE,
    };
}

function guardrailDetail(d: Readonly<Record<string, unknown>>): string | undefined {
    return Array.isArray(d.rules) ? d.rules.join(', ') : str(d.reason) || undefined;
}
