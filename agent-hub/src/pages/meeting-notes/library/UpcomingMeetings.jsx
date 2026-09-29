import React, { useEffect, useState } from 'react';
import { Calendar, Loader2, RefreshCw, Video, Mic, Dot, FileText, AlertCircle } from 'lucide-react';
import { kindColorVar, kindTint } from '../../../components/shared/kindColors';
import useTranslation from '../../../hooks/useTranslation';
import { openGoogleOAuthPopup } from '../../../lib/googleOAuthPopup';
import { API_BASE, authFetch } from '../../../utils/helpers';
import TagRow from '../detail/TagRow';
import { listTalkMeetings, setMeetingRecord, listGoogleMeetMeetings, setGoogleMeetMeetingRecord } from '../lib/transcriptionsApi';
import { metaSegments, meetingTags, dateBlockParts, recordReasonHint, toggleStateLabel, attendeeNotices } from '../lib/upcomingMeta';

/**
 * "Upcoming" (Gepland): the calendar meetings with a Talk room or a Meet
 * link, each with a record/skip toggle. Colours are theme tokens only — the
 * Nextcloud blue and Meet green that used to be hard-coded here are gone
 * (repo-wide token hygiene): a provider tile is the meeting kind's tint, a
 * live toggle is the accent, and the status chips read --success / --warning
 * with their -ink twins for text.
 *
 * `onRowsChange(count)` reports how many meetings are listed, so the rail's
 * "Upcoming n" segment can carry the count while this panel is not the one
 * on screen (the page keeps it mounted, hidden, once a source is connected).
 *
 * ── DE RIJ (M5) ───────────────────────────────────────────────────────
 * Datumblok links, dan titel + statuschip, dan de metaregel
 * `tijd · duur · deelnemers · provider`, en daaronder de tags van deze
 * vergadering. De toggle rechts is de EFFECTIEVE opnamestand die de server
 * uit `meeting_prefs` afleidt (`excluded` + `recordReason`) — deze component
 * beslist niets zelf, hij toont die stand en schrijft de keuze terug.
 *
 * ── WAT WE NIET WETEN, ZEGGEN WE NIET ─────────────────────────────────
 * Duur, deelnemers en de voetregel zitten in `../lib/upcomingMeta.js`, met de
 * bronverwijzingen erbij. Kort: geen provider levert een duur (die wordt uit
 * `end - start` afgeleid en is bij een ontbrekend einde of een hele dag
 * ONBEKEND — dan staat er niets, geen "0 min"), en een lege deelnemerslijst
 * betekent "de agenda vertelde ons niets", niet "nul mensen": die wordt
 * "participants unknown" en nooit "0 participants". Een nul die eigenlijk
 * onbekend is, was in dit programma al drie keer een bevinding.
 *
 * De voetregel belooft alleen wat de bot echt doet, per provider — en zwijgt
 * over wat de payload niet zegt (`attendeeNotices`).
 *
 * ── AFWIJKING VAN HET ARTBOARD: GEEN TEAMS-RIJ ────────────────────────
 * Het artboard tekent naast Talk en Meet ook een Teams-rij. Die staat hier
 * bewust niet. Preciezer dan "Teams heeft geen bron": de AGENDA-bron bestaat
 * wél en is zelfs rijker dan die van Talk (server/integrations/
 * msCalendarTools.js:167-187 levert start/end, attendees[{email,name,status}]
 * en onlineMeeting.joinUrl). Wat ontbreekt is (a) een Meeting-Notes-koppeling
 * — er is geen `/api/transcriptions/teams-meetings` en geen msCalendar-variant
 * van talkCalendar/gmeetCalendar — en (b) een OPNAME-bron: Talk start de
 * opname zelf, Meet oogst uit Drive, en voor Teams heeft deze codebase geen
 * equivalent. Een Teams-rij zou dus een toggle tonen die niets aanzet.
 */

