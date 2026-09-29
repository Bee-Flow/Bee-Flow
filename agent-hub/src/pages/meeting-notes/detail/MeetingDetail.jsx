import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, AlertTriangle } from 'lucide-react';
import { PRIMARY_ACTION_STYLE } from '../../../components/shared/StudioSectionHeader';
import { toast } from '../../../components/shared/Toast';
import useConfirm from '../../../components/shared/useConfirm';
import useTranslation from '../../../hooks/useTranslation';
import useUsage from '../../../hooks/useUsage';
import DangerZone from '../../../components/shared/DangerZone';
import { kindLabelFor } from '../../../components/shared/UsedByTab';
import { nOf } from '../../../components/admin/Studio/KnowledgeStudio/plural';
import MeetingHeader, { TABS } from './MeetingHeader';
import MeetingVisibility from './MeetingVisibility';
import TagRow from './TagRow';
import MeetingOutputsBar from './MeetingOutputsBar';
import WaveformPlayer from './WaveformPlayer';
import AudioUnavailable, { AudioNotBackedUp } from './AudioUnavailable';
import SummaryActionsLayout from './SummaryActionsLayout';
import AssistantSidebar from './AssistantSidebar';
import SeriesPreviousCard from './SeriesPreviousCard';
import SpeakerEditor from './SpeakerEditor';
import TemplateEditor from './TemplateEditor';
import * as api from '../lib/transcriptionsApi';
import { applyDestination } from '../lib/actionDestinations';
import { appendArtifact } from '../lib/transcriptLines';
import useTranscription from '../hooks/useTranscription';
import { parseTimestampToSeconds } from '../lib/format';
import { buildTimelineMarkers, buildMentionMarkers } from '../lib/timelineMarkers';
import { findNameMentions } from '../lib/insightsData';
import useMediaQuery from '../hooks/useMediaQuery';
import Modal from '../../../components/shared/Modal';

