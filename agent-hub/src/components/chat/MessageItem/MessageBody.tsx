// What an assistant message shows around its text: the progress and
// reasoning above it, the drafts, embeds and media in it, and the sources,
// memory and "How I got this answer" below it. Split out of MessageItem
// without a change in behaviour.
import { useState } from 'react';
import type { ReactNode } from 'react';
import BrowserLivePreview from './BrowserLivePreview';
import CalendarDraftCard from './CalendarDraftCard';
import ContactsDraftCard from './ContactsDraftCard';
import EmailDraftCard from './EmailDraftCard';
import { GeneratedImages, GeneratedAudio, GeneratedVideos, GeneratedFiles } from './GeneratedMedia';
import HowIGotThisAnswer from './HowIGotThisAnswer';
import { AnswerChips, ChatActivity, ToolConfirmCard } from './jsChildren';
import KeepDraftCard from './KeepDraftCard';
import LinkedInDraftCard from './LinkedInDraftCard';
import type { ChatMessage, MapEmbed } from './messageTypes';
import SessionSkillsSection from './SessionSkillsSection';
import SwarmTimeline from './SwarmTimeline';
import TerminalProgress from './TerminalProgress';
import TestChatNotice from './TestChatNotice';
import { ThinkingPanel } from './ThinkingPanel';
import { SequentialThinking } from './ThinkingSteps';
import MapEmbedRenderer from '../../renderers/MapEmbedRenderer';
import MemoryUsedDisclosure, { memoryUsedOf } from '../memory/MemoryUsedDisclosure';
import RememberedChip from '../memory/RememberedChip';

type Translate = (key: string, fallback?: string) => string;

export interface PreambleProps {
    msg: ChatMessage;
    allMessages: ChatMessage[];
    chatSource: string;
    sessionSkills: unknown[];
    liveActivatedSkillIds: unknown[];
    liveCompletedSkillIds: unknown;
    liveCompletions: unknown;
    reasoningVisible: boolean;
    onToolDecision: unknown;
    toolDecisions: Record<string, string>;
    t: Translate;
}

/** Above an assistant answer: how the turn ran, what it reasoned, what waits on the user. */
export function AssistantPreamble(p: PreambleProps) {
    const { msg, chatSource, sessionSkills, t } = p;
    const direct = chatSource === 'direct';
    return (
        <>
            {/* Swarm tier inline tracker — phase progress + clarifier questions
                + deep-research metadata, set by useChatEngine via swarm_* SSE
                events. */}
            {direct && msg.swarm && <SwarmTimeline swarm={msg.swarm} />}

            {/* Session-skill pipeline timeline — Standard tier inline tracker.
                Renders when this assistant message either introduced the
                pipeline (bootstrap) OR changed its activation state vs the
                previous assistant turn. Quiet turns get nothing. */}
            {direct && Array.isArray(sessionSkills) && sessionSkills.length > 0 && (
                <SessionSkillsSection
                    msg={msg}
                    allMessages={p.allMessages}
                    sessionSkills={sessionSkills}
                    liveActivatedSkillIds={p.liveActivatedSkillIds}
                    liveCompletedSkillIds={p.liveCompletedSkillIds}
                    liveCompletions={p.liveCompletions}
                />
            )}

            {/* Sequential Thinking — always at the top */}
            {(msg.thinkingSteps?.length || 0) > 0 && <SequentialThinking msg={msg} />}

            {/* Model Thinking / Reasoning — hidden where the surface asks (a
                public embed) and in Simple Mode. */}
            {p.reasoningVisible && <ThinkingPanel msg={msg} />}

            {/* Which agent gave this answer: the draft (test chat) or the
                published config. Above the answer, because it is the reading
                OF it — not a footnote after it. */}
            {!!msg.testChat && <TestChatNotice info={msg.testChat} t={t} />}

            {/* What the assistant did for this answer — the same numbered
                timeline the automation and app builders show while they build.
                Live rows spin, finished rows tick, and the card stays after the
                turn: the tools are the story of the answer. */}
            <ChatActivity msg={msg} sessionSkills={sessionSkills} t={t} />

            {/* What the agent WANTED to do and has not done, with the decision
                buttons. Above the answer: the model talks about it below, and
                the card must not come after that explanation as if it were a
                result. */}
            {(msg.pendingToolCalls?.length || 0) > 0 && (
                <ToolConfirmCard calls={msg.pendingToolCalls} onDecide={p.onToolDecision} decided={p.toolDecisions} t={t} />
            )}

            {/* Live browser preview (browse_web) — mounted independently of
                msg.toolCall (last-write-wins across parallel tools), so a
                co-running agent_search can't hide it. */}
            {msg.browserPreview && <BrowserLivePreview preview={msg.browserPreview} />}
        </>
    );
}

