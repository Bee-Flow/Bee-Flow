import { Image, MessageCircle, X } from 'lucide-react';
import React, { useState, useRef, useEffect, useCallback } from 'react';

import useAppsCatalog from '../../../hooks/useAppsCatalog';
import useTranslation from '../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../utils/helpers';
import scopedStorage from '../../../utils/scopedStorage';
import { seedTextForApp } from '../../apps/appCatalog';
import CoworkComposer from '../../cowork/CoworkComposer';
import ActiveSkillChips from '../../skills/ActiveSkillChips';
import { usableInChat } from '../knowledgeBaseClaim';
import useDictation from '../useDictation';
import VoiceInlinePanel from '../Voice/VoiceInlinePanel';
import useVoiceChatReady from '../Voice/useVoiceChatReady';

import AttachmentTray from './AttachmentTray';
import ComposerActions from './ComposerActions';
import ComposerBox from './ComposerBox';
import ComposerFooter from './ComposerFooter';
import ComposerPills from './ComposerPills';
import { buildComposerTools } from './composerTools';
import ExternalFilePickers from './ExternalFilePickers';
import KnowledgeBasePanel from './KnowledgeBasePanel';
import useComposerClaims from './useComposerClaims';
import useFileIntake from './useFileIntake';
import useKnowledgeBaseSelection from './useKnowledgeBaseSelection';
import usePasteAttachments from './usePasteAttachments';

// Moved to knowledgeBaseClaim.js, where the rest of the KB pill's reasoning
// lives; still exported from here for the call sites that import it.
export { usableInChat };

