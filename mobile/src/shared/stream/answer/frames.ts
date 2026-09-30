/**
 * The frames an ANSWER is made of, shared by direct chat and agents: the one
 * vocabulary both runtimes emit around the words — reasoning, phases, tools,
 * held actions, citations, media, drafts, privacy — mapped onto AnswerParts.
 * Each surface spreads this table into its adapter and adds what is its own
 * (swarm, conversation ids, access, how `content_replace` behaves).
 */

import type { FrameAdapter } from '../chatFrameReducer';
import { dlpAttachmentPreview, dlpPreview, imageAdded, toolEnded, toolStarted } from '../handlers';
import type { AnswerParts, DlpDecision, TurnImage } from '../types';
import { audioAdded, draftAdded, fileAdded, kbSourcesMerged, mapEmbedded, toolConfirmed, videoAdded } from './media';
import {
    dlpResolvedWithInfo,
    historyLocked,
    modelChosen,
    piiTokenized,
    privacyPayload,
    privacyResponseRaw,
    privacyTokenMap,
    ruleAttributed,
    tokenisationInfo,
} from './privacy';
import { answerText, phaseTracked, thinkingDelta, thinkingPartStarted, thinkingPartStopped } from './reasoning';

/** The turn the table writes into: the answer's parts, its text and its DLP question. */
export type AnswerTurn = AnswerParts & { text: string; images: TurnImage[]; dlpDecision: DlpDecision | null };

export const ANSWER_FRAMES: FrameAdapter<AnswerTurn> = {
    content: answerText,

    thinking: thinkingDelta,
    thinking_start: thinkingPartStarted,
    thinking_stop: thinkingPartStopped,
    phase: phaseTracked,
    model_selected: modelChosen,

    tool_start: toolStarted,
    tool_end: toolEnded,
    tool_confirm: toolConfirmed,

    kb_sources: kbSourcesMerged,
    image: imageAdded,
    audio: audioAdded,
    video: videoAdded,
    file: fileAdded,
    map_embed: mapEmbedded,

    email_draft: draftAdded('email'),
    calendar_draft: draftAdded('calendar'),
    linkedin_draft: draftAdded('linkedin'),
    contacts_draft: draftAdded('contacts'),
    keep_draft: draftAdded('keep'),

    dlp_preview: dlpPreview,
    dlp_attachment_preview: dlpAttachmentPreview,
    dlp_resolved: dlpResolvedWithInfo,
    pii_tokenized: piiTokenized,
    privacy_payload: privacyPayload,
    privacy_response_raw: privacyResponseRaw,
    privacy_token_map: privacyTokenMap,
    tokenisation_info: tokenisationInfo,
    rule_attribution: ruleAttributed,
    history_locked: historyLocked,
};