/** The draft cards (with their per-draft statuses), map embeds and terminal progress. */
export function AssistantAttachments({ msg, allMessages }: { msg: ChatMessage; allMessages: ChatMessage[] }) {
    const [emailDraftStatuses, setEmailDraftStatuses] = useState({});
    const [calendarDraftStatuses, setCalendarDraftStatuses] = useState({});
    const [linkedInDraftStatuses, setLinkedInDraftStatuses] = useState({});
    const [contactsDraftStatuses, setContactsDraftStatuses] = useState({});
    const [keepDraftStatuses, setKeepDraftStatuses] = useState({});
    return (
        <>
            {!!msg.terminalActivity && <TerminalProgress msg={msg} allMessages={allMessages} />}
            {msg.emailDrafts && <EmailDraftCard msg={msg} emailDraftStatuses={emailDraftStatuses} setEmailDraftStatuses={setEmailDraftStatuses} />}
            {msg.calendarDrafts && <CalendarDraftCard msg={msg} calendarDraftStatuses={calendarDraftStatuses} setCalendarDraftStatuses={setCalendarDraftStatuses} />}
            {msg.linkedInDrafts && <LinkedInDraftCard msg={msg} linkedInDraftStatuses={linkedInDraftStatuses} setLinkedInDraftStatuses={setLinkedInDraftStatuses} />}
            {msg.contactsDrafts && <ContactsDraftCard msg={msg} contactsDraftStatuses={contactsDraftStatuses} setContactsDraftStatuses={setContactsDraftStatuses} />}
            {msg.keepDrafts && <KeepDraftCard msg={msg} keepDraftStatuses={keepDraftStatuses} setKeepDraftStatuses={setKeepDraftStatuses} />}
            {msg.mapEmbeds && msg.mapEmbeds.length > 0 && (
                <div className="map-embeds-container">
                    {(msg.mapEmbeds as MapEmbed[]).map((embed, i) => (
                        <MapEmbedRenderer key={i} embedUrl={embed.embedUrl} title={embed.title} mapsLink={embed.mapsLink} />
                    ))}
                </div>
            )}
        </>
    );
}

/** Media a turn produced, after its text. */
export function GeneratedMediaBlock({ msg, setLightboxImage }: { msg: ChatMessage; setLightboxImage: (img: unknown) => void }) {
    const hasAudio = !!(msg.audioFiles && msg.audioFiles.length > 0);
    return (
        <>
            {/* AI Generated Images — skipped when they are album art for audio */}
            {msg.images && msg.images.length > 0 && !hasAudio && (
                <GeneratedImages msg={msg} setLightboxImage={setLightboxImage} />
            )}
            {/* AI Generated Audio — Premium Player with Album Art */}
            {hasAudio && <GeneratedAudio msg={msg} />}
            {/* AI Generated Videos — Modern Player */}
            {msg.videoFiles && msg.videoFiles.length > 0 && <GeneratedVideos msg={msg} />}
            {/* Files a tool built — a deck to open in Nextcloud Office or download */}
            {msg.files && msg.files.length > 0 && <GeneratedFiles msg={msg} />}
        </>
    );
}

export interface AnswerFooterProps {
    msg: ChatMessage;
    idx: number;
    allMessages: ChatMessage[];
    sessionSkills: unknown[];
    onCitationClick: (source: unknown) => void;
    showSources: boolean;
    showAnswerChips: boolean;
    simpleMode: boolean;
    hasPrivacyInfo: boolean;
    t: Translate;
}

/**
 * Below a finished answer (none of it while it streams): where it came from,
 * what memory did for it, and "How I got this answer".
 *
 * The chips sit directly under the answer instead of folded away behind two
 * clicks in "How I got this answer" (C6): that is the whole point of a
 * citation — it is there, or it cannot be checked. TWO HALVES, TWO SWITCHES:
 * the SOURCE chips hang on `showSources`, the gate that also guards the
 * sources panel below — without it this was a second, UNGATED path to the
 * same knowledge-base data one line above the gated one; the public embed
 * closes it. The JUSTIFICATION (skills, the rule a second model recognised)
 * hangs on `showAnswerChips` and stays off by default: that is the builder
 * view from A4. And the same clamp the neighbour below has: `!msg.isStreaming`
 * — citations land MID-turn (kb_sources), so the row used to stand there
 * while the answer was still being written. Simple Mode does NOT fold the
 * chips away: they are the simple form of the same information.
 */
export function AnswerFooter(p: AnswerFooterProps): ReactNode {
    const { msg, t } = p;
    // Sources only count towards "is there anything to show" when they may be
    // shown at all — otherwise a turn whose ONLY extra is its sources opens an
    // empty disclosure.
    const hasProcess = msg.thinking || (msg.toolHistory?.length || 0) > 0 || msg.autoSelectedTier || msg.modelId
        || (p.showSources && (msg.kbSources?.length || 0) > 0) || p.hasPrivacyInfo;
    return (
        <>
            <AnswerChips
                msg={msg}
                sessionSkills={p.sessionSkills}
                onCitationClick={p.onCitationClick}
                showSources={p.showSources}
                showProcess={p.showAnswerChips}
                t={t}
            />
            {/* What memory did for this answer: what it read, and what it saved. */}
            <MemoryUsedDisclosure items={memoryUsedOf(msg)} />
            {msg.memoryWatch && (
                <RememberedChip conversationId={msg.memoryWatch.conversationId} since={msg.memoryWatch.since} until={msg.memoryWatch.until} />
            )}
            {/* How I got this answer — comprehensive collapsed section */}
            {!p.simpleMode && msg.content && hasProcess && (
                <HowIGotThisAnswer
                    msg={msg}
                    idx={p.idx}
                    allMessages={p.allMessages}
                    hasPrivacyInfo={p.hasPrivacyInfo}
                    showSources={p.showSources}
                    t={t}
                />
            )}
        </>
    );
}