const InputArea = ({
    onSendMessage,
    onStopGenerating,
    isLoading,
    selectedAgent,
    activeThreadParent,
    threadTitle,
    onExitThread,
    warningText,
    directMode,
    modelTiers,
    selectedTier,
    onTierChange,
    input,
    setInput,
    agentIntegrations,
    isMobile,
    user,
    activeSkillIds = [],
    agentAttachedSkillIds = [],
    directSessionSkills = [],
    directActivatedSessionSkillIds = [],
    directConversationId = null,
    onToggleSkill,
    // Direct-chat KB picker (only shown in direct mode).
    //
    // `availableKBs` defaults to null, and null is NOT an empty list: it means
    // GET /api/kb has not answered — lazily unfetched, failed, or refused. The
    // pill and its picker both disappear there rather than show "nothing
    // attached", which would be a claim about where answers come from that
    // nothing in this session can support. A call site passes an array only
    // once it really holds the server's list.
    availableKBs = null,
    selectedKBIds = [],
    onChangeKBIds,
    // Voice mode wiring — parent passes its live messages list so voice
    // turns use the real chat history as context, and injects completed
    // turns back via onVoiceTurnComplete so they render as chat bubbles.
    messages,
    onVoiceTurnComplete,
    // ── Cowork mode ──────────────────────────────────────────────────────
    // Opt-in per call site: pass `cowork` (a useCoworkComposer() result) plus
    // the mode + setter and the composer grows a Chat/Cowork switch. A send in
    // Cowork mode does NOT go to the conversation — it creates something that
    // runs on its own. Surfaces that don't pass `cowork` are untouched.
    cowork = null,
    coworkMode = 'chat',
    onCoworkModeChange = null,
    // ── Compact variant (NB-8) ───────────────────────────────────────────
    // The notebook and webpage panels have been passing these two since they
    // were built; the composer simply ignored them, so a 320px drawer got the
    // full-width chat box and the generic "Message AI..." placeholder. They
    // are props now, which means implementing them changes those two screens
    // immediately — that is the point, and both are covered by tests.
    placeholder = null,
    compact = false,
    toolbarExtra = null,
    // How many sources this chat can actually draw on — a notebook counts its
    // READY sources. `null` means "this surface has no such thing", which is
    // not the same as zero and shows no pill at all.
    sourceCount = null,
    // C5 — does the send route this composer feeds ACTUALLY apply the shield?
    // Default FALSE on purpose: a privacy claim is opt-in per call site, never
    // a side effect of having a logged-in user. `user` only says the status
    // route can be queried; it says nothing about what happens to the text on
    // its way out. The Builder composer (BuildTab) posts to
    // routes/ai/automationBuilder/chatStream.js, which applies no shield at
    // all — gating on `user` alone put a green "Personal data is replaced
    // before sending" under a box that replaces nothing.
    shieldApplies = false,
    // Chat signals: the notice for the endpoint this composer posts to (from
    // useChatSignals in the host), and the person's "don't count me" switch.
    // Null everywhere else, so no other composer announces anything.
    chatSignalsNotice = null,
    onChatSignalsCounted = null,
}) => {
    const { t } = useTranslation();
    const [voiceMode, setVoiceMode] = useState(false);
    // Live-read accessor used by the voice hook — avoids stale closures
    // over the `messages` prop while a turn is streaming.
    const messagesRef = useRef(messages);
    useEffect(() => { messagesRef.current = messages; }, [messages]);
    const getHistoryForVoice = useCallback(() => messagesRef.current || [], []);
    const handleVoiceTurn = useCallback((turn) => {
        if (onVoiceTurnComplete) onVoiceTurnComplete(turn);
    }, [onVoiceTurnComplete]);
    // Simple Mode strips the composer toolbar to attachment + web search.
    // Model tier defaults to 'auto' (server resolves) and the secondary icons
    // (memory, KB, voice, skills, apps) are hidden until the user turns it off.
    // Phone-sized screens (isMobile) always run the simplified surface — see
    // AgentHub's `simpleMode` derivation — regardless of the stored preference.
    const _simpleMode = !!user?.simpleMode || isMobile;
    // Only direct chat picks a tier — an agent runs on the tier it was saved
    // with. Where the slider isn't rendered, the memory switch stays in the
    // composer's icon row instead of moving into its panel.
    const showTierSlider = !_simpleMode && !!directMode && !!modelTiers;
    const [attachments, setAttachments] = useState([]);
    const [isDragOver, setIsDragOver] = useState(false);
    const [drivePickerOpen, setDrivePickerOpen] = useState(false);
    const [gmailPickerOpen, setGmailPickerOpen] = useState(false);
    // Whether the media flyout is open is the one piece of that panel's state
    // the composer must also know: a row in the "+" menu opens it, and the
    // panel closes it on an outside click. Everything else it needs — which
    // generator is open, the image settings, which rows the user dimmed — is
    // its own, in MediaCreationPanel.jsx.
    const [mediaMenuOpen, setMediaMenuOpen] = useState(false);
    const [webSearchEnabled, setWebSearchEnabled] = useState(() => {
        const v = scopedStorage.getItem('webSearchEnabled');
        return v === null ? true : v === 'true';
    });
    // Memory write toggle — when off, the server skips memoryExtractor for this
    // session. The read path (existing memories injected into prompt) still
    // works so the user keeps context they've already curated.
    const [memoryWriteEnabled, setMemoryWriteEnabled] = useState(() => {
        const v = scopedStorage.getItem('memoryWriteEnabled');
        return v === null ? true : v === 'true';
    });
    const toggleMemoryWrite = useCallback(() => {
        setMemoryWriteEnabled(prev => {
            const next = !prev;
            scopedStorage.setItem('memoryWriteEnabled', String(next));
            return next;
        });
    }, []);
    const [showKBPicker, setShowKBPicker] = useState(false);
    const [kbPickerSearch, setKbPickerSearch] = useState('');
    // Skills and Apps own their own popovers. The composer no longer gives
    // either of them an icon, so InputArea holds the open state and the
    // tools menu flips it; both still render their panel where they always
    // did. In Cowork mode the apps picker keeps its own button.
    const [skillsOpen, setSkillsOpen] = useState(false);
    const [appsOpen, setAppsOpen] = useState(false);
    // What this chat is grounded on, whether a change landed, and what may be
    // offered — one hook, lifted whole, so its own hooks still run in the
    // order they ran here. See useKnowledgeBaseSelection.js.
    const { kbPickerRef, kbClaim, kbSaving, kbError, commitKBIds, kbPickerOptions } = useKnowledgeBaseSelection({
        availableKBs, selectedKBIds, onChangeKBIds, directConversationId,
        showKBPicker, setShowKBPicker, kbPickerSearch,
    });
    const [orgDisableSearchOnUpload, setOrgDisableSearchOnUpload] = useState(false);
    const [searchProviderConfig, setSearchProviderConfig] = useState('agent-search');
    const [orgEnabledIntegrations, setOrgEnabledIntegrations] = useState(null);
    const [hasGoogleKey, setHasGoogleKey] = useState(false);
    const [hasElevenLabsKey, setHasElevenLabsKey] = useState(false);
    // Which apps exist, which are on, and how to flip one — shared with the
    // Cowork composer so both render the same picker off the same list.
    const { availableApps, isAppEnabled, toggleApp } = useAppsCatalog({ agentIntegrations });
    const textareaRef = useRef(null);
    const fileInputRef = useRef(null);
    const dropZoneRef = useRef(null);

    const isTouchDevice = typeof window !== 'undefined'
        && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

    // Auto-resize textarea. We toggle overflow-y inline so the scrollbar
    // (or its native +/- arrows on some GTK themes) only appears once the
    // content actually exceeds the 180px cap — otherwise it stays hidden.
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        const needsScroll = el.scrollHeight > 180;
        el.style.height = Math.min(el.scrollHeight, 180) + 'px';
        el.style.overflowY = needsScroll ? 'auto' : 'hidden';
    }, [input]);

    // Chat-only slices of the user settings. The apps half of this payload
    // (enabledApps, the per-integration flags, n8n / MCP / Steps) moved to
    // useAppsCatalog, which reads it through the module-cached
    // useIntegrationStatus rather than fetching it a second time.
    useEffect(() => {
        authFetch(`${API_BASE}/ai/user-settings`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!data) return;
                if (data.orgEnabledIntegrations !== undefined) setOrgEnabledIntegrations(data.orgEnabledIntegrations);
                if (data.hasGoogleKey !== undefined) setHasGoogleKey(data.hasGoogleKey);
                if (data.hasElevenLabsKey !== undefined) setHasElevenLabsKey(data.hasElevenLabsKey);
                if (data.disableSearchOnUpload) setOrgDisableSearchOnUpload(true);
                if (data.searchProvider) setSearchProviderConfig(data.searchProvider);
            })
            .catch(() => { });
    }, []);

    // The hidden file input and the drop zone, both funnelling into one
    // processFiles — which usePasteAttachments is handed as well.
    const {
        processFiles, handleFileSelect,
        handleDragEnter, handleDragLeave, handleDragOver, handleDrop,
    } = useFileIntake({ setAttachments, setIsDragOver, fileInputRef, dropZoneRef });

    // ---- Paste (Ctrl+V) ----
    // The textarea's own paste AND the document-level one, with every browser
    // quirk that stands between a Ctrl+V and a File — see
    // usePasteAttachments.js and clipboardFiles.js.
    const handlePaste = usePasteAttachments({ processFiles, textareaRef });

    const removeAttachment = (index) => {
        setAttachments(prev => prev.filter((_, i) => i !== index));
    };

    // Cowork mode is only live when the call site wired it up AND the user has
    // flipped the switch — everything below falls back to plain chat otherwise.
    const coworkEnabled = !!cowork && !!onCoworkModeChange;
    const inCoworkMode = coworkEnabled && coworkMode === 'cowork';

    const handleSend = () => {
        if (inCoworkMode) {
            // A brief with no text is nothing to run; attachments aren't part
            // of a scheduled run, so they're left alone for the chat send.
            if (!input.trim() || cowork.submitting || !cowork.scheduleReady) return;
            const brief = input;
            cowork.submit(brief, { modelTier: directMode ? selectedTier : undefined }).then((created) => {
                // Only clear on success — a failed create keeps the user's
                // words in the box with the error under it.
                if (created) {
                    setInput('');
                    if (textareaRef.current) textareaRef.current.style.height = 'auto';
                }
            });
            return;
        }
        if ((!input.trim() && attachments.length === 0) || isLoading) return;
        onSendMessage(input, attachments, activeThreadParent);
        setInput('');
        setAttachments([]);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
    };

    const handleKeyDown = (e) => {
        // Enter sends on desktop (incl. narrow windows). On true touch
        // devices Enter inserts a newline — send via the button.
        if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice) {
            e.preventDefault();
            handleSend();
        }
    };




    // ── What this composer may OFFER ─────────────────────────────────────
    //
    // Everything the composer can do besides typing travels as DATA — the rows
    // of the "+" menu, built by buildComposerTools() further down
    // (composerTools.js). The row of loose icons they replaced had grown to
    // eight glyphs; ComposerToolsMenu renders them as named rows behind one
    // "+", grouped by what they act on.
    //
    // The flags are derived HERE, once, because the rows and the pills both
    // read them: a row that opens a panel the panel's own condition would hide
    // is exactly the bug one shared derivation makes impossible.
    const voiceReady = useVoiceChatReady(user);
    const externalToolsOk = !selectedAgent?.config?.disableExternalTools;
    const orgOn = (id) => !orgEnabledIntegrations || orgEnabledIntegrations.includes(id);
    const showImageGen = externalToolsOk && orgOn('image-gen') && hasGoogleKey;
    const showMusicGen = externalToolsOk && orgOn('music-gen') && hasGoogleKey;
    const showElevenLabs = externalToolsOk && orgOn('elevenlabs') && hasElevenLabsKey;
    const showVideoGen = externalToolsOk && orgOn('video-gen') && hasGoogleKey;
    const canCreateMedia = showImageGen || showMusicGen || showElevenLabs || showVideoGen;
    const canWebSearch = externalToolsOk && searchProviderConfig !== 'disabled' && orgOn('agent-search');
    const webSearchBlocked = orgDisableSearchOnUpload && attachments.length > 0;
    // `!!kbClaim` is the honesty gate, not a convenience: without the server's
    // list there is no picker to open and nothing truthful to put on a pill,
    // so the whole control stays away rather than offering an empty one.
    // Any signed-in account may pick (the knowledge_bases_beta gate is gone);
    // the server re-authorises every id on every read and every turn anyway,
    // so `!!user` only keeps the picker away from the anonymous embed widget.
    const canPickKBs = !_simpleMode && directMode && typeof onChangeKBIds === 'function'
        && !!kbClaim && !!user;
    // Someone who may NOT pick still deserves to know. Reading a conversation
    // loads its attached bases whether or not this account has the picker, and
    // every turn then searches them — so without this the grounding would be
    // real and invisible. A statement pill (no onClick, no chevron) says what
    // the chat is grounded on without promising a picker that is not coming.
    // Nothing attached means nothing to state, and no pill.
    const kbStatementOnly = !_simpleMode && directMode && !canPickKBs
        && !!kbClaim && kbClaim.attached.length > 0;
    const canPickSkills = !_simpleMode && typeof onToggleSkill === 'function'
        && Array.isArray(user?.betaFeatures) && user.betaFeatures.includes('skills');
    const canPickApps = !_simpleMode && externalToolsOk && availableApps.length > 0;
    const activeSkillCount = new Set([...activeSkillIds, ...agentAttachedSkillIds]).size;

    // ── The pills: what this box can say about the next message ──────────
    //
    // The "+" menu keeps the composer quiet; these bring back the few facts
    // worth reading without opening anything. Each renders only where it can
    // be substantiated — see composerClaims.js. The KB pill (C3) belongs in
    // this same group and is deliberately left to its own change: adding it is
    // one more <ComposerPill> here plus dropping the 'knowledge-bases' row
    // from `composerTools`, the way Skills does below.
    //
    // WHO MAY BE TOLD. Every pill needs a signed-in `user`. The public embed
    // widget passes none, and a tier name, a skills count or a source count is
    // this organisation's internal configuration — not something to hand to an
    // anonymous visitor on a customer's website. Simple Mode (and every phone)
    // strips the toolbar to its essentials, so the pills stay out there too.
    const canShowPills = !_simpleMode && !!user;

    // C2 (the tier), C3 (the knowledge bases), C5 (the privacy line) and C11
    // (the footer), in the order they were computed here — the block moved
    // whole, so the hooks behind it still run in exactly that sequence. The
    // reasoning is in composerClaims.js; useComposerClaims.js is the wiring.
    const {
        tierClaim, tierPillLabel, kbPillLabel, kbPillTitle,
        shieldClaim, footerLine,
    } = useComposerClaims({
        t, canShowPills, showTierSlider, directMode, modelTiers, selectedTier,
        selectedAgent, messages, kbClaim, user, shieldApplies,
    });

    // NB-8 — the call site's own wording wins, except while replying in a
    // thread: that banner and this box describe the same send, and a notebook's
    // "Ask about your sources" would contradict the "Replying to…" above it.
    // (The rest of this file's English is still hard-coded — see C12; these
    // three moved because NB-8 had to touch the expression anyway.)
    const composerPlaceholder = activeThreadParent
        ? t('chat.composer.placeholder_thread', 'Reply to thread...')
        : placeholder
            || (directMode
                ? t('chat.composer.placeholder_direct', 'Message AI...')
                : t('chat.composer.placeholder_agent', 'Message {name}...', { name: selectedAgent?.name || t('chat.composer.agent_fallback', 'Agent') }));

    // Two apps open an attachment picker rather than seeding text; everything
    // else just starts the sentence for you.
    const onPickApp = (app) => {
        if (app.id === 'google-drive') { setDrivePickerOpen(true); return; }
        if (app.id === 'gmail') { setGmailPickerOpen(true); return; }
        const seed = seedTextForApp(app);
        if (seed) setInput(seed);
    };

    // Nothing typed and nothing attached: Send has no work to do, which is what
    // lets the mic take its place when voice chat is available.
    const nothingToSend = !input.trim() && attachments.length === 0;

    // ── Dictation ────────────────────────────────────────────────────────
    // A ref, not `input` straight from the closure: the transcription comes
    // back seconds after the button was pressed, and by then a captured `input`
    // is whatever it was when recording STARTED — appending to that would wipe
    // anything typed in the meantime.
    const inputAtDictationEnd = useRef(input);
    useEffect(() => { inputAtDictationEnd.current = input; }, [input]);
    const dictation = useDictation({
        onText: (text) => {
            const prev = inputAtDictationEnd.current || '';
            setInput(prev.trim() ? `${prev.trim()} ${text}` : text);
        },
    });

    // The attach row opens the hidden <input type="file"> — handed over as a
    // callback rather than as the ref itself, so nothing outside the composer
    // can read `.current` while it renders.
    const openFilePicker = () => { fileInputRef.current?.click(); };
    const composerTools = buildComposerTools({
        t, onAttachClick: openFilePicker,
        canCreateMedia, mediaMenuOpen, setMediaMenuOpen,
        canPickApps, appsOpen, setAppsOpen,
        canWebSearch, webSearchEnabled, webSearchBlocked, setWebSearchEnabled,
        simpleMode: _simpleMode, showTierSlider,
        memoryWriteEnabled, toggleMemoryWrite,
        voiceReady, voiceMode, setVoiceMode,
    });

    /**
     * The picker itself — anchored under the pill that opens it, and built only
     * where there is something truthful to put in it.
     *
     * `showKBPicker && kbClaim &&` is not decoration: if the list ever went
     * back to unknown while the panel was open, every line inside it reads
     * through `kbClaim`. It stays a VALUE rather than a render, because
     * ComposerPills mounts it inside the pill's own wrapper — that wrapper
     * carries the outside-click ref, so a click on the pill is inside the
     * picker and cannot close it in the same gesture that opens it.
     */
    const kbPickerPanel = showKBPicker && kbClaim && (
        <KnowledgeBasePanel
            kbClaim={kbClaim}
            kbPickerOptions={kbPickerOptions}
            kbPickerSearch={kbPickerSearch}
            setKbPickerSearch={setKbPickerSearch}
            commitKBIds={commitKBIds}
            kbError={kbError}
            kbSaving={kbSaving}
            onDone={() => setShowKBPicker(false)}
        />
    );

    // The "+" menu and the pills, as ONE group — ComposerPills.jsx explains why
    // they travel together and why the group is hidden by an ATTRIBUTE rather
    // than unmounted in Cowork mode.
    //
    // Hoisted to a value because BOTH composers render it: chat inline, and the
    // shared CoworkComposer through its `chatTools` slot.
    const chatToolsGroup = (
        <ComposerPills
            composerTools={composerTools} inCoworkMode={inCoworkMode} compact={compact} canShowPills={canShowPills}
            canCreateMedia={canCreateMedia} mediaMenuOpen={mediaMenuOpen} setMediaMenuOpen={setMediaMenuOpen}
            showImageGen={showImageGen} showMusicGen={showMusicGen} showElevenLabs={showElevenLabs} showVideoGen={showVideoGen}
            canPickApps={canPickApps} availableApps={availableApps} isAppEnabled={isAppEnabled} toggleApp={toggleApp}
            appsOpen={appsOpen} setAppsOpen={setAppsOpen} onPickApp={onPickApp}
            tierClaim={tierClaim} tierPillLabel={tierPillLabel} directMode={directMode}
            canPickSkills={canPickSkills} activeSkillCount={activeSkillCount} skillsOpen={skillsOpen} setSkillsOpen={setSkillsOpen}
            user={user} activeSkillIds={activeSkillIds} agentAttachedSkillIds={agentAttachedSkillIds}
            directConversationId={directConversationId} directSessionSkills={directSessionSkills}
            directActivatedSessionSkillIds={directActivatedSessionSkillIds} onToggleSkill={onToggleSkill}
            canPickKBs={canPickKBs} kbStatementOnly={kbStatementOnly} kbClaim={kbClaim}
            kbPillLabel={kbPillLabel} kbPillTitle={kbPillTitle} showKBPicker={showKBPicker}
            setShowKBPicker={setShowKBPicker} kbPickerRef={kbPickerRef} kbPickerPanel={kbPickerPanel}
            sourceCount={sourceCount}
        />
    );

    return (
        <>
            <div
                ref={dropZoneRef}
                className={`${compact ? 'px-0 py-0' : isMobile ? 'px-2 py-1.5' : 'px-4 py-2.5'} bg-[var(--bg-primary)] relative z-20`}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
            >
                {/* Drag overlay */}
                {isDragOver && (
                    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[var(--accent-primary)] bg-opacity-10 border-2 border-dashed border-[var(--accent-primary)] rounded-xl backdrop-blur-sm pointer-events-none"
                        style={{ margin: '8px' }}
                    >
                        <div className="flex flex-col items-center gap-2 text-[var(--accent-primary)]">
                            <Image className="w-8 h-8" />
                            <span className="text-sm font-medium">{t('chat.composer.drop_files', 'Drop files here')}</span>
                        </div>
                    </div>
                )}

                {/* C9 — dezelfde leeskolom als de berichtenlijst (760px, de maat
                    uit het artboard). Stond op `max-w-3xl` (768px), waardoor
                    het gesprek 8px breder liep dan zijn eigen invoerveld. De
                    andere helft is COLUMN_MAX_W in MessageItem/index.jsx. */}
                <div className={compact ? 'w-full' : 'max-w-[760px] mx-auto'} data-testid="composer-column">

                    {/* Thread Banner */}
                    {activeThreadParent && (
                        <div className="flex items-center justify-between bg-[var(--bg-secondary)] px-4 py-2 rounded-t-lg border-x border-t border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] animate-slide-up">
                            <div className="flex items-center gap-2">
                                <MessageCircle className="w-3 h-3 text-[var(--accent-primary)]" />
                                <span>{t('chat.composer.replying_to', 'Replying to')} <span className="font-medium text-[var(--text-primary)]">{threadTitle || t('chat.composer.thread_fallback', 'Thread')}</span></span>
                            </div>
                            <button onClick={onExitThread} aria-label={t('chat.composer.exit_thread', 'Leave this thread')} title={t('chat.composer.exit_thread', 'Leave this thread')} className="hover:text-[var(--text-primary)] p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors">
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    )}

                    {/* Attachment Preview */}
                    <AttachmentTray
                        attachments={attachments}
                        onRemove={removeAttachment}
                        hasThreadBanner={!!activeThreadParent}
                    />


                    {/* Active Skills Preview — shows which skills apply to the next send */}
                    <ActiveSkillChips
                        activeSkillIds={activeSkillIds}
                        attachedSkillIds={agentAttachedSkillIds}
                        onToggleSkill={onToggleSkill}
                        hasThreadBanner={!!activeThreadParent}
                        hasAttachments={attachments.length > 0}
                    />

                    {inCoworkMode ? (
                        /* Cowork mode hands the whole box to the shared
                           composer — the same component /app/cowork renders, so
                           the two can't drift apart again. Attachments, paste
                           and drag/drop don't come along: they were already
                           unavailable here (a scheduled run has nowhere to put
                           a file), and their buttons ride in the chatTools
                           slot, hidden. */
                        <CoworkComposer
                            value={input}
                            onChange={setInput}
                            onSubmit={handleSend}
                            cowork={cowork}
                            modelTiers={directMode ? modelTiers : null}
                            selectedTier={selectedTier}
                            onTierChange={onTierChange}
                            simpleMode={_simpleMode}
                            disableExternalTools={!!selectedAgent?.config?.disableExternalTools}
                            agentIntegrations={agentIntegrations}
                            isMobile={isMobile}
                            chatTools={chatToolsGroup}
                        />
                    ) : voiceMode ? (
                        <VoiceInlinePanel
                            agentId={selectedAgent?.id || null}
                            agentName={selectedAgent?.name || null}
                            getHistory={getHistoryForVoice}
                            onTurnComplete={handleVoiceTurn}
                            onExit={() => setVoiceMode(false)}
                            isMobile={isMobile}
                        />
                    ) : (
                    <ComposerBox
                        compact={compact}
                        isMobile={isMobile}
                        activeThreadParent={activeThreadParent}
                        attachments={attachments}
                        activeSkillIds={activeSkillIds}
                        agentAttachedSkillIds={agentAttachedSkillIds}
                        isDragOver={isDragOver}
                        fileInputRef={fileInputRef}
                        handleFileSelect={handleFileSelect}
                        textareaRef={textareaRef}
                        input={input}
                        setInput={setInput}
                        handleKeyDown={handleKeyDown}
                        handlePaste={handlePaste}
                        composerPlaceholder={composerPlaceholder}
                        tools={toolbarExtra ? <div className="flex items-center gap-1 min-w-0">{chatToolsGroup}{toolbarExtra}</div> : chatToolsGroup}
                        actions={(
                            <ComposerActions
                                shieldClaim={shieldClaim}
                                showTierSlider={showTierSlider}
                                modelTiers={modelTiers}
                                selectedTier={selectedTier}
                                onTierChange={onTierChange}
                                memoryWriteEnabled={memoryWriteEnabled}
                                toggleMemoryWrite={toggleMemoryWrite}
                                dictation={dictation}
                                simpleMode={_simpleMode}
                                compact={compact}
                                isLoading={isLoading}
                                onStopGenerating={onStopGenerating}
                                nothingToSend={nothingToSend}
                                voiceReady={voiceReady}
                                onStartVoiceMode={() => setVoiceMode(true)}
                                onSend={handleSend}
                            />
                        )}
                    />
                    )}


                    {!inCoworkMode && (
                        <ComposerFooter
                            compact={compact}
                            warningText={warningText}
                            footerLine={footerLine}
                            isTouchDevice={isTouchDevice}
                            chatSignalsNotice={chatSignalsNotice}
                            onChatSignalsCounted={onChatSignalsCounted}
                        />
                    )}
                </div>
            </div>

            <ExternalFilePickers
                driveOpen={drivePickerOpen}
                onDriveClose={() => setDrivePickerOpen(false)}
                gmailOpen={gmailPickerOpen}
                onGmailClose={() => setGmailPickerOpen(false)}
                onAdd={(newAttachments) => setAttachments(prev => [...prev, ...newAttachments])}
            />
        </>
    );
};
export default InputArea;