const Toggle = ({ on, onClick, disabled, label, title }) => (
    <button
        type="button" onClick={onClick} disabled={disabled} aria-pressed={on} aria-label={label} title={title}
        className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
        style={{ background: on ? 'var(--accent-primary)' : 'var(--border-default)', opacity: disabled ? 0.45 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
        <div className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full shadow transition-transform"
            style={{ transform: on ? 'translateX(20px)' : 'translateX(0)', background: 'var(--bg-card)' }} />
    </button>
);

function StatusChip({ status, onOpenNote, t }) {
    const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium';
    const meetTint = { background: kindTint('meeting', 14), color: kindColorVar('meeting') };
    const muted = { background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' };
    switch (status) {
        case 'recording_now':
            return <span className={base} style={meetTint}><Dot className="w-3.5 h-3.5 animate-pulse" aria-hidden="true" /> {t('meetings.upcoming_recording', 'Recording')}</span>;
        case 'will_record':
            return <span className={base} style={meetTint}>{t('meetings.upcoming_will_record', 'Will record')}</span>;
        case 'recorded':
            return (
                <button type="button" onClick={onOpenNote} className={base} style={{ background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: 'var(--success-ink)' }}>
                    <FileText className="w-3 h-3" aria-hidden="true" /> {t('meetings.upcoming_note_created', 'Note created')}
                </button>
            );
        case 'decides_at_start':
            // Niet "Upcoming": de server gaat bij de start van het gesprek nog
            // tellen wie er echt in zit. Een kale "Upcoming" leest als "er
            // gebeurt niets", en dat is precies wat er dan wél kan gebeuren.
            return (
                <span className={base} style={muted} title={t('meetings.upcoming_decides_hint', 'Bee Flow counts who is in the call when it starts; the calendar invite does not say.')}>
                    {t('meetings.upcoming_decides', 'Decides at start')}
                </span>
            );
        case 'not_moderator':
            return <span className={base} style={muted}>{t('meetings.upcoming_not_moderator', 'Not a moderator')}</span>;
        case 'not_organizer':
            return <span className={base} style={muted}>{t('meetings.upcoming_organizer_only', 'Organizer only')}</span>;
        case 'manual_record':
            return (
                <span className={base} title={t('meetings.upcoming_manual_hint', 'Start the recording in Google Meet — it will be imported afterwards.')} style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', color: 'var(--warning-ink)' }}>
                    {t('meetings.upcoming_record_in_meet', 'Record in Meet')}
                </span>
            );
        default:
            return <span className={base} style={muted}>{t('meetings.upcoming_upcoming', 'Upcoming')}</span>;
    }
}

/**
 * De providerchip sluit de metaregel af. Het glyph is de opnamevorm die deze
 * provider gebruikt (Talk: audio of video, uit `recordingMode`; Meet: video),
 * zodat die informatie niet wegvalt nu het datumblok de tegel links inneemt.
 */
function ProviderChip({ provider, icon: Icon }) {
    return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0"
            style={{ background: kindTint('meeting', 12), color: kindColorVar('meeting') }}>
            {Icon ? <Icon className="w-2.5 h-2.5" aria-hidden="true" /> : null}
            {provider === 'gmeet' ? 'Meet' : 'Talk'}
        </span>
    );
}

// Chip status for a Meet row, derived locally so the optimistic exclusion
// toggle updates the chip without a round-trip (mirrors the server's status
// logic, plus the host-controls-recording refinement).
function gmeetChipStatus(m, autoImport) {
    if (m.status === 'not_organizer') return 'not_organizer';
    if (m.importedNoteId || m.status === 'imported') return 'recorded';
    if (m.excluded || !autoImport) return 'upcoming';
    return m.recordingControlledByHost ? 'manual_record' : 'will_record';
}

/**
 * Het datumblok. Zonder begintijd (talkCalendar geeft `start: ev.dtstart || null`)
 * staat er een agendaglyph met uitleg, geen verzonnen datum.
 */
function DateBlock({ start, t }) {
    const parts = dateBlockParts(start);
    const tile = { background: kindTint('meeting', 16), color: kindColorVar('meeting') };
    if (!parts) {
        return (
            <div className="w-9 h-10 rounded-lg grid place-items-center flex-shrink-0" style={tile}
                title={t('meetings.upcoming_no_start', 'This meeting has no start time in the calendar.')} data-testid="upcoming-date">
                <Calendar className="w-[15px] h-[15px]" aria-hidden="true" />
            </div>
        );
    }
    return (
        <div className="w-9 h-10 rounded-lg flex flex-col items-center justify-center flex-shrink-0 leading-none" style={tile} data-testid="upcoming-date">
            <span className="text-[9px] uppercase tracking-wide opacity-80">{parts.weekday}</span>
            <span className="text-[14px] font-semibold">{parts.day}</span>
            <span className="text-[8px] uppercase tracking-wide opacity-80">{parts.month}</span>
        </div>
    );
}

function UpcomingMeetingRow({ provider, icon: Icon, meeting, status, noteId, onOpenNote, record, toggleDisabled, onToggle, error, overridden, t }) {
    const segments = metaSegments(meeting, t);
    const tags = meetingTags(meeting);
    const title = meeting.title || t('meetings.untitled', 'Untitled meeting');
    return (
        <div className="rounded-lg mb-1" style={{ background: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)' }}>
            <div className="flex items-start gap-2.5 px-2.5 py-2">
                <DateBlock start={meeting.start} t={t} />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{title}</span>
                        <StatusChip status={status} onOpenNote={() => noteId && onOpenNote?.(noteId)} t={t} />
                    </div>
                    <div className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5 mt-0.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }} data-testid="upcoming-meta">
                        {segments.map((seg, i) => (
                            <React.Fragment key={seg.key}>
                                {i > 0 && <span aria-hidden="true">·</span>}
                                <span title={seg.title} style={seg.dim ? { fontStyle: 'italic' } : undefined}>{seg.text}</span>
                            </React.Fragment>
                        ))}
                        {segments.length > 0 && <span aria-hidden="true">·</span>}
                        <ProviderChip provider={provider} icon={Icon} />
                    </div>
                    {tags.length > 0 && (
                        <div className="mt-1">
                            <TagRow tags={tags} canEdit={false} />
                        </div>
                    )}
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <Toggle
                        on={record}
                        disabled={toggleDisabled}
                        onClick={onToggle}
                        label={t('meetings.upcoming_toggle_label', 'Record {title}', { title })}
                        title={recordReasonHint(meeting.recordReason, record, t, {
                            recordDecided: meeting.recordDecided,
                            overridden,
                        })}
                    />
                    <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                        {toggleStateLabel(record, meeting.recordDecided, t)}
                    </span>
                </div>
            </div>
            {error && (
                <div className="px-3 pb-2 text-[11px] truncate" style={{ color: 'var(--error)' }}>{error}</div>
            )}
        </div>
    );
}

const WARN_BANNER = {
    background: 'color-mix(in srgb, var(--warning) 8%, var(--bg-secondary))',
    borderColor: 'var(--warning)',
    color: 'var(--text-primary)',
};
const ERROR_BANNER = {
    background: 'color-mix(in srgb, var(--error) 8%, var(--bg-secondary))',
    borderColor: 'var(--error)',
    color: 'var(--text-primary)',
};

export default function UpcomingMeetings({ onOpenNote, onRowsChange }) {
    const { t } = useTranslation();
    const [talk, setTalk] = useState({ loading: true, error: null, data: null }); // { recordingEnabled, recordingMode, meetings }
    const [gmeet, setGmeet] = useState({ loading: true, error: null, data: null }); // { connection, autoImport, meetings }
    const [busyKey, setBusyKey] = useState(null);
    const [gmeetRowErrors, setGmeetRowErrors] = useState({}); // eventId → message
    // rowKey → true zodra de server meldde dat een BREDERE regel de keuze van
    // deze gebruiker overruled (org-breed, of de hele serie). Alleen dán krijgt
    // `opted_out` een uitleg: bij een eigen klik is die overbodig.
    const [overridden, setOverridden] = useState({});
    const [reconnecting, setReconnecting] = useState(false);

    const loadTalk = async () => {
        setTalk(s => ({ ...s, loading: true, error: null }));
        try { setTalk({ loading: false, error: null, data: await listTalkMeetings() }); }
        catch (err) { setTalk(s => ({ ...s, loading: false, error: err })); }
    };
    const loadGmeet = async () => {
        setGmeet(s => ({ ...s, loading: true, error: null }));
        try { setGmeet({ loading: false, error: null, data: await listGoogleMeetMeetings() }); }
        catch (err) { setGmeet(s => ({ ...s, loading: false, error: err })); }
    };
    const load = () => { setGmeetRowErrors({}); setOverridden({}); loadTalk(); loadGmeet(); };
    useEffect(() => { load(); }, []);

    const loading = talk.loading || gmeet.loading;
    const recordingEnabled = !!talk.data?.recordingEnabled;
    const recordingMode = talk.data?.recordingMode || 'audio';
    const connection = gmeet.data?.connection || null;
    const meetScopesGranted = connection?.meetScopesGranted === true;
    const autoImport = !!gmeet.data?.autoImport;
    // Bewust NIET met `!!`: `undefined` (het veld ontbreekt in de payload) is
    // hier "onbekend" en moet iets anders opleveren dan een expliciete `false`.
    const postSummaryBack = talk.data ? talk.data.postSummaryBack : undefined;

    const talkMeetings = (!talk.loading && !talk.error && talk.data?.meetings) || [];
    const gmeetMeetings = (!gmeet.loading && !gmeet.error && gmeet.data?.meetings) || [];
    // De EFFECTIEVE chipstatus reist mee in de rij: de voetregel hangt eraan,
    // en die mag niet op `!excluded` afgaan — dat is de stand van de schakelaar,
    // niet de uitkomst (zie attendeeNotices).
    const rows = [
        ...talkMeetings.map(m => ({ provider: 'talk', key: `talk:${m.uid || ''}:${m.talkToken}`, start: m.start, m, status: m.status })),
        ...gmeetMeetings.map(m => ({ provider: 'gmeet', key: `gmeet:${m.eventId}`, start: m.start, m, status: gmeetChipStatus(m, autoImport) })),
    ].sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime());

    // Report the count once both sources have answered; while loading the
    // segment shows no number rather than a 0 that would read as "none".
    // FAALDEN BEIDE bronnen, dan is het aantal ONBEKEND en niet nul: "Upcoming
    // 0" leest als "je hebt geen vergaderingen", terwijl het "we konden ze
    // niet ophalen" is. Eén werkende bron is wél een antwoord (de andere toont
    // zijn eigen foutbanner in het paneel).
    const bothFailed = !!talk.error && !!gmeet.error;
    const rowCount = (loading || bothFailed) ? null : rows.length;
    useEffect(() => { onRowsChange?.(rowCount); }, [rowCount, onRowsChange]);

    const notices = attendeeNotices({
        rows,
        postSummaryBack,
        // Kan DEZE knop Meets eigen auto-opname aanzetten? Alleen dan mag de
        // zin over de opnamemelding er staan (server: settings.autoRecordConfig
        // + connection.hasSettingsScope + organizerSelf).
        meetAutoRecordArmed: gmeet.data?.autoRecordConfig === true && connection?.hasSettingsScope === true,
    });

    /**
     * De PATCH ANTWOORDT met de stand die ná de schrijf geldt (`effectiveRecord`
     * + `overridden`), niet met een echo van de vraag. Eén FALSE wint — de
     * org-brede rij, of de rij op de andere id-ruimte — en die kon de gebruiker
     * dus niet aanzetten. Vroeger sprong de rij dan optimistisch op "Record",
     * stond hij bij de volgende load weer op "Skip", en had het scherm nergens
     * gezegd waarom. Nu neemt de rij het antwoord van de server over en krijgt
     * de toggle een uitleg (`overridden` → recordReasonHint).
     */
    const toggleTalk = async (m) => {
        const nextRecord = m.excluded; // excluded → turning ON; else turning OFF
        setBusyKey(`talk:${m.talkToken}`);
        // optimistic
        setTalk(s => s.data ? { ...s, data: { ...s.data, meetings: s.data.meetings.map(x => x.talkToken === m.talkToken ? { ...x, excluded: !nextRecord } : x) } } : s);
        try {
            const body = await setMeetingRecord(m.talkToken, nextRecord, m.uid);
            const effective = typeof body?.effectiveRecord === 'boolean' ? body.effectiveRecord : nextRecord;
            setOverridden(prev => ({ ...prev, [`talk:${m.talkToken}`]: body?.overridden === true }));
            setTalk(s => s.data ? {
                ...s,
                data: {
                    ...s.data,
                    meetings: s.data.meetings.map(x => x.talkToken === m.talkToken
                        ? { ...x, excluded: !effective, recordReason: effective ? 'opted_in' : 'opted_out', recordDecided: true }
                        : x),
                },
            } : s);
        } catch (_) {
            // revert + reload to be safe
            await loadTalk();
        } finally {
            setBusyKey(null);
        }
    };

    const toggleGmeet = async (m) => {
        const nextRecord = m.excluded;
        setBusyKey(`gmeet:${m.eventId}`);
        setGmeetRowErrors(prev => {
            if (!(m.eventId in prev)) return prev;
            const next = { ...prev }; delete next[m.eventId]; return next;
        });
        // optimistic
        setGmeet(s => s.data ? { ...s, data: { ...s.data, meetings: s.data.meetings.map(x => x.eventId === m.eventId ? { ...x, excluded: !nextRecord } : x) } } : s);
        try {
            const body = await setGoogleMeetMeetingRecord(m.eventId, nextRecord, { meetingCode: m.meetingCode });
            const effective = typeof body?.effectiveRecord === 'boolean' ? body.effectiveRecord : nextRecord;
            setOverridden(prev => ({ ...prev, [`gmeet:${m.eventId}`]: body?.overridden === true }));
            setGmeet(s => s.data ? {
                ...s,
                data: {
                    ...s.data,
                    meetings: s.data.meetings.map(x => x.eventId === m.eventId
                        ? { ...x, excluded: !effective, recordReason: effective ? 'opted_in' : 'opted_out', recordDecided: true }
                        : x),
                },
            } : s);
        } catch (err) {
            if (err?.code) setGmeetRowErrors(prev => ({ ...prev, [m.eventId]: err.message || t('meetings.upcoming_update_failed', "Couldn't update this meeting.") }));
            // revert by reloading the Meet slice
            await loadGmeet();
        } finally {
            setBusyKey(null);
        }
    };

    const reconnectGoogle = async () => {
        setReconnecting(true);
        try {
            await openGoogleOAuthPopup({ authFetch, apiBase: API_BASE });
            await loadGmeet();
        } catch (_) {
            // popup blocked / auth-url failed — the banner stays, user can retry
        } finally {
            setReconnecting(false);
        }
    };

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {t('meetings.upcoming_intro', 'Your upcoming meetings — toggle which ones to auto-record.')}
                </span>
                <button
                    type="button" onClick={load} disabled={loading}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium border disabled:opacity-50 flex-shrink-0"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                >
                    <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /> {t('meetings.upcoming_refresh', 'Refresh')}
                </button>
            </div>

            {!talk.loading && !talk.error && talk.data && !recordingEnabled && (
                <div className="mx-3 mb-2 flex items-start gap-2 px-3 py-2 rounded-lg border text-[11px]" style={WARN_BANNER}>
                    <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
                    <span>{t('meetings.upcoming_talk_backend', "The Nextcloud Talk recording backend isn't configured, so auto-record is unavailable. You can still import finished recordings.")}</span>
                </div>
            )}

            {!gmeet.loading && !gmeet.error && connection?.googleConnected === false && (
                <div className="mx-3 mb-2 flex items-start gap-2 px-3 py-2 rounded-lg border text-[11px]" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                    <Video className="w-4 h-4 flex-shrink-0" style={{ color: kindColorVar('meeting') }} aria-hidden="true" />
                    <span>
                        {t('meetings.upcoming_connect_google', 'Connect Google Workspace to see your Meet meetings here —')}{' '}
                        <a href="/app/settings/integrations" className="underline" style={{ color: 'var(--accent-primary)' }}>{t('meetings.upcoming_settings_integrations', 'Settings → Integrations')}</a>.
                    </span>
                </div>
            )}

            {!gmeet.loading && !gmeet.error && connection && connection.googleConnected !== false && !meetScopesGranted && (
                <div className="mx-3 mb-2 flex items-center gap-2 px-3 py-2 rounded-lg border text-[11px]" style={WARN_BANNER}>
                    <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
                    <span className="flex-1">{t('meetings.upcoming_meet_scopes', "Your Google connection doesn't include Meet permissions yet — reconnect to enable auto-import.")}</span>
                    <button
                        type="button" onClick={reconnectGoogle} disabled={reconnecting}
                        className="px-2 py-1 rounded-lg text-[11px] font-medium border disabled:opacity-50 flex-shrink-0"
                        style={{ borderColor: 'var(--warning)', color: 'var(--warning-ink)' }}
                    >
                        {reconnecting ? t('meetings.upcoming_reconnecting', 'Reconnecting…') : t('meetings.upcoming_reconnect', 'Reconnect')}
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto px-3 pb-3">
                {loading && (
                    <div className="flex items-center gap-2 px-3 py-6 justify-center">
                        <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('meetings.upcoming_loading', 'Loading meetings…')}</span>
                    </div>
                )}

                {!talk.loading && talk.error && (
                    <div className="flex flex-col gap-1 px-3 py-2.5 rounded-lg border text-[11px] mb-1" style={ERROR_BANNER}>
                        <div className="font-semibold">{t('meetings.upcoming_talk_failed', "Couldn't load Nextcloud Talk meetings")}</div>
                        <div style={{ color: 'var(--text-secondary)' }}>{talk.error.message}</div>
                    </div>
                )}

                {!gmeet.loading && gmeet.error && (
                    <div className="flex flex-col gap-1 px-3 py-2.5 rounded-lg border text-[11px] mb-1" style={ERROR_BANNER}>
                        <div className="font-semibold">{t('meetings.upcoming_meet_failed', "Couldn't load Google Meet meetings")}</div>
                        <div style={{ color: 'var(--text-secondary)' }}>{gmeet.error.message}</div>
                    </div>
                )}

                {!loading && !talk.error && !gmeet.error && rows.length === 0 && (
                    <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
                        <div className="w-12 h-12 rounded-2xl grid place-items-center" style={{ background: kindTint('meeting', 12), color: kindColorVar('meeting') }} aria-hidden="true">
                            <Calendar className="w-6 h-6" />
                        </div>
                        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('meetings.upcoming_empty_title', 'No upcoming meetings')}</div>
                        <div className="text-[11px] max-w-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {t('meetings.upcoming_empty_desc', 'Meetings in your calendar with a Nextcloud Talk conversation or a Google Meet link show up here.')}
                        </div>
                    </div>
                )}

                {rows.map(({ provider, key, m, status }) => provider === 'talk' ? (
                    <UpcomingMeetingRow
                        key={key}
                        provider="talk"
                        icon={recordingMode === 'video' ? Video : Mic}
                        meeting={m}
                        status={m.status}
                        noteId={m.recordedNoteId}
                        onOpenNote={onOpenNote}
                        record={!m.excluded}
                        toggleDisabled={!recordingEnabled || m.isModerator === false || busyKey === `talk:${m.talkToken}`}
                        onToggle={() => toggleTalk(m)}
                        overridden={overridden[`talk:${m.talkToken}`] === true}
                        t={t}
                    />
                ) : (
                    <UpcomingMeetingRow
                        key={key}
                        provider="gmeet"
                        icon={Video}
                        meeting={m}
                        status={status}
                        noteId={m.importedNoteId}
                        onOpenNote={onOpenNote}
                        record={!m.excluded}
                        toggleDisabled={!meetScopesGranted || busyKey === `gmeet:${m.eventId}`}
                        onToggle={() => toggleGmeet(m)}
                        overridden={overridden[`gmeet:${m.eventId}`] === true}
                        error={gmeetRowErrors[m.eventId]}
                        t={t}
                    />
                ))}
            </div>

            {notices.length > 0 && (
                <div className="px-3 py-2 border-t flex flex-col gap-1 text-[11px] flex-shrink-0"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }} data-testid="upcoming-notice">
                    {notices.map(n => <span key={n.key}>{t(n.key, n.en)}</span>)}
                </div>
            )}
        </div>
    );
}
