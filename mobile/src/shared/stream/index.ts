/**
 * The stream stack: one frame reducer with a per-surface adapter, a runner
 * that batches the live turn into a store, and the types a turn is made of.
 * The transport and the SSE framer are core/api's (sse.ts, sseFrame.ts).
 */

export {
    accounts,
    asRecord,
    IGNORE,
    reduceFrame,
    type FrameAdapter,
    type FrameData,
    type FrameHandler,
    type FrameSink,
} from './chatFrameReducer';
export { mergeKbSources, toKbSource, toKbSources } from './kbSources';
export { appendPhase, MAX_TRAIL_STEPS, traceSpanMs } from './phaseTrail';
export { recordOf, resultPreview } from './handlers';
export { ANSWER_FRAMES, type AnswerTurn } from './answer/frames';
export { draftKey, readGeneratedFile, readPendingCall } from './answer/media';
export { readPrivacyAttachment, readTokenMap, scanWarningsOf } from './answer/privacy';
export { FLUSH_INTERVAL_MS, TurnRunner, type TurnStreamConfig } from './turnRunner';
export { describeTurnFailure } from './turnFailure';
export { useTurn, useTurnStream, type TurnSource, type TurnStream } from './useTurnStream';
export { emptyAnswerParts, NO_DRAFTS } from './types';
export type {
    AnswerParts,
    AudioFile,
    CurrentPhase,
    DlpDecision,
    DlpFinding,
    DraftKind,
    DraftRecord,
    Drafts,
    GeneratedFile,
    KbSource,
    MapEmbed,
    PendingToolCall,
    PhaseTrailEntry,
    PrivacyAttachment,
    ScanWarning,
    SwarmProgress,
    ThinkingPart,
    TokenisationInfo,
    ToolActivity,
    TurnBase,
    TurnBlock,
    TurnImage,
    UserPrivacy,
    VideoFile,
} from './types';

export { AGENT_FRAMES, emptyAgentTurn, phaseLabel, type AgentTurn } from './adapters/agent';
export { DIRECT_FRAMES, emptyStreamingTurn, type StreamingTurn } from './adapters/direct';
export {
    emptyLibraryTurn,
    libraryFrames,
    type LibraryFrameCallbacks,
    type LibraryTurn,
} from './adapters/library';
export { emptyMeetingTurn, MEETING_FRAMES, type MeetingTurn } from './adapters/meeting';
export {
    emptyWebpageTurn,
    readPlan,
    WEBPAGE_FRAMES,
    type WebpagePlan,
    type WebpagePlanAction,
    type WebpagePlanStep,
    type WebpageSlot,
    type WebpageTurn,
} from './adapters/webpage';