export default function MeetingDetail({ id, currentUserId, currentUserName, onBack, onChanged, onDeleted, onOpenNote, onNavigate = null }) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const { data, loading, error, refresh, setLocal } = useTranscription(id);
    const [chatOpen, setChatOpen] = useState(false);
    const [tab, setTab] = useState(TABS.SUMMARY);
    const [seriesPrevious, setSeriesPrevious] = useState(null);
    const [busy, setBusy] = useState(false);
    const [regenerating, setRegenerating] = useState(false);
    const [speakerEditorOpen, setSpeakerEditorOpen] = useState(false);
    const [regenerateOffer, setRegenerateOffer] = useState(false);
    const [templates, setTemplates] = useState(null);
    const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState(null);
    const playerApi = useRef(null);
    const isMobile = useMediaQuery('(max-width: 767px)');

    // "Used by n" — ONE fetch for the tab badge, the tab body, the outputs bar
    // under the tags and the delete confirmation (Track 0.4, endpoint M2). Four
    // consumers, one list: a bar that says a knowledge base collects this
    // meeting while the delete dialog says nothing depends on it would be worse
    // than either being absent.
    //
    // `unchecked` names the kinds the server could NOT answer for. It is not
    // decoration: an incomplete list must never be presented as a complete one,
    // and the count in the tab badge stays blank rather than under-reporting.
    const { usage, unchecked, error: usageError, loading: usageLoading } = useUsage('meeting', data?.id || null);
    const uncheckedKinds = usageError ? [] : (unchecked || []);
    const usedByCount = (usageError || uncheckedKinds.length > 0) ? undefined : (usage === null ? undefined : usage.length);

    // Custom summary templates (built-ins + the caller's user/org/group ones)
    // are user-scoped, not per-meeting — load once and refresh after edits.
    const reloadTemplates = useCallback(() => {
        api.listSummaryTemplates().then(setTemplates).catch(() => {});
    }, []);
    useEffect(() => { reloadTemplates(); }, [reloadTemplates]);

    // Reset transient pane state whenever the user navigates to a different
    // meeting — otherwise a leftover "regenerate?" banner or open speaker
    // editor would apply to the wrong meeting.
    useEffect(() => {
        setChatOpen(false);
        setTab(TABS.SUMMARY);
        setSpeakerEditorOpen(false);
        setRegenerateOffer(false);
        setTemplateEditorOpen(false);
        setBusy(false);
        setRegenerating(false);
        setSeriesPrevious(null);
    }, [id]);

    // Recurring-series context: the previous note from the same Meet code /
    // Talk room. Only fetched for completed notes that carry a series link.
    useEffect(() => {
        if (!data?.id || data.status === 'processing' || data.status === 'failed') return undefined;
        if (!data.meetMeetingCode && !data.talkRoomToken) return undefined;
        let cancelled = false;
        api.getSeriesPrevious(data.id)
            .then((prev) => { if (!cancelled) setSeriesPrevious(prev); })
            .catch(() => { /* context card is best-effort */ });
        return () => { cancelled = true; };
    }, [data?.id, data?.status, data?.meetMeetingCode, data?.talkRoomToken]);

    const openNewTemplate = useCallback(() => { setEditingTemplate(null); setTemplateEditorOpen(true); }, []);
    const openEditTemplate = useCallback((tpl) => { setEditingTemplate(tpl); setTemplateEditorOpen(true); }, []);

    const onPlayerReady = useCallback((apiRef) => { playerApi.current = apiRef; }, []);

    const seek = useCallback((tsOrSec) => {
        const sec = typeof tsOrSec === 'number' ? tsOrSec : parseTimestampToSeconds(tsOrSec);
        playerApi.current?.seek(sec);
    }, []);

    // Pin every extracted "moment" — action items, decisions, raised questions —
    // onto the scrubber so the recording becomes navigable by what happened,
    // rather than by dragging through 100 minutes of audio.
    const timelineMarkers = useMemo(
        () => buildTimelineMarkers(
            [...(data?.actionItems || []), ...(data?.decisions || []), ...(data?.questions || [])],
            data?.durationSeconds,
        ),
        [data?.actionItems, data?.decisions, data?.questions, data?.durationSeconds],
    );

    // Private "my mentions": where someone else spoke the viewer's name.
    // Derived per viewer at render time — never persisted, never shared.
    const mentionMarkers = useMemo(
        () => buildMentionMarkers(findNameMentions(data?.segments, currentUserName), data?.durationSeconds),
        [data?.segments, currentUserName, data?.durationSeconds],
    );

    const handleRename = async (title) => {
        if (!data) return;
        setLocal((p) => ({ ...p, title }));
        try {
            await api.patchTranscription(data.id, { title });
            onChanged?.(data.id, { title });
        } catch (_) { refresh(); }
    };

    /**
     * Delete, through the shared danger zone rather than a yes/no dialog.
     *
     * `confirmedBreaking` comes from DangerZone: true only when the list ON
     * SCREEN was non-empty and the meeting's title was typed against it. It is
     * OR-ed with `uncheckedKinds` because the danger zone counts ROWS and a
     * kind the server could not check has no row — without this the request
     * would go out unconfirmed, come back 409 with an empty list, and press
     * again into the same 409 for ever. The `notice` below is what makes that
     * OR honest: the person is shown what could not be checked before they
     * type the name.
     *
     * Errors are NOT swallowed into a toast: a 409 has to reach DangerZone,
     * which re-shows the server's fresher list and asks again.
     */
    const handleDelete = async (confirmedBreaking) => {
        if (!data) return undefined;
        const result = await api.deleteTranscription(data.id, {
            confirmedBreaking: confirmedBreaking || uncheckedKinds.length > 0,
        });
        onDeleted?.(data.id);
        return result;
    };

    const dangerZone = (
        <DangerZone
            entityName={data?.title || ''}
            usage={usage}
            onDelete={handleDelete}
            kindLabel={t('usage.kind_meeting', 'meeting note')}
            currentUserId={currentUserId}
            onNavigate={onNavigate}
            requireName={uncheckedKinds.length > 0}
            openLabel={t('meetings.delete_open', 'Delete this meeting')}
            notice={uncheckedKinds.length > 0 ? (
                <p className="text-xs" style={{ color: 'var(--warning)' }} data-testid="meeting-delete-unchecked">
                    {t('meetings.delete_unchecked', 'Some of what could use this meeting could not be checked ({kinds}), so this list may be incomplete.', {
                        kinds: uncheckedKinds.map((k) => kindLabelFor(t, k, 2)).join(', '),
                    })}
                </p>
            ) : null}
        />
    );

    // No audio and nothing to recover it from. Used to gate Re-transcribe, which
    // otherwise leads straight to a dead end.
    const audioGone = !!data?.audio && data.audio.available === false && !data.audio.recoverable;

    const handleReprocess = async () => {
        if (!data) return;
        const ok = await confirm({
            title: t('meetings.reprocess_title', 'Re-transcribe this recording?'),
            description: t('meetings.reprocess_desc', 'The existing transcript, summary and action items will be replaced.'),
            confirmLabel: t('meetings.retranscribe', 'Re-transcribe'),
        });
        if (!ok) return;
        setBusy(true);
        try {
            await api.reprocessTranscription(data.id);
            await refresh();
            onChanged?.(data.id, {});
        } catch (err) {
            // Branch on the server's stable code, not on prose. 503 means the
            // storage service is briefly unreachable and the recording is fine;
            // 410 means it is genuinely gone — and for a browser recording there
            // is no original file to ask for.
            if (err.code === 'audio_storage_unavailable') {
                toast.error(t('meetings.audio_storage_unavailable', 'Audio storage is temporarily unavailable. Try again in a minute — your recording is safe.'));
            } else if (err.code === 'audio_gone_recorded' || err.code === 'audio_gone_uploaded') {
                await refresh();   // surfaces the AudioUnavailable panel
                toast.error(err.message);
            } else {
                toast.error(t('meetings.reprocess_failed', 'Reprocess failed: {message}', { message: err.message }));
            }
        } finally {
            setBusy(false);
        }
    };

    const handleExport = async (format) => {
        if (!data) return;
        try {
            const blob = await api.exportTranscription(data.id, format);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            // NFKD + combining-mark strip keeps accented letters as their base
            // ("cliëntenraad" → "clientenraad") instead of deleting them.
            const safeTitle = (data.title || 'meeting')
                .normalize('NFKD').replace(/[̀-ͯ]/g, '')
                .replace(/[^\w -]/g, '').trim() || 'meeting';
            a.download = `${safeTitle}.${format}`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            toast.error(t('meetings.export_failed', 'Export failed: {message}', { message: err.message }));
        }
    };

    const handleCopyTranscript = async () => {
        if (!data?.transcript) return;
        try {
            await navigator.clipboard.writeText(data.transcript);
            toast.success(t('meetings.transcript_copied', 'Transcript copied'));
        } catch (_) { /* clipboard unavailable — nothing to say */ }
    };

    const handleAddTag = async (tag) => {
        if (!data) return;
        const next = [...(data.tags || []), tag];
        setLocal((p) => ({ ...p, tags: next }));
        try { await api.patchTranscription(data.id, { tags: next }); onChanged?.(data.id, { tags: next }); } catch (_) { refresh(); }
    };

    const handleRemoveTag = async (tag) => {
        if (!data) return;
        const next = (data.tags || []).filter((x) => x !== tag);
        setLocal((p) => ({ ...p, tags: next }));
        try { await api.patchTranscription(data.id, { tags: next }); onChanged?.(data.id, { tags: next }); } catch (_) { refresh(); }
    };

    /**
     * Save the action list — the ONE write path behind the three things that
     * change it: a checkbox, an edited sentence, a destination (M3).
     *
     * TWO RULES, BOTH LOAD-BEARING.
     *
     * 1. THE FULL LIST GOES OVER THE WIRE. `PATCH actionItems` REPLACES the
     *    column, so sending only the item that changed would delete every
     *    other action on the note — including the ones a person typed
     *    themselves, which is the exact loss M3 exists to prevent. There is no
     *    undo, and nothing on screen would say it had happened.
     * 2. THE SERVER'S ANSWER WINS. The route validates and re-shapes what it
     *    is handed (core/meetingNotes/actionItems.js: an id it minted for an
     *    item that arrived without one, a destination stamped with its own
     *    clock) and echoes the cleaned list back. A client that ignored that
     *    echo would keep rendering its optimistic copy until the next full
     *    refetch, and then watch the ids change under it mid-edit.
     *
     * Answers whether the note was saved, so a caller whose OTHER write
     * already succeeded (the routine really ran) can say that this half did
     * not.
     */
    const saveActionItems = async (next) => {
        if (!data) return false;
        const counts = (list) => ({ actionsTotal: list.length, actionsOpen: list.filter((ai) => !ai.done).length });
        setLocal((p) => ({ ...p, actionItems: next }));
        // The rail's "n actions open" reads the list aggregates; keep them in
        // step with the toggle so the row does not lag the checkbox.
        onChanged?.(data.id, counts(next));
        try {
            const res = await api.patchTranscription(data.id, { actionItems: next });
            if (Array.isArray(res?.actionItems)) {
                setLocal((p) => ({ ...p, actionItems: res.actionItems }));
                onChanged?.(data.id, counts(res.actionItems));
            }
            return true;
        } catch (_) {
            refresh();
            return false;
        }
    };

    const handleToggleActionItem = async (itemId) => {
        if (!data) return;
        await saveActionItems((data.actionItems || []).map((ai) => (ai.id === itemId ? { ...ai, done: !ai.done } : ai)));
    };

    const handleEditActionItem = async (itemId, nextText) => {
        if (!data) return;
        const cleaned = String(nextText || '').trim();
        if (!cleaned) return;
        await saveActionItems((data.actionItems || []).map((ai) => (ai.id === itemId ? { ...ai, text: cleaned } : ai)));
    };

    /**
     * Record where an action went (M3). The destination's own write has
     * already happened — DestinationPicker only calls back once the run, the
     * row or the knowledge source answered — so a failure HERE is the one case
     * that has to be said out loud: the routine ran, and the note lost the
     * chip that says so.
     */
    const handleSetActionDestination = async (itemId, destination) => {
        if (!data) return;
        const ok = await saveActionItems(applyDestination(data.actionItems || [], itemId, destination));
        if (!ok) toast.error(t('meetings.destination_not_saved', 'That worked, but the note could not be updated. Refresh and try again.'));
    };

    /**
     * Save one of the two note lists the transcript can add to (M4).
     *
     * Same two rules as saveActionItems, for the same reasons: the FULL list
     * goes over the wire because `PATCH decisions` REPLACES the column, and
     * the server's cleaned answer wins because it mints the id and re-shapes
     * what it was handed. Answers whether the note was saved, so the popover
     * can show a refusal instead of quietly closing.
     */
    const saveNotes = async (field, next) => {
        if (!data) return false;
        setLocal((p) => ({ ...p, [field]: next }));
        try {
            const res = await api.patchTranscription(data.id, { [field]: next });
            if (Array.isArray(res?.[field])) setLocal((p) => ({ ...p, [field]: res[field] }));
            return true;
        } catch (_) {
            refresh();
            return false;
        }
    };

    /**
     * A line of the transcript became an action, or a decision (M4).
     *
     * The item arrives already marked `source: 'user'` and anchored to its
     * line (lib/transcriptLines.js). That marking is the whole promise of this
     * feature: `POST /:id/regenerate-summary` rewrites both lists from the
     * extractor and keeps out of the way of exactly the items marked this way.
     * A `null` item (a line with nothing in it) writes nothing at all rather
     * than PATCHing the column back unchanged.
     */
    const handleAddLineAction = async (item) => {
        if (!data || !item) return false;
        return saveActionItems(appendArtifact(data.actionItems || [], item));
    };

    const handleAddLineDecision = async (item) => {
        if (!data || !item) return false;
        return saveNotes('decisions', appendArtifact(data.decisions || [], item));
    };

    const handleSpeakerEditSave = async ({ renames, merges }) => {
        if (!data) return null;
        const updated = await api.updateSpeakers(data.id, { renames, merges });
        // Replace the local meeting with the fresh server shape.
        setLocal(() => updated);
        onChanged?.(data.id, updated);
        setRegenerateOffer(true);
        return updated;
    };

    // Re-run AI naming on the stored transcript (no re-transcription). Lets a
    // note stuck on "Guest-1/2/3" be mapped to real names; an attendee list
    // makes it reliable.
    const handleReidentifySpeakers = async (attendees) => {
        if (!data) return null;
        const updated = await api.reidentifySpeakers(data.id, attendees);
        setLocal(() => updated);
        onChanged?.(data.id, updated);
        setRegenerateOffer(true);
        return updated;
    };

    const handleRegenerateSummary = async (template) => {
        if (!data) return;
        setRegenerating(true);
        try {
            const res = await api.regenerateSummary(data.id, template);
            setLocal((p) => ({
                ...p,
                summary: res.summary,
                // The MERGED list, and the whole point of M3: the route
                // re-extracts the AI's action items and keeps every
                // `source:'user'` one, so what comes back already contains the
                // actions this person typed themselves — with their
                // destinations. Take it whole, and only when it IS a list:
                // anything else leaves the list on screen alone rather than
                // emptying the card over a malformed answer.
                actionItems: Array.isArray(res.actionItems) ? res.actionItems : p.actionItems,
                // Regenerate is also the upgrade path for meetings recorded
                // before chapters / decisions / questions existed.
                decisions: res.decisions || p.decisions,
                questions: res.questions || p.questions,
                chapters: res.chapters || p.chapters,
                // Met welk sjabloon deze nieuwe tekst geschreven is (M4 stap
                // 3). `?? null` en niet `|| p.…`: bij een eenmalige prompt
                // antwoordt de server bewust null — dat is het WISSEN van de
                // stempel, en terugvallen op de oude waarde zou het vorige
                // sjabloon laten staan bij tekst die het niet gemaakt heeft.
                summaryTemplateId: res.summaryTemplateId ?? null,
                summaryTemplateVersion: res.summaryTemplateVersion ?? null,
            }));
            if (Array.isArray(res.actionItems)) {
                onChanged?.(data.id, { actionsTotal: res.actionItems.length, actionsOpen: res.actionItems.filter((ai) => !ai.done).length });
            }
            // EEN MISLUKTE ARTEFACTPASS MOET HET ZEGGEN. De server bewaart dan
            // de bestaande actiepunten, besluiten en vragen en antwoordt
            // `artifactsRegenerated: false`. Zonder dit bericht is dat op het
            // scherm niet te onderscheiden van "er kwam niets nieuws uit": de
            // samenvatting is vernieuwd, de lijsten staan er nog, en niemand
            // drukt nog eens op de knop. `=== false` en niet `!res….`: een
            // ouder antwoord zonder dit veld beweert niets.
            if (res.artifactsRegenerated === false) {
                toast.info(t('meetings.artifacts_not_regenerated', 'The summary was rewritten, but working out the action items, decisions and questions failed — the existing ones were kept. Try again in a moment.'));
            }
            // ── EN WELKE PUNTEN DE NIEUWE PASS NIET MEER OPLEVERDE ──────
            // De server bewaart een AI-punt waar een mens aan gezeten heeft
            // (afgevinkt, of de tekst overgetypt) ook als de verse extractie
            // het niet meer herkent — weggooien-en-opnieuw-aanmaken zou die
            // invoer alsnog wissen. Het punt komt dan terug met
            // `orphaned: true`. Dat stil doorlaten laat de kaart beweren dat
            // het zojuist door de AI is opgeleverd, dus wordt het hier gezegd;
            // de blijvende markering staat op de kaart zelf (ActionItemsList).
            const keptCount = Array.isArray(res.actionItems)
                ? res.actionItems.filter((ai) => ai && ai.orphaned).length
                : 0;
            if (keptCount > 0) {
                // Basissleutel + `_plural`, met de ternary om de SLEUTEL heen:
                // "action item(s)" is Engelse grammatica in JavaScript en
                // daar kan geen enkele vertaling iets mee (I18N-CONVENTIES 2.3).
                toast.info(nOf(
                    t, 'meetings.action_items_kept', keptCount,
                    'One action item was kept: the new pass no longer found it, and it had been checked off or edited.',
                    '{count} action items were kept: the new pass no longer found them, and they had been checked off or edited.',
                ));
            }
        } catch (err) {
            toast.error(t('meetings.regenerate_failed', 'Regenerate failed: {message}', { message: err.message }));
        } finally {
            setRegenerating(false);
        }
    };

    if (loading && !data) {
        return <DetailSkeleton t={t} />;
    }

    // A failed load must SAY so. `error` was returned by the hook and read by
    // nobody, so a 5xx on this note left the previously-opened note rendered
    // while the library highlighted this one — and every action here (rename,
    // delete, action items) targeted the stale note. Deleting from that state
    // destroyed a different meeting.
    if (error && !data) {
        return (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" role="alert">
                <AlertTriangle className="w-8 h-8" style={{ color: 'var(--error)' }} aria-hidden="true" />
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {t('meetings.load_failed', 'Couldn’t load this meeting')}
                </p>
                <p className="text-xs max-w-sm" style={{ color: 'var(--text-tertiary)' }}>
                    {error.status === 404
                        ? t('meetings.load_failed_404', 'It may have been deleted, or you no longer have access to it.')
                        : (error.message || t('meetings.something_wrong', 'Something went wrong.'))}
                </p>
                {error.status !== 404 && (
                    <button
                        type="button"
                        onClick={refresh}
                        className="mt-1 px-4 py-2 rounded-lg text-sm font-medium"
                        style={PRIMARY_ACTION_STYLE}
                    >
                        {t('meetings.try_again', 'Try again')}
                    </button>
                )}
            </div>
        );
    }

    if (!data) return null;

    const isOwner = data.isOwner !== false;

    // Async pipeline: a note is created in 'processing' and filled in when the
    // background transcription+diarization finishes. Show a status placeholder
    // instead of an empty player until it's 'completed' (the hook polls).
    if (data.status === 'processing' || data.status === 'failed') {
        const failed = data.status === 'failed';
        const reason = failed ? String(data.failureReason || data.summary || '').trim() : '';
        return (
            <div className="h-full flex flex-col overflow-hidden">
                <MeetingHeader
                    meeting={data}
                    onBack={isMobile ? onBack : undefined}
                    onRename={handleRename}
                    onReprocess={failed ? handleReprocess : undefined}
                    audioGone={audioGone}
                />
                <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-3">
                    {failed ? (
                        <>
                            <AlertTriangle className="w-10 h-10" style={{ color: 'var(--error)' }} aria-hidden="true" />
                            <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('meetings.failed_title', 'Transcription failed')}</p>
                            {reason ? (
                                <p className="text-sm max-w-md" style={{ color: 'var(--error)' }}>{reason}</p>
                            ) : null}
                            <p className="text-sm max-w-md" style={{ color: 'var(--text-tertiary)' }}>
                                {audioGone
                                    ? t('meetings.failed_audio_gone', 'The audio is no longer available, so this note cannot be retried.')
                                    : t('meetings.failed_retry_hint', 'The recording is saved, so you can retry it.')}
                            </p>
                            {isOwner && (
                                <button
                                    type="button"
                                    onClick={handleReprocess}
                                    // Without this a double-click fired two runs
                                    // against the same note, doubling the provider
                                    // bill and letting the loser's error overwrite
                                    // the winner's finished note.
                                    disabled={busy || audioGone}
                                    className="mt-2 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                                    style={PRIMARY_ACTION_STYLE}
                                >
                                    {busy ? t('meetings.starting', 'Starting…') : t('meetings.retry_transcription', 'Retry transcription')}
                                </button>
                            )}
                        </>
                    ) : (
                        <>
                            <Loader2 className="w-10 h-10 animate-spin" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                            <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('meetings.transcribing_title', 'Transcribing…')}</p>
                            <p className="text-sm max-w-md" style={{ color: 'var(--text-tertiary)' }}>
                                {t('meetings.transcribing_desc', 'This runs in the background — you can close this and come back. Long recordings with speaker labels can take a while on the local diarizer; the note updates automatically when it’s ready.')}
                            </p>
                        </>
                    )}
                </div>
                {/* A note that is still transcribing, or failed, is deletable
                    too — and can already be collected by a knowledge source
                    that watches its tags, so it gets the same guard rather
                    than a shortcut. */}
                {isOwner && <div className="px-6 pb-6">{dangerZone}</div>}
                {confirmDialog}
            </div>
        );
    }

    const capsule = (
        <MeetingVisibility
            meeting={data}
            canManage={isOwner}
            onChange={({ isPublished, sharedGroups }) => {
                setLocal((p) => ({ ...p, isPublished, sharedGroups }));
                onChanged?.(data.id, { isPublished, sharedGroups });
            }}
        />
    );

    return (
        <div className="h-full flex">
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                <MeetingHeader
                    meeting={data}
                    onBack={isMobile ? onBack : undefined}
                    onRename={handleRename}
                    onReprocess={handleReprocess}
                    onExport={handleExport}
                    onCopyTranscript={handleCopyTranscript}
                    onEditSpeakers={isOwner ? () => setSpeakerEditorOpen(true) : undefined}
                    onToggleChat={() => setChatOpen((o) => !o)}
                    chatVisible={chatOpen}
                    busy={busy}
                    audioGone={audioGone}
                    tabs
                    activeTab={tab}
                    onTab={setTab}
                    usedByCount={usedByCount}
                    capsule={capsule}
                />
                {regenerateOffer && (
                    <div
                        className="mx-4 sm:mx-6 mt-3 flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-xs"
                        style={{ background: 'color-mix(in srgb, var(--accent-primary) 6%, var(--bg-secondary))', borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                        role="status"
                    >
                        <span>{t('meeting_notes.regenerate_after_rename', 'Speakers updated. Regenerate the summary with the new names?')}</span>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={async () => { setRegenerateOffer(false); await handleRegenerateSummary('general'); }}
                                disabled={regenerating}
                                className="px-2.5 py-1 rounded-md text-xs font-semibold disabled:opacity-50"
                                style={PRIMARY_ACTION_STYLE}
                            >
                                {regenerating ? t('meetings.regenerating', 'Regenerating…') : t('meeting_notes.regenerate', 'Regenerate')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setRegenerateOffer(false)}
                                aria-label={t('meetings.dismiss', 'Dismiss')}
                                className="p-1 rounded-md"
                                style={{ color: 'var(--text-tertiary)' }}
                            >
                                <X className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                )}
                <div className="px-4 sm:px-6 pt-3 flex flex-col gap-3">
                    <TagRow
                        tags={data.tags || []}
                        canEdit={isOwner}
                        onAddTag={handleAddTag}
                        onRemoveTag={handleRemoveTag}
                        busy={busy}
                    />
                    {/* Directly under the tags, because the tags are what most
                        of this list is derived from: adding "sales" here is
                        what puts the summary into a knowledge base, and the
                        bar is where that becomes visible. Same rows as the
                        Used-by tab and the delete confirmation — one fetch. */}
                    <MeetingOutputsBar
                        rows={usage}
                        unchecked={uncheckedKinds}
                        error={usageError}
                        currentUserId={currentUserId}
                        onNavigate={onNavigate}
                    />
                    {/* `audio.available === false` is the state that used to
                        render a dead player and only reveal itself when the
                        user pressed Re-transcribe. Say it up front instead. */}
                    {data.audio && data.audio.available === false ? (
                        <AudioUnavailable audio={data.audio} onRetry={refresh} />
                    ) : (
                        <>
                            <WaveformPlayer
                                audioSrc={api.audioUrl(data.id)}
                                onReady={onPlayerReady}
                                markers={timelineMarkers}
                                mentionMarkers={mentionMarkers}
                                segments={data.segments || []}
                                speakers={data.speakers || []}
                                chapters={data.chapters || []}
                                durationSeconds={data.durationSeconds || 0}
                            />
                            {data.audio?.localOnly && data.audio?.storageConfigured && (
                                <AudioNotBackedUp downloadUrl={api.audioDownloadUrl(data.id)} />
                            )}
                        </>
                    )}
                </div>
                <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
                    {seriesPrevious && tab === TABS.SUMMARY && (
                        <div className="mb-4">
                            <SeriesPreviousCard previous={seriesPrevious} onOpenNote={onOpenNote} />
                        </div>
                    )}
                    <SummaryActionsLayout
                        meeting={data}
                        tab={tab}
                        onShowInsights={() => setTab(TABS.INSIGHTS)}
                        onSeek={seek}
                        onEditSpeakers={isOwner ? () => setSpeakerEditorOpen(true) : undefined}
                        onToggleActionItem={handleToggleActionItem}
                        onEditActionItem={isOwner ? handleEditActionItem : undefined}
                        // Owner-only, and the chip is not drawn at all without
                        // it: a destination names a routine, a table or a
                        // knowledge base in the owner's own workspace, which a
                        // colleague reading a published note has no business
                        // reading the name of.
                        onSetActionDestination={isOwner ? handleSetActionDestination : undefined}
                        // The transcript's per-line "Actie" / "Besluit". Both
                        // write on the note, so both are the owner's alone —
                        // the popover simply does not draw the rows without
                        // them, and keeps the three that write elsewhere.
                        onAddLineAction={isOwner ? handleAddLineAction : undefined}
                        onAddLineDecision={isOwner ? handleAddLineDecision : undefined}
                        onRegenerateSummary={isOwner ? handleRegenerateSummary : undefined}
                        regenerating={regenerating}
                        templates={templates}
                        onNewTemplate={isOwner ? openNewTemplate : undefined}
                        onEditTemplate={isOwner ? openEditTemplate : undefined}
                        viewerName={currentUserName}
                        perPersonInsights={data.perPersonInsights !== false}
                        usage={usage}
                        usageLoading={usageLoading}
                        usageError={usageError}
                        // Same list the outputs bar warns with: the transcript
                        // panel must be able to say "I could not check", not
                        // print a zero it did not verify.
                        usageUnchecked={uncheckedKinds}
                        currentUserId={currentUserId}
                        onNavigate={onNavigate}
                    />
                    {isOwner && dangerZone}
                </div>
            </div>
            {chatOpen && !isMobile && (
                <div className="w-[380px] flex-shrink-0">
                    <AssistantSidebar meeting={data} open={chatOpen} onClose={() => setChatOpen(false)} />
                </div>
            )}
            {chatOpen && isMobile && (
                <Modal open onClose={() => setChatOpen(false)} variant="bare" placement="bottom" size="auto" zIndex={40} label={t('meetings.ask_ai', 'Ask AI')}>
                    <div className="h-[80vh]">
                        <AssistantSidebar meeting={data} open={chatOpen} onClose={() => setChatOpen(false)} />
                    </div>
                </Modal>
            )}
            <SpeakerEditor
                open={speakerEditorOpen}
                onClose={() => setSpeakerEditorOpen(false)}
                meeting={data}
                onSave={handleSpeakerEditSave}
                onAutoDetect={handleReidentifySpeakers}
            />
            <TemplateEditor
                open={templateEditorOpen}
                onClose={() => setTemplateEditorOpen(false)}
                initial={editingTemplate}
                builtins={templates?.builtins || []}
                canManageOrg={!!templates?.canManageOrg}
                onSaved={reloadTemplates}
                onDeleted={reloadTemplates}
            />
            {confirmDialog}
        </div>
    );
}

function DetailSkeleton({ t }) {
    const bar = (w, h = 12) => (
        <div
            className="rounded-md animate-pulse"
            style={{ background: 'var(--bg-tertiary)', width: w, height: h }}
        />
    );
    return (
        <div className="h-full flex flex-col gap-4 px-4 sm:px-6 py-4" aria-busy="true" aria-label={t('meetings.loading_meeting', 'Loading meeting')}>
            <div className="flex items-start gap-3">
                <div className="flex-1 flex flex-col gap-2">
                    {bar('60%', 22)}
                    <div className="flex gap-2">
                        {bar(60)} {bar(80)} {bar(50)}
                    </div>
                </div>
                {bar(80, 28)}
            </div>
            {bar('100%', 64)}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                    {bar('90%')} {bar('80%')} {bar('95%')} {bar('70%')} {bar('85%')}
                </div>
                <div className="flex flex-col gap-2">
                    {bar('60%', 14)} {bar('100%')} {bar('100%')} {bar('80%')}
                </div>
            </div>
        </div>
    );
}
