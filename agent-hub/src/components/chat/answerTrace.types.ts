import type { RuleChip } from './MessageItem/answerChips';
import type { CitedSource } from './MessageItem/citationGroups';

export type { ToolEntry } from './MessageItem/chatToolCallDisplay';
export type { ToolConfirmCall } from './MessageItem/ToolConfirmCard';
export type { PhaseTrailEntry } from '../../hooks/useChatEngine/phaseTrail';

export interface OmittedFact {
    fact: string;
    reason: string;
}

export interface MissingRow {
    id: string;
    state: 'missing';
    reason: string;
    omitted: OmittedFact[];
}

export interface QuestionRow {
    id: 'question';
    state: 'recorded';
    stages: string[];
    ms: number | null;
    omitted: OmittedFact[];
}

export interface SourcesRow {
    id: 'sources';
    state: 'recorded';
    query: string | null;
    queries: Array<string | null>;
    results: number | null;
    documents: number | null;
    rows: number | null;
    tables: number | null;
    ms: number | null;
    omitted: OmittedFact[];
}

export interface RuleRow {
    id: 'rule';
    state: 'judged';
    rules: RuleChip[];
    omitted: OmittedFact[];
}

export interface HeldAction {
    key: string;
    toolName: string | null;
    effect: string | null;
    status: string;
    by: string | null;
}

export interface HeldActionRow {
    id: 'held_action';
    state: 'recorded';
    actions: HeldAction[];
    openCount: number;
    omitted: OmittedFact[];
}

export interface AnswerRow {
    id: 'answer';
    state: 'recorded';
    model: string | null;
    sentences: number | null;
    omitted: OmittedFact[];
}

export type TraceRow = MissingRow | QuestionRow | SourcesRow | RuleRow | HeldActionRow | AnswerRow;

/** A cited source, with the fields that tell a passage from a table row. */
export interface TraceSource extends CitedSource {
    kind?: string;
    sourceName?: string;
    section?: string;
}

/** The parts of a message the trace reads; every one of them may be absent. */
export interface TraceMessage {
    toolHistory?: unknown;
    kbSources?: unknown;
    pendingToolCalls?: unknown;
    content?: unknown;
    phaseTrail?: unknown;
    ruleAttribution?: { rules?: unknown } | null;
}

/** The start and end of a tool call, once both are known. */
export interface ToolTimes {
    startTime: number;
    endTime: number;
}
