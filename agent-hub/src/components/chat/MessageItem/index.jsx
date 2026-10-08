import React, { useState, useRef, useEffect } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { Bot, Pencil } from 'lucide-react';
import MapEmbedRenderer from '../../renderers/MapEmbedRenderer';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { isImageAvatar, resolveAvatarSrc } from '../../../utils/agentAvatar';
import ImageLightbox from './ImageLightbox';
import ToolOutput from './ToolOutput';
import ChatActivity from './ChatActivity';
import BrowserLivePreview from './BrowserLivePreview';
import { SequentialThinking } from './ThinkingSteps';
import { ThinkingPanel } from './ThinkingPanel';
import SwarmTimeline from './SwarmTimeline';

import TerminalProgress from './TerminalProgress';
import TokenisedBadge from '../TokenisedBadge';
import PrivacyLine from './PrivacyLine';
import { findTurnTokenMap, messageTextOf, normaliseScanWarnings } from './privacyLine';
import EmailDraftCard from './EmailDraftCard';
import CalendarDraftCard from './CalendarDraftCard';
import LinkedInDraftCard from './LinkedInDraftCard';
import ContactsDraftCard from './ContactsDraftCard';
import KeepDraftCard from './KeepDraftCard';
// Subtrees lifted out of this file verbatim — each one owns markup only; every
// piece of state still lives on this component's fiber and is threaded down.
import AnswerChips from './AnswerChips';
import CitationOverlay from '../../../pages/documents/notebook/CitationOverlay';
import { GeneratedImages, GeneratedAudio, GeneratedVideos, GeneratedFiles } from './GeneratedMedia';
import HowIGotThisAnswer from './HowIGotThisAnswer';
import MessageActionsRow from './MessageActionsRow';
import MessageAttachments from './MessageAttachments';
import MessageContentBody from './MessageContentBody';
import { CompactionDivider, RemovedUserMessage } from './MessageNotices';
import SessionSkillsSection from './SessionSkillsSection';
import TestChatNotice from './TestChatNotice';
import ToolConfirmCard from './ToolConfirmCard';
import UserEditComposer from './UserEditComposer';
import { buildPdfExportHtml } from './messageItemHelpers';

// C9 — de leeskolom. Berichten en composer horen ÉÉN kolom te zijn; ze stonden
// op twee breedtes onder elkaar (berichten 900px, composer 768px), wat je op
// het scherm ziet als een gesprek dat net niet boven zijn eigen invoerveld
// staat. 760px is de maat uit het artboard.
//
// De composer-helft van deze afspraak staat in InputArea.jsx en draagt dezelfde
// maat (`max-w-[760px]`, was `max-w-3xl`/768px). Verandert er hier één, dan
// hoort de andere mee: het is één kolom, in twee bestanden geschreven. Beide
// helften zijn gepind — hier in MessageItem.layout.test.jsx, daar in
// InputArea.footer.test.jsx.
const COLUMN_MAX_W = 'max-w-[760px]';

const MessageItem = ({
    idx,
    msg,
    selectedAgent,
    onCopy,
    allMessages = [],
    conversationId,
    agentId,
    chatSource = 'agent',
    onRetry,
    onEditMessage,
    modelTiers = {},
    isLastAssistant = false,
    sessionSkills = [],
    liveActivatedSkillIds = [],
    liveCompletedSkillIds = null,
    liveCompletions = null,
    // The model's reasoning panel. On by default: it is part of the answer, not
    // a debug surface. Public embed widgets pass false — chain-of-thought does
    // not belong on a customer's own website.
    showReasoning = true,
    // The knowledge-base sources behind the answer. Same shape as
    // `showReasoning` and for the same reason, one step more serious: this one
    // renders internal document titles, their headings and page numbers, and
    // the full retrieved passage. Inside the product that transparency is the
    // point; on a public embed it is somebody's handbook on a stranger's
    // screen, so EmbedChat passes an explicit opt-in that is false unless the
    // agent's own settings say otherwise.
    showSources = true,
    // De VERANTWOORDINGS-helft van de chiprij (A4): welke skills afliepen en
    // welke regel een tweede model achteraf herkende. Standaard UIT en dus NIET
    // zoals `showSources`: dit is geen privacyschakelaar maar een keuze over
    // hoeveel verantwoording er open op het scherm staat, en die staat alleen
    // open waar iemand er expliciet om vraagt — de testchat in de bouwer. Een
    // surface die hem vergeet krijgt de gewone chat, niet de bouwersweergave.
    //
    // De BRONCHIPS staan er los van (C6): die horen bij het antwoord zelf en
    // hangen aan `showSources`, niet hieraan. Zie de rij verderop.
    showAnswerChips = false,
    // Wat een citaatchip opent. Zonder handler opent deze component zijn eigen
    // `CitationOverlay` — zie onderaan — zodat een chip in de gewone chat
    // ergens heen kan zonder dat elke aanroeper daar iets voor hoeft te doen.
    onCitationClick = null,
    // (argsKey, 'approve'|'decline', call) — wat er met een vastgehouden call
    // gebeurt (A4). ZONDER handler rendert ToolConfirmCard geen knoppen: een
    // surface waar een ja nergens heen kan hoort er geen te tonen.
    onToolDecision = null,
    // { [callId of argsKey]: 'approve'|'decline' } — wat er in deze sessie al
    // geklikt is, zodat de kaart niet terugspringt terwijl de volgende beurt
    // onderweg is. Op callId, niet op argsKey: zie toolConfirmStatus.js.
    toolDecisions = {},
}) => {
    const { t } = useTranslation();
    const [expandedBrainEntries, setExpandedBrainEntries] = useState({});
    // Simple Mode hides the "How I got this answer" panel. AgentHub keeps
    // window.__beeflowSimpleMode + dispatches `beeflow:simpleModeChanged` when
    // the user toggles the preference; we subscribe here so the panel
    // disappears without prop-drilling through every MessageItem caller.
    const [simpleMode, setSimpleMode] = useState(() => typeof window !== 'undefined' && !!window.__beeflowSimpleMode);
    useEffect(() => {
        const handler = (e) => setSimpleMode(!!e?.detail);
        window.addEventListener('beeflow:simpleModeChanged', handler);
        return () => window.removeEventListener('beeflow:simpleModeChanged', handler);
    }, []);
    // Simple Mode is an explicit request for a stripped-back surface, so it
    // hides the reasoning panel alongside the "How I got this answer"
    // disclosure below. Everything else shows it.
    const reasoningVisible = showReasoning && !simpleMode;
    const isUser = msg.role === 'user';
    const isTool = msg.role === 'tool';
    // BFSF-307: the retained compaction summary. Everything before it was folded
    // away and is genuinely gone from the database, so rendering it as a normal
    // bubble would be a lie (the user never wrote it) and hiding it outright
    // would leave a conversation that starts abruptly with no explanation.
    // A divider is the honest middle: it marks where history stops being real.
    const isCompactionArtifact = !!msg.compactionArtifact;
    // Whether this turn has anything privacy-related worth showing. The
    // raw-payload transparency used to be reachable only via `count > 0`, so a
    // user with "Show raw payload & token mapping" on but nothing detected saw
    // no confirmation that a scan had run at all (BFSF-291). Any of a
    // tokenised prompt, a raw response or a token map is enough on its own.
    const _tok = msg.tokenisationInfo;
    const hasRawPayload = !!(_tok?.tokenizedPrompt || _tok?.rawResponse || _tok?.tokenMap);
    const hasPrivacyInfo = !!(
        _tok?.count > 0
        || hasRawPayload
        || (_tok?.attachments || []).some(a => a?.timeout || a?.overflow || a?.reason)
    );
    const [copied, setCopied] = useState(false);
    const [copiedMd, setCopiedMd] = useState(false);
    const [lightboxImage, setLightboxImage] = useState(null);
    // C13: welke bronchip openstaat. Lokaal, net als de lightbox hierboven —
    // een citaat hoort bij één bericht, en zo hoeft geen enkele aanroeper een
    // overlay op te hangen om een chip ergens heen te laten wijzen. Geeft de
    // aanroeper wél een `onCitationClick` mee (de notebooks doen dat), dan wint
    // die: dan is er al een plek waar de passage hoort te landen.
    const [openCitation, setOpenCitation] = useState(null);
    const [expandedWorkers, setExpandedWorkers] = useState({});
    const [selectedPhase, setSelectedPhase] = useState(null);
    const [emailDraftStatuses, setEmailDraftStatuses] = useState({});
    const [calendarDraftStatuses, setCalendarDraftStatuses] = useState({});
    const [linkedInDraftStatuses, setLinkedInDraftStatuses] = useState({});
    const [contactsDraftStatuses, setContactsDraftStatuses] = useState({});
    const [keepDraftStatuses, setKeepDraftStatuses] = useState({});

    const [feedbackRating, setFeedbackRating] = useState(null);
    const [showFeedbackForm, setShowFeedbackForm] = useState(false);
    const [feedbackComment, setFeedbackComment] = useState('');
    const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
    const [showRetryMenu, setShowRetryMenu] = useState(false);
    const [retryMenuPos, setRetryMenuPos] = useState({ top: 0, left: 0 });
    const [showCopyMenu, setShowCopyMenu] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const retryMenuRef = useRef(null);
    const retryBtnRef = useRef(null);
    const copyMenuRef = useRef(null);
    const contentRef = useRef(null);
    const editTextareaRef = useRef(null);
    const [includeConversation, setIncludeConversation] = useState(false);

    // Click-outside handler for retry tier menu
    useEffect(() => {
        if (!showRetryMenu) return;
        const handler = (e) => {
            if (retryMenuRef.current && !retryMenuRef.current.contains(e.target) &&
                retryBtnRef.current && !retryBtnRef.current.contains(e.target)) {
                setShowRetryMenu(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showRetryMenu]);

    // Auto-resize edit textarea (mirrors InputArea behavior)
    useEffect(() => {
        if (!isEditing || !editTextareaRef.current) return;
        editTextareaRef.current.style.height = 'auto';
        editTextareaRef.current.style.height =
            Math.min(editTextareaRef.current.scrollHeight, 180) + 'px';
    }, [editContent, isEditing]);

    // Focus + select-all when entering edit mode
    useEffect(() => {
        if (isEditing && editTextareaRef.current) {
            editTextareaRef.current.focus();
            editTextareaRef.current.select();
        }
    }, [isEditing]);

    const submitEdit = () => {
        const trimmed = editContent.trim();
        if (trimmed && onEditMessage) {
            onEditMessage(idx, trimmed);
            setIsEditing(false);
        }
    };

    const handleEditKeyDown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            setIsEditing(false);
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submitEdit();
        }
    };

    // Compute fixed position for the portal-based retry menu
    const handleToggleRetryMenu = () => {
        if (!showRetryMenu && retryBtnRef.current) {
            const rect = retryBtnRef.current.getBoundingClientRect();
            const MENU_HEIGHT = 280;
            const spaceAbove = rect.top;
            if (spaceAbove >= MENU_HEIGHT) {
                // Open upward
                setRetryMenuPos({ top: rect.top - MENU_HEIGHT, left: rect.left });
            } else {
                // Open downward
                setRetryMenuPos({ top: rect.bottom + 8, left: rect.left });
            }
        }
        setShowRetryMenu(prev => !prev);
    };

    // Click-outside handler for copy/export menu
    useEffect(() => {
        if (!showCopyMenu) return;
        const handler = (e) => {
            if (copyMenuRef.current && !copyMenuRef.current.contains(e.target)) setShowCopyMenu(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showCopyMenu]);

    // Get render functions from ToolOutput — must be called before any early
    // return because ToolOutput uses useState internally, and calling a
    // component-as-function shares its hooks with this component.
    const { renderToolOutput } = ToolOutput({ msg });

    // ── Fully deleted / PII-redacted user messages → compact indicator ──
    // Covers: real-time deletion (isDeleted from setTimeout), history-load
    // (content persisted as '[Message removed - policy violation]'), and
    // active guardrail countdown (isGuardrailViolation with deleteIn).
    // NOTE: This early return MUST be placed after all hooks (useState/useEffect)
    // to satisfy React's rules of hooks.
    const isRemovedMessage = msg.isDeleted ||
        (isUser && typeof msg.content === 'string' && msg.content === '[Message removed - policy violation]');

    // ── Compaction boundary → a rule, not a message bubble ──────────────
    if (isCompactionArtifact) {
        return <CompactionDivider t={t} />;
    }

    if (isRemovedMessage && isUser) {
        return <RemovedUserMessage t={t} />;
    }

    const submitFeedback = async (rating, comment = '', withConversation = false) => {
        try {
            const API = (typeof API_BASE !== 'undefined' ? API_BASE : '') + '/api/feedback';
            // Surface model + tier in the admin feedback view. The agent's
            // configured `model` is either a concrete model id or a `tier:*`
            // string; the backend resolves the concrete model from the most
            // recent usage_log row for this conversation when needed.
            const agentModel = selectedAgent?.model || null;
            const modelTier = (typeof agentModel === 'string' && agentModel.startsWith('tier:'))
                ? agentModel.slice(5)
                : null;
            const concreteModel = (typeof agentModel === 'string' && !agentModel.startsWith('tier:'))
                ? agentModel
                : (msg.model || null);
            const payload = {
                conversationId: conversationId || null,
                messageId: msg.id || `msg-${idx}`,
                agentId: agentId || null,
                agentName: selectedAgent?.name || msg.respondingAgentName || null,
                model: concreteModel,
                modelTier,
                rating,
                comment: comment || null,
                source: chatSource,
            };
            if (withConversation && allMessages?.length > 0) {
                payload.conversationSnapshot = allMessages.map(m => ({
                    id: m.id || null,
                    role: m.role,
                    content: m.content,
                    timestamp: m.timestamp,
                    // Capture per-turn model so the org admin can see when a model was
                    // switched mid-conversation; falls back to enrichment on the server.
                    model: m.model || null,
                }));
            }
            await authFetch(API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } catch (e) {
            console.error('[Feedback] Failed to submit:', e);
        }
    };

    const handleThumbClick = (rating) => {
        if (feedbackSubmitted && feedbackRating === rating) return;
        setFeedbackRating(rating);
        setShowFeedbackForm(true);
        setFeedbackSubmitted(false);
        submitFeedback(rating);
    };

    const handleFeedbackSubmit = () => {
        submitFeedback(feedbackRating, feedbackComment.trim(), includeConversation);
        setShowFeedbackForm(false);
        setFeedbackSubmitted(true);
        setIncludeConversation(false);
    };

    const handleFeedbackSkip = () => {
        setShowFeedbackForm(false);
        setFeedbackSubmitted(true);
    };

    const handleCopy = () => {
        onCopy?.(msg.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleCopyMarkdown = async () => {
        if (!msg.content) return;
        try {
            await navigator.clipboard.writeText(msg.content);
            setCopiedMd(true);
            setTimeout(() => setCopiedMd(false), 2000);
        } catch (e) {
            console.error('[MessageItem] MD copy failed:', e);
        }
    };

    const handleExportPdf = () => {
        // Use the ref to get the already-rendered markdown HTML
        const contentEl = contentRef.current;
        if (!contentEl) return;

        const htmlContent = contentEl.innerHTML;
        if (!htmlContent || htmlContent.trim().length === 0) return;

        const printWindow = window.open('', '_blank', 'width=800,height=600');
        if (!printWindow) return;

        printWindow.document.write(buildPdfExportHtml(htmlContent, t('chat.msg.pdf_export_title', 'AI Response Export')));
        printWindow.document.close();

        // Wait for content to render then trigger print
        setTimeout(() => {
            printWindow.focus();
            printWindow.print();
        }, 400);
    };

    const allowCopy = !selectedAgent?.config || selectedAgent.config.allowCopy !== false;

    // Get render functions from ToolOutput
    // (ToolOutput hooks moved above early return — see top of component)



    return (
        <div className={`flex items-start gap-3 group animate-fade-in w-full ${COLUMN_MAX_W} mx-auto`} data-msg-id={`msg-${msg.id || idx}`} data-testid={`message-${msg.id || idx}`}>

            {/* C9 — de afzendertegel van de assistent. Hij staat NAAST het
                antwoord, niet erboven, want dat is wat een tegel doet: hij
                markeert de linkerrand van de kolom waar het antwoord staat en
                laat de tekst zelf zonder bubbel lopen.

                Eén tegel, twee vullingen. Draagt de beurt een eigen agent
                (multi-agent: `respondingAgentAvatar`), dan is dat zijn gezicht;
                anders het bot-icoon. Vóór C9 stond dat agent-gezicht in een
                tweede, kleiner rondje bóven de bubbel — twee avatars voor één
                spreker. De naam blijft daar wél staan, want een naam is geen
                avatar.

                De gebruiker en tool-berichten krijgen geen tegel: de bubbel
                rechts respectievelijk de kaart over de volle breedte zeggen al
                wie er aan het woord is. */}
            {!isUser && !isTool && (
                <div
                    data-testid="assistant-avatar"
                    aria-hidden="true"
                    className="w-[26px] h-[26px] rounded-lg flex-shrink-0 grid place-items-center overflow-hidden text-[13px] leading-none select-none"
                    style={{
                        background: 'color-mix(in srgb, var(--type-ai) 14%, transparent)',
                        color: 'var(--type-ai)',
                    }}
                >
                    {isImageAvatar(msg.respondingAgentAvatar) ? (
                        <img src={resolveAvatarSrc(msg.respondingAgentAvatar)} alt="" className="w-full h-full object-cover" />
                    ) : msg.respondingAgentAvatar ? msg.respondingAgentAvatar : <Bot className="w-3.5 h-3.5" />}
                </div>
            )}

            {/* De kolom van dit bericht zelf. `min-w-0` is niet cosmetisch: een
                flex-kind krijgt anders zijn intrinsieke breedte en dan schuift
                één lange code-regel of URL het hele gesprek horizontaal weg. */}
            <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} min-w-0 flex-1`}>

            {/* Sender Info (Multi-agent support) — alleen de naam; het gezicht
                staat hierboven in de tegel. */}
            {!isUser && !isTool && msg.respondingAgentName && (
                <div className="flex items-center gap-1.5 ml-1 mb-1 text-xs text-[var(--text-secondary)] opacity-80">
                    <span className="font-medium">{msg.respondingAgentName}</span>
                </div>
            )}

            {/* Guardrail Violation Warning */}
            {msg.isGuardrailViolation && (
                <div className="mb-3 px-4 py-3 rounded-xl bg-red-600 border-2 border-red-400 text-white text-sm font-semibold flex items-center gap-3 shadow-lg" data-testid="msg-guardrail-warning">
                    <span className="text-xl">🛡️</span>
                    <div>
                        <div className="font-bold">
                            {msg.willRedact ? t('chat.guardrail_content_violation') : t('chat.guardrail_message_violation')}
                        </div>
                        <div className="text-xs text-white/70 mt-0.5">
                            {msg.willRedact
                                ? t('chat.guardrail_will_redact', { seconds: msg.deleteIn || 5 })
                                : t('chat.guardrail_will_delete', { seconds: msg.deleteIn || 5 })
                            }
                        </div>
                    </div>
                </div>
            )}

            {!(isUser && isEditing) && (
            <div
                data-testid={isUser ? 'user-bubble' : isTool ? 'tool-body' : 'assistant-body'}
                onCopy={(e) => {
                    const sel = window.getSelection();
                    if (!sel || sel.isCollapsed) return;
                    const range = sel.getRangeAt(0);
                    const frag = range.cloneContents();
                    const wrapper = document.createElement('div');
                    wrapper.appendChild(frag);
                    wrapper.querySelectorAll('*').forEach(el => {
                        el.style.removeProperty('background-color');
                        el.style.removeProperty('background');
                    });
                    wrapper.style.removeProperty('background-color');
                    wrapper.style.removeProperty('background');
                    e.clipboardData.setData('text/html', wrapper.innerHTML);
                    e.clipboardData.setData('text/plain', sel.toString());
                    e.preventDefault();
                }}
                className={`relative rounded-2xl transition-all duration-200 overflow-hidden
                    ${isUser
                        /* C10 — de bubbel schildert met een token, niet met een
                           hex. `--user-bubble-bg/-fg` staat sinds index.css:29-36
                           in alle acht thema's; de `,#e8e8eb`-noodwaarde die hier
                           stond kon dus nooit meer aan de beurt komen en zei het
                           tegenovergestelde: dat er een vaste kleur onder lag.
                           NIET vervangen door --bg-tertiary, hoe graag het
                           artboard dat ook tekent: EmbedChat schrijft juist deze
                           twee properties om de bubbelkleur van een insluiter
                           door te laten (EmbedChat.jsx:85). */
                        ? 'p-4 max-w-[85%] bg-[var(--user-bubble-bg)] text-[var(--user-bubble-fg)] rounded-br-none'
                        : isTool
                            ? 'p-4 bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-xl w-full max-w-full'
                            /* C9 — het antwoord heeft geen bubbel: geen vlak, en
                               dus ook geen binnenmarge die de tekst van zijn
                               eigen tegel wegduwt. De verticale ruimte blijft. */
                            : `py-0.5 w-full text-[var(--text-primary)] rounded-bl-none`
                    }
                ${msg.isGuardrailViolation ? 'opacity-60 scale-95' : ''} 
                ${msg.isDeleted ? 'opacity-50 italic' : ''}`}>

                {/* Swarm tier inline tracker — phase progress + clarifier
                    questions + deep-research metadata. Renders when this
                    assistant message carries swarm state (set by useChatEngine
                    via swarm_* SSE events). */}
                {!isUser && !isTool && chatSource === 'direct' && msg.swarm && (
                    <SwarmTimeline swarm={msg.swarm} />
                )}

                {/* Session-skill pipeline timeline — Standard tier inline tracker.
                    Renders when this assistant message either introduced the
                    pipeline (bootstrap) OR changed its activation state vs the
                    previous assistant turn. Quiet turns get nothing. */}
                {!isUser && !isTool && chatSource === 'direct' && Array.isArray(sessionSkills) && sessionSkills.length > 0 && (
                    <SessionSkillsSection
                        msg={msg}
                        allMessages={allMessages}
                        sessionSkills={sessionSkills}
                        liveActivatedSkillIds={liveActivatedSkillIds}
                        liveCompletedSkillIds={liveCompletedSkillIds}
                        liveCompletions={liveCompletions}
                    />
                )}

                {/* Sequential Thinking — always at the top */}
                {!isUser && !isTool && msg.thinkingSteps?.length > 0 && <SequentialThinking msg={msg} />}

                {/* Model Thinking / Reasoning — admin/debug only (BFSF-253); end
                    users never see the model's internal chain-of-thought. */}
                {!isUser && !isTool && reasoningVisible && <ThinkingPanel msg={msg} />}

                {/* Welke agent gaf dit antwoord: het concept (testchat) of de
                    gepubliceerde config. Boven het antwoord, want het is de
                    lezing ERVAN — niet een voetnoot erna. */}
                {!isUser && !isTool && msg.testChat && (
                    <TestChatNotice info={msg.testChat} t={t} />
                )}

                {/* What the assistant did for this answer — the same numbered
                    timeline the automation and app builders show while they build.
                    Live rows spin, finished rows tick, and the card stays after
                    the turn: the tools are the story of the answer. */}
                {!isUser && !isTool && (
                    <ChatActivity msg={msg} sessionSkills={sessionSkills} t={t} />
                )}

                {/* Wat de agent WILDE doen en niet gedaan heeft, met de
                    beslisknoppen erbij. Boven het antwoord: het model vertelt
                    er hieronder over, en de kaart hoort niet ná die uitleg te
                    komen alsof het een resultaat is. */}
                {!isUser && !isTool && msg.pendingToolCalls?.length > 0 && (
                    <ToolConfirmCard
                        calls={msg.pendingToolCalls}
                        onDecide={onToolDecision}
                        decided={toolDecisions}
                        t={t}
                    />
                )}

                {/* Live browser preview (browse_web) — mounted independently of
                    msg.toolCall (last-write-wins across parallel tools), so a
                    co-running agent_search can't hide it. */}
                {!isUser && !isTool && msg.browserPreview && (
                    <BrowserLivePreview preview={msg.browserPreview} />
                )}

                {/* Content */}
                <div
                    ref={contentRef}
                    className={`prose prose-sm dark:prose-invert max-w-none break-words ${!isUser ? '' : 'bubble-user-prose'}`}
                >

                    {!isUser && msg.terminalActivity && (
                        <TerminalProgress msg={msg} allMessages={allMessages} />
                    )}
                    {!isUser && msg.emailDrafts && (
                        <EmailDraftCard msg={msg} emailDraftStatuses={emailDraftStatuses} setEmailDraftStatuses={setEmailDraftStatuses} />
                    )}
                    {!isUser && msg.calendarDrafts && (
                        <CalendarDraftCard msg={msg} calendarDraftStatuses={calendarDraftStatuses} setCalendarDraftStatuses={setCalendarDraftStatuses} />
                    )}
                    {!isUser && msg.linkedInDrafts && (
                        <LinkedInDraftCard msg={msg} linkedInDraftStatuses={linkedInDraftStatuses} setLinkedInDraftStatuses={setLinkedInDraftStatuses} />
                    )}
                    {!isUser && msg.contactsDrafts && (
                        <ContactsDraftCard msg={msg} contactsDraftStatuses={contactsDraftStatuses} setContactsDraftStatuses={setContactsDraftStatuses} />
                    )}
                    {!isUser && msg.keepDrafts && (
                        <KeepDraftCard msg={msg} keepDraftStatuses={keepDraftStatuses} setKeepDraftStatuses={setKeepDraftStatuses} />
                    )}
                    {!isUser && msg.mapEmbeds && msg.mapEmbeds.length > 0 && (
                        <div className="map-embeds-container">
                            {msg.mapEmbeds.map((embed, i) => (
                                <MapEmbedRenderer
                                    key={i}
                                    embedUrl={embed.embedUrl}
                                    title={embed.title}
                                    mapsLink={embed.mapsLink}
                                />
                            ))}
                        </div>
                    )}
                    {isTool ? renderToolOutput() : (
                        <MessageContentBody msg={msg} reasoningVisible={reasoningVisible} sessionSkills={sessionSkills} />
                    )}
                    {/* AI Generated Images — rendered after text (skip if album art for audio) */}
                    {!isUser && msg.images && msg.images.length > 0 && !(msg.audioFiles && msg.audioFiles.length > 0) && (
                        <GeneratedImages msg={msg} setLightboxImage={setLightboxImage} />
                    )}
                    {/* AI Generated Audio — Premium Player with Album Art */}
                    {!isUser && msg.audioFiles && msg.audioFiles.length > 0 && (
                        <GeneratedAudio msg={msg} />
                    )}
                    {/* AI Generated Videos — Modern Player */}
                    {!isUser && msg.videoFiles && msg.videoFiles.length > 0 && (
                        <GeneratedVideos msg={msg} />
                    )}
                    {/* Files a tool built — a deck to open in Nextcloud Office or download */}
                    {!isUser && msg.files && msg.files.length > 0 && (
                        <GeneratedFiles msg={msg} />
                    )}
                </div>

                {/* Waar dit antwoord vandaan komt — chips, direct onder het
                    antwoord in plaats van weggevouwen achter twee keer klikken
                    in "How I got this answer" (C6). Dat is de hele bedoeling
                    van een citaat: het staat er, of het is niet te controleren.

                    TWEE HELFTEN, TWEE SCHAKELAARS:
                    • De BRONCHIPS hangen aan `showSources` — de poort die ook
                      de bronnenpaneel-kant hieronder bewaakt. Zonder die prop
                      was dit een tweede, ONGEPOORTE weg naar dezelfde
                      kennisbankgegevens (documenttitel, paginanummer, kop) één
                      regel boven de weg die wél gepoort is. De publieke embed
                      zet hem dicht en houdt dus ook deze rij dicht.
                    • De VERANTWOORDING (skills, geoordeelde regel) hangt aan
                      `showAnswerChips` en blijft standaard uit: dat is de
                      bouwersweergave uit A4, en de gewone chat hoort die niet
                      per ongeluk te krijgen.

                    EN ÉÉN KLEM DIE DE BUURMAN HIERONDER OOK HEEFT:
                    `!msg.isStreaming`. Citaten landen MIDDEN in de beurt
                    (kb_sources), dus de rij "waar dit antwoord vandaan komt"
                    stond er al terwijl het antwoord nog geschreven werd — een
                    bewering over een antwoord dat nog niet bestond, met de
                    tekst eronder die meesprong bij elke nieuwe chip.

                    Simple Mode klapt hem NIET weg. Die modus haalt de
                    uitklapbare verantwoording weg; deze rij is juist de simpele
                    vorm van dezelfde informatie — één regel, geen machinerie. */}
                {!isUser && !isTool && !msg.isStreaming && (
                    <AnswerChips
                        msg={msg}
                        sessionSkills={sessionSkills}
                        onCitationClick={onCitationClick || setOpenCitation}
                        showSources={showSources}
                        showProcess={showAnswerChips}
                        t={t}
                    />
                )}

                {/* How I got this answer — comprehensive collapsed section */}
                {!simpleMode && !isUser && !isTool && !msg.isStreaming && msg.content && (
                    /* Sources only count towards "is there anything to show"
                       when they may be shown at all — otherwise a turn whose
                       ONLY extra is its sources opens an empty disclosure. */
                    (msg.thinking || msg.toolHistory?.length > 0 || msg.autoSelectedTier || msg.modelId || (showSources && msg.kbSources?.length > 0) || hasPrivacyInfo) && (
                        <HowIGotThisAnswer
                            msg={msg}
                            idx={idx}
                            allMessages={allMessages}
                            hasPrivacyInfo={hasPrivacyInfo}
                            showSources={showSources}
                            t={t}
                        />
                    )
                )}

                {/* Attachments */}
                {msg.attachments && msg.attachments.length > 0 && (
                    <MessageAttachments msg={msg} isUser={isUser} setLightboxImage={setLightboxImage} />
                )}

                {/* Action Buttons + Timestamp row */}
                {!isUser && !msg.isStreaming && (
                    <MessageActionsRow
                        msg={msg}
                        idx={idx}
                        allowCopy={allowCopy}
                        copyMenuRef={copyMenuRef}
                        copied={copied}
                        copiedMd={copiedMd}
                        handleCopy={handleCopy}
                        handleCopyMarkdown={handleCopyMarkdown}
                        handleExportPdf={handleExportPdf}
                        showCopyMenu={showCopyMenu}
                        setShowCopyMenu={setShowCopyMenu}
                        feedbackRating={feedbackRating}
                        feedbackSubmitted={feedbackSubmitted}
                        handleThumbClick={handleThumbClick}
                        onRetry={onRetry}
                        retryMenuRef={retryMenuRef}
                        retryBtnRef={retryBtnRef}
                        handleToggleRetryMenu={handleToggleRetryMenu}
                        showRetryMenu={showRetryMenu}
                        setShowRetryMenu={setShowRetryMenu}
                        retryMenuPos={retryMenuPos}
                        modelTiers={modelTiers}
                    />
                )}

                {/* Feedback Form */}
                {showFeedbackForm && !isUser && (
                    <div className="mt-2 p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] animate-fade-in">
                        <textarea
                            value={feedbackComment}
                            onChange={(e) => setFeedbackComment(e.target.value)}
                            placeholder={t('chat.msg.feedback_placeholder', 'Any additional feedback? (optional)')}
                            className="w-full text-xs p-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] resize-none focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
                            rows={2}
                        />
                        <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={includeConversation}
                                onChange={(e) => setIncludeConversation(e.target.checked)}
                                className="w-3.5 h-3.5 rounded accent-[var(--accent-primary)] cursor-pointer"
                            />
                            <span className="text-[11px] text-[var(--text-secondary)]">
                                {t('chat.msg.feedback_include', 'Include conversation')} <span className="text-[var(--text-tertiary)]">{t('chat.msg.feedback_include_hint', '— helps us reproduce the issue')}</span>
                            </span>
                        </label>
                        <div className="flex items-center gap-2 mt-2">
                            <button
                                onClick={handleFeedbackSubmit}
                                className="px-3 py-1 text-[11px] font-semibold rounded-md bg-[var(--accent-primary)] text-white hover:brightness-110 transition-all"
                            >
                                {t('chat.msg.feedback_submit', 'Submit')}
                            </button>
                            <button
                                onClick={handleFeedbackSkip}
                                className="px-3 py-1 text-[11px] font-medium rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition-colors"
                            >
                                {t('chat.msg.feedback_skip', 'Skip')}
                            </button>
                        </div>
                    </div>
                )}
            </div>
            )}

            {/* PII / DLP — visible confirmation that the user's message had
                sensitive values replaced with placeholders before reaching the
                LLM. `dlpRedactedCount` is set by the DLP path;
                `piiTokenizedCount` by the legacy Azure-PII path. Take the max.

                C7: de regel toont de plaatsvervanger zélf waar de tokenmap er is
                (die landt op het ANTWOORD, vandaar de vooruitblik in
                allMessages) en zegt eerlijk dat hij hem niet kan tonen waar de
                map ontbreekt. De blauwe "N items redacted"-pil is daarmee weg:
                dat was de tellervorm — een bewering zonder aanwijzing.

                Amber "scan incomplete" warnings surface any large upload whose
                unscanned part was passed unredacted (fail_open) — never silent.
                De pil blijft klikbaar naast de regel, MAAR de regel draagt de
                doorlaat ook zelf (`scanIncomplete`): "de echte waarde bleef
                hier" naast een halve controle is een geruststelling over iets
                wat niet gemeten is, en de regel is de zin die gelezen wordt.
                `normaliseScanWarnings` leest een onbekende vorm als "we weten
                het niet", nooit als "er was niets". */}
            {(() => {
                if (!isUser || isEditing) return null;
                const scanWarnings = normaliseScanWarnings(msg.piiScanWarnings);
                const count = Math.max(msg.dlpRedactedCount || 0, msg.piiTokenizedCount || 0);
                if (!count && scanWarnings.length === 0) return null;
                return (
                    <div data-testid="privacy-row" className="mt-1 mr-1 flex justify-end items-center gap-2 flex-wrap">
                        <PrivacyLine
                            count={count}
                            messageText={messageTextOf(msg)}
                            tokenMap={findTurnTokenMap(allMessages, idx)}
                            scanIncomplete={scanWarnings.length > 0}
                            t={t}
                        />
                        <TokenisedBadge warnings={scanWarnings} t={t} />
                    </div>
                );
            })()}

            {/* User message actions + timestamp */}
            {isUser && !isEditing && !msg.isStreaming && (
                <div className="mt-1.5 text-[10px] text-[var(--text-tertiary)] flex items-center gap-1 mr-1 justify-end">
                    {onEditMessage && (
                        <button
                            onClick={() => { setIsEditing(true); setEditContent(msg.content || ''); }}
                            className="p-1 rounded hover:bg-white/10 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                            title={t('chat.msg.edit_message', 'Edit message')}
                        >
                            <Pencil className="w-3 h-3" />
                        </button>
                    )}
                    {msg.timestamp && (
                        <span className="opacity-70">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    )}
                </div>
            )}
            {/* Inline edit mode for user messages — replaces the bubble in place */}
            {isUser && isEditing && (
                <UserEditComposer
                    msg={msg}
                    editContent={editContent}
                    setEditContent={setEditContent}
                    editTextareaRef={editTextareaRef}
                    handleEditKeyDown={handleEditKeyDown}
                    setIsEditing={setIsEditing}
                    submitEdit={submitEdit}
                />
            )}



            {/* Image Lightbox */}
            <ImageLightbox lightboxImage={lightboxImage} setLightboxImage={setLightboxImage} />

            {/* C13 — de passage achter een bronchip. Dezelfde overlay die de
                notebooks en de Knowledge Studio openen, want het is dezelfde
                chip en hetzelfde citatieschema (`core/kb/citation.js`). Hij
                komt hier alleen te staan als er geklikt IS, en klikken kan
                alleen op een chip die een passage bij zich draagt. */}
            <CitationOverlay source={openCitation} onClose={() => setOpenCitation(null)} />
            </div>
        </div>
    );
};

// Each message is wrapped in its own ErrorBoundary so a render failure in one
// message (bad markdown, malformed tool result, etc.) can't take down the whole
// conversation. The boundary is inside React.memo so the identity wrapping is
// preserved.
import { MessageErrorBoundary } from '../../shell/ErrorBoundary';

const MemoMessageItem = React.memo(MessageItem);

function MessageItemWithBoundary(props) {
    return (
        <MessageErrorBoundary msg={props.msg}>
            <MemoMessageItem {...props} />
        </MessageErrorBoundary>
    );
}

export default MessageItemWithBoundary;
