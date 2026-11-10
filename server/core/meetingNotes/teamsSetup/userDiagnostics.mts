/**
 * The user's own Teams test (catalogue 3.2), run by POST /api/teams-setup/me/diagnostics.
 *
 * Every probe is read-only and goes through the import pipeline's own
 * functions (teamsCalendar, teamsArtifacts), with the same session the
 * pipeline would use, so the test fails exactly where an import would. Nothing
 * ever PATCHes a meeting: auto-record is a scope check only.
 *
 * What the report keeps of a probe: counts, booleans, the probe kind and the
 * stable codes. Never a meeting subject, attendee, join URL, meeting id, Graph
 * body or transcript text (the transcript content probe discards the text as
 * soon as it arrives).
 */

import { createRequire } from 'node:module';
import { microsoftCredentialsFor } from '../../../auth/oauth/microsoftConnections.mts';
import { buildReport, firstNonPass, PROBE_TIMEOUT, raceProbe, skippedCheck, toCheck } from './checks.mts';
import type { CheckOption, Outcome, TeamsCheck, TeamsDiagnosticsReport, Fixer } from './checks.mts';
import { fromGraphError } from './graphOutcome.mts';
import type { GraphContext } from './graphOutcome.mts';
import { tokenOutcome } from './appRegistration.mts';
import type { AuthConfigLike } from './appRegistration.mts';
import { probeTimeoutMs } from './limits.mts';

const nodeRequire = createRequire(import.meta.url);

type Meeting = { eventId?: string; start?: string | null; end?: string | null; organizerSelf?: boolean; joinUrl?: string | null };
type Artifact = { id?: string; createdDateTime?: string };
type SessionLike = { oauthProvider?: string; accessToken?: string; oauthScope?: string } & Record<string, unknown>;
type SkipState = { reason: string; missingPermissions: string[]; at: string; orgId: string | null };
type TeamsSettings = { autoImport: boolean; autoRecordConfig: boolean };

export interface UserDiagnosticsDeps {
    hasCapability: (capId: string, ctx: { userId: string; orgId: string | null }) => Promise<boolean>;
    settings: {
        resolveTeamsNotesSettings: (a: { orgId: string | null; userId: string }) => Promise<TeamsSettings>;
        getOrgSettings: (orgId: string) => Promise<Record<string, unknown>>;
        missingTeamsPermissions: (scope: string | null | undefined, opts?: { includeOptional?: boolean }) => string[];
    };
    skipState: { readSkips: (userIds: string[]) => Promise<Map<string, SkipState>> };
    /** Whether the poller still visits the user (autoImportCandidate.mts); a stored skip counts only then. */
    candidate: { isAutoImportCandidate: (a: { userId: string; orgId: string | null; autoImport?: boolean }) => Promise<boolean> };
    calendar: {
        listRecentlyEndedTeamsMeetings: (a: { session: unknown; lookbackHours: number; graceMinutes: number }) => Promise<Meeting[]>;
        listUpcomingTeamsMeetings: (a: { session: unknown; windowHours: number }) => Promise<Meeting[]>;
    };
    artifacts: {
        getOnlineMeetingByJoinUrl: (session: unknown, joinUrl: string) => Promise<Record<string, unknown> | null>;
        listRecordings: (session: unknown, meetingId: string) => Promise<Artifact[]>;
        listTranscripts: (session: unknown, meetingId: string) => Promise<Artifact[]>;
        fetchTranscriptVtt: (session: unknown, a: { meetingId: string; transcriptId: string }) => Promise<unknown>;
    };
    log: { warn: (...args: unknown[]) => void };
}

type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<UserDiagnosticsDeps>({
    hasCapability: () => (nodeRequire('../../entitlements/entitlements.js') as Pick<UserDiagnosticsDeps, 'hasCapability'>).hasCapability,
    settings: () => nodeRequire('../teamsNotesSettings.js'),
    skipState: () => nodeRequire('../teamsImportSkipState.mts'),
    candidate: () => nodeRequire('./autoImportCandidate.mts'),
    calendar: () => nodeRequire('../teamsCalendar.js'),
    artifacts: () => nodeRequire('../teamsArtifacts.js'),
    log: () => nodeRequire('../../../telemetry/log.js'),
});

/** Test seam: swap collaborators (the rest stay the real ones). */
export function init(overrides: Partial<UserDiagnosticsDeps> = {}): void { lazy.init(overrides); }

export interface UserDiagnosticsInput {
    userId: string;
    orgId: string | null;
    config: AuthConfigLike;
    /** The caller's verified Microsoft tenant (users.azureTenantId), or null. */
    callerTenantId: string | null;
    /** The session resolveTeamsSession(req) picked, or null. */
    session: unknown;
    /** req.session, to tell a sign-in session from a stored connection and read its scope. */
    reqSession: SessionLike | null;
    /** The vault row (automation_credentials, provider microsoft), or null. */
    credential: { status?: string; scope?: string | null } | null;
    timeoutMs?: number;
    now?: Date;
}

const SCOPE_CALENDAR = 'Calendars.ReadWrite';
const SCOPE_RECORDINGS = 'OnlineMeetingRecording.Read.All';
const SCOPE_TRANSCRIPTS = 'OnlineMeetingTranscript.Read.All';
const SCOPE_MEETINGS_WRITE = 'OnlineMeetings.ReadWrite';

const SKIP_FIX: Readonly<Record<string, readonly [string, Fixer]>> = Object.freeze({
    not_licensed: ['grant_meeting_notes_access', 'org_admin'],
    no_credential: ['connect_for_background', 'user'],
    credential_needs_reauth: ['reconnect_microsoft', 'user'],
    credential_revoked: ['connect_microsoft', 'user'],
    missing_scopes: ['reconnect_to_grant', 'user'],
    session_unavailable: ['reconnect_microsoft', 'user'],
    app_token_failed: ['see_microsoft_error', 'org_admin'],
});

/** The remediation of an auto-import skip reason (catalogue 3.7). */
export function skipRemediation(reason: string): { fix: string | null; fixer: Fixer | null } {
    const row = SKIP_FIX[reason];
    return row ? { fix: row[0], fixer: row[1] } : { fix: null, fixer: null };
}

/** The scope of the session the Graph calls will carry (same rule as resolveTeamsSession). */
export function usedScopeOf(session: unknown, reqSession: SessionLike | null, credential: { scope?: string | null } | null): string | null {
    const own = reqSession?.oauthScope;
    if (session && session === reqSession && typeof own === 'string' && own.trim()) return own;
    const live = reqSession?.oauthProvider === 'microsoft' && !!reqSession?.accessToken;
    return credential?.scope || (live && typeof own === 'string' ? own : null) || null;
}

interface Ctx {
    input: UserDiagnosticsInput;
    timeoutMs: number;
    missing: string[];
    settings: TeamsSettings | null;
    probe: { joinUrl: string; kind: 'ended' | 'upcoming' } | null;
    meetingId: string | null;
    transcripts: Artifact[];
}

interface Spec {
    id: string;
    option: CheckOption;
    dependsOn: string[];
    /** Decides instead of the skip rule (the one exception of decision 15). */
    instead?: (done: Map<string, TeamsCheck>) => Outcome | null;
    run: (ctx: Ctx) => Promise<Outcome>;
}

async function probe<T>(ctx: Ctx, context: GraphContext, run: () => Promise<T>, then: (value: T) => Outcome): Promise<Outcome> {
    const r = await raceProbe(run, ctx.timeoutMs);
    if (r.ok) return then(r.value);
    if (r.timedOut) return { ...PROBE_TIMEOUT };
    return fromGraphError(r.error, { context });
}

async function settingsOf(ctx: Ctx): Promise<TeamsSettings> {
    if (!ctx.settings) ctx.settings = await lazy.deps.settings.resolveTeamsNotesSettings({ orgId: ctx.input.orgId, userId: ctx.input.userId });
    return ctx.settings;
}

function scopeCheck(name: string, missingStatus: 'fail' | 'warn', fix: string, fixer: Fixer) {
    return async (ctx: Ctx): Promise<Outcome> => (ctx.missing.includes(name)
        ? { status: missingStatus, code: 'scope_missing', params: { permission: name }, fix, fixer }
        : { status: 'pass', code: 'ok', params: { permission: name } });
}

async function productAccess(ctx: Ctx): Promise<Outcome> {
    let capability = false;
    try { capability = await lazy.deps.hasCapability('meeting_notes', { userId: ctx.input.userId, orgId: ctx.input.orgId }); } catch (err) {
        lazy.deps.log.warn('[TeamsSetup] capability check failed:', (err as Error).message);
    }
    return capability
        ? { status: 'pass', code: 'ok', params: { capability: true } }
        : { status: 'warn', code: 'capability_missing', params: { capability: false }, fix: 'grant_meeting_notes_access', fixer: 'org_admin' };
}

async function appConfigured(ctx: Ctx): Promise<Outcome> {
    return microsoftCredentialsFor(ctx.input.config)
        ? { status: 'pass', code: 'ok' }
        : { status: 'fail', code: 'app_not_configured', fix: 'configure_app_registration', fixer: 'platform_admin' };
}

async function connection(ctx: Ctx): Promise<Outcome> {
    const { session, reqSession, credential } = ctx.input;
    if (session) return { status: 'pass', code: 'ok', params: { source: session === reqSession ? 'sign_in' : 'connection' } };
    if (credential?.status === 'needs_reauth') return { status: 'fail', code: 'needs_reauth', fix: 'reconnect_microsoft', fixer: 'user' };
    return { status: 'fail', code: 'not_connected', fix: 'connect_microsoft', fixer: 'user' };
}

async function autoRecord(ctx: Ctx): Promise<Outcome> {
    const autoRecordConfig = (await settingsOf(ctx)).autoRecordConfig;
    const params = { permission: SCOPE_MEETINGS_WRITE, autoRecordConfig };
    if (!ctx.missing.includes(SCOPE_MEETINGS_WRITE)) return { status: 'pass', code: 'ok', params };
    return { status: autoRecordConfig ? 'fail' : 'warn', code: 'scope_missing', params, fix: 'reconnect_to_grant', fixer: 'user' };
}

const organised = (list: Meeting[]) => (Array.isArray(list) ? list : []).filter((m) => m && m.organizerSelf === true && typeof m.joinUrl === 'string' && m.joinUrl);
const timeOf = (v: string | null | undefined) => { const t = new Date(v || 0).getTime(); return Number.isFinite(t) ? t : 0; };

async function calendarCheck(ctx: Ctx): Promise<Outcome> {
    const session = ctx.input.session;
    return probe(ctx, 'calendar', async () => {
        const ended = organised(await lazy.deps.calendar.listRecentlyEndedTeamsMeetings({ session, lookbackHours: 168, graceMinutes: 0 }));
        const upcoming = ended.length ? [] : organised(await lazy.deps.calendar.listUpcomingTeamsMeetings({ session, windowHours: 48 }));
        return { ended, upcoming };
    }, ({ ended, upcoming }) => {
        const params = { endedOrganised: ended.length, upcoming: upcoming.length };
        const newestEnded = [...ended].sort((a, b) => timeOf(b.end) - timeOf(a.end))[0];
        const nextUp = [...upcoming].sort((a, b) => timeOf(a.start) - timeOf(b.start))[0];
        const pick = newestEnded ? { joinUrl: String(newestEnded.joinUrl), kind: 'ended' as const } : nextUp ? { joinUrl: String(nextUp.joinUrl), kind: 'upcoming' as const } : null;
        ctx.probe = pick;
        if (!pick) return { status: 'warn', code: 'no_teams_meetings', params, fix: 'schedule_test_meeting', fixer: 'user' };
        return { status: 'pass', code: 'ok', params };
    });
}

const NO_MEETING: Outcome = Object.freeze({ status: 'unknown', code: 'no_meeting_to_probe', fix: 'schedule_test_meeting', fixer: 'user' });

async function meetingLookup(ctx: Ctx): Promise<Outcome> {
    const target = ctx.probe;
    if (!target) return { ...NO_MEETING };
    return probe(ctx, 'meeting', () => lazy.deps.artifacts.getOnlineMeetingByJoinUrl(ctx.input.session, target.joinUrl), (meeting) => {
        if (!meeting || typeof meeting.id !== 'string') return { status: 'fail', code: 'meeting_not_available', fix: 'meeting_not_available', fixer: 'user' };
        ctx.meetingId = meeting.id;
        const params: Record<string, unknown> = { probe: target.kind };
        for (const k of ['allowRecording', 'allowTranscription', 'recordAutomatically']) {
            if (typeof meeting[k] === 'boolean') params[k] = meeting[k];
        }
        if (meeting.allowRecording === false) return { status: 'warn', code: 'recording_not_allowed', params, fix: 'allow_cloud_recording', fixer: 'teams_admin' };
        return { status: 'pass', code: 'ok', params };
    });
}

async function recordings(ctx: Ctx): Promise<Outcome> {
    const meetingId = String(ctx.meetingId);
    return probe(ctx, 'meeting', () => lazy.deps.artifacts.listRecordings(ctx.input.session, meetingId),
        (list) => ({ status: 'pass', code: 'ok', params: { count: Array.isArray(list) ? list.length : 0, probe: ctx.probe?.kind || 'ended' } }));
}

async function transcripts(ctx: Ctx): Promise<Outcome> {
    const meetingId = String(ctx.meetingId);
    return probe(ctx, 'meeting', () => lazy.deps.artifacts.listTranscripts(ctx.input.session, meetingId), (list) => {
        ctx.transcripts = Array.isArray(list) ? list.filter((t) => t && typeof t.id === 'string') : [];
        return { status: 'pass', code: 'ok', params: { count: ctx.transcripts.length } };
    });
}

async function transcriptContent(ctx: Ctx): Promise<Outcome> {
    const newest = [...ctx.transcripts].sort((a, b) => timeOf(b.createdDateTime) - timeOf(a.createdDateTime))[0];
    if (!newest?.id) return { status: 'unknown', code: 'no_transcript_to_probe', fix: null, fixer: null };
    const meetingId = String(ctx.meetingId);
    const transcriptId = newest.id;
    // The text is read and dropped at once: only whether it could be read counts.
    return probe(ctx, 'meeting', async () => { await lazy.deps.artifacts.fetchTranscriptVtt(ctx.input.session, { meetingId, transcriptId }); return true; },
        () => ({ status: 'pass', code: 'ok' }));
}

async function backgroundAccess(ctx: Ctx): Promise<Outcome> {
    const cred = ctx.input.credential;
    if (!cred) return { status: 'warn', code: 'no_stored_connection', fix: 'connect_for_background', fixer: 'user' };
    if (cred.status === 'needs_reauth') return { status: 'warn', code: 'stored_connection_expired', fix: 'reconnect_microsoft', fixer: 'user' };
    if (cred.status !== 'active') return { status: 'warn', code: 'no_stored_connection', fix: 'connect_for_background', fixer: 'user' };
    const missing = lazy.deps.settings.missingTeamsPermissions(cred.scope ?? null);
    if (missing.length) return { status: 'warn', code: 'stored_connection_missing_scopes', params: { missing }, fix: 'reconnect_to_grant', fixer: 'user' };
    return { status: 'pass', code: 'ok' };
}

async function storedSkip(ctx: Ctx): Promise<SkipState | null> {
    try {
        const skip = (await lazy.deps.skipState.readSkips([ctx.input.userId])).get(ctx.input.userId) || null;
        return skip && skip.orgId === ctx.input.orgId ? skip : null;
    } catch (err) {
        lazy.deps.log.warn('[TeamsSetup] auto-import skip state unreadable:', (err as Error).message);
        return null;
    }
}

/**
 * Whether the poller still visits the user. A skip recorded while they were a
 * candidate stays stored once they stop being one (the poller never visits
 * them again), so it counts only while this holds. Unreadable: the skip counts.
 */
async function stillCandidate(ctx: Ctx, autoImportOn: boolean): Promise<boolean> {
    try {
        return await lazy.deps.candidate.isAutoImportCandidate({ userId: ctx.input.userId, orgId: ctx.input.orgId, autoImport: autoImportOn });
    } catch (err) {
        lazy.deps.log.warn('[TeamsSetup] auto-import candidacy unreadable:', (err as Error).message);
        return true;
    }
}

async function autoImport(ctx: Ctx): Promise<Outcome> {
    const autoImportOn = (await settingsOf(ctx)).autoImport;
    const stored = await storedSkip(ctx);
    const skip = stored && await stillCandidate(ctx, autoImportOn) ? stored : null;
    if (skip) {
        const { fix, fixer } = skipRemediation(skip.reason);
        const missing = Array.isArray(skip.missingPermissions) ? skip.missingPermissions : [];
        return { status: 'warn', code: 'auto_import_skipped', params: { reason: skip.reason, at: skip.at, ...(missing.length ? { missing } : {}) }, fix, fixer };
    }
    if (autoImportOn) return { status: 'pass', code: 'ok' };
    let orgOff = false;
    if (ctx.input.orgId) {
        try { orgOff = (await lazy.deps.settings.getOrgSettings(ctx.input.orgId))?.autoImport === false; } catch (err) {
            lazy.deps.log.warn('[TeamsSetup] org Teams settings unreadable:', (err as Error).message);
        }
    }
    return orgOff
        ? { status: 'warn', code: 'auto_import_off', fix: 'turn_on_auto_import_org', fixer: 'org_admin' }
        : { status: 'warn', code: 'auto_import_off', fix: 'turn_on_auto_import', fixer: 'user' };
}

const noMeetingInstead = (done: Map<string, TeamsCheck>): Outcome | null => {
    const cal = done.get('a.calendar');
    return cal?.status === 'warn' && cal.code === 'no_teams_meetings' ? { ...NO_MEETING } : null;
};

const CATALOGUE: readonly Spec[] = Object.freeze([
    { id: 'product.access', option: 'A', dependsOn: [], run: productAccess },
    { id: 'app.configured', option: 'app', dependsOn: [], run: appConfigured },
    { id: 'app.token', option: 'app', dependsOn: ['app.configured'], run: (ctx: Ctx) => tokenOutcome({ config: ctx.input.config, callerTenantId: ctx.input.callerTenantId, primaryOnly: false, timeoutMs: ctx.timeoutMs }) },
    { id: 'a.connection', option: 'A', dependsOn: ['app.configured'], run: connection },
    { id: 'a.scope_calendar', option: 'A', dependsOn: ['a.connection'], run: scopeCheck(SCOPE_CALENDAR, 'fail', 'reconnect_to_grant', 'user') },
    { id: 'a.scope_recordings', option: 'A', dependsOn: ['a.connection'], run: scopeCheck(SCOPE_RECORDINGS, 'fail', 'admin_consent_needed', 'entra_admin') },
    { id: 'a.scope_transcripts', option: 'A', dependsOn: ['a.connection'], run: scopeCheck(SCOPE_TRANSCRIPTS, 'warn', 'admin_consent_needed', 'entra_admin') },
    { id: 'a.auto_record', option: 'A', dependsOn: ['a.connection'], run: autoRecord },
    { id: 'a.calendar', option: 'A', dependsOn: ['a.scope_calendar'], run: calendarCheck },
    { id: 'a.meeting_lookup', option: 'A', dependsOn: ['a.calendar'], instead: noMeetingInstead, run: meetingLookup },
    { id: 'a.recordings', option: 'A', dependsOn: ['a.meeting_lookup', 'a.scope_recordings'], run: recordings },
    { id: 'a.transcripts', option: 'A', dependsOn: ['a.meeting_lookup', 'a.scope_transcripts'], run: transcripts },
    { id: 'a.transcript_content', option: 'A', dependsOn: ['a.transcripts'], run: transcriptContent },
    { id: 'a.background_access', option: 'A', dependsOn: ['a.connection'], run: backgroundAccess },
    { id: 'a.auto_import', option: 'A', dependsOn: [], run: autoImport },
] as Spec[]);

/** The catalogue ids in report order (for the tests and the client mirror). */
export const USER_CHECK_IDS: readonly string[] = Object.freeze(CATALOGUE.map((s) => s.id));

export async function runUserDiagnostics(input: UserDiagnosticsInput): Promise<TeamsDiagnosticsReport> {
    const usedScope = usedScopeOf(input.session, input.reqSession, input.credential);
    const ctx: Ctx = {
        input,
        timeoutMs: input.timeoutMs ?? probeTimeoutMs(),
        missing: lazy.deps.settings.missingTeamsPermissions(usedScope, { includeOptional: true }),
        settings: null,
        probe: null,
        meetingId: null,
        transcripts: [],
    };
    const done = new Map<string, TeamsCheck>();
    for (const spec of CATALOGUE) {
        const instead = spec.instead?.(done) || null;
        const blocked = instead ? null : firstNonPass(done, spec.dependsOn);
        const check = blocked
            ? skippedCheck(spec, blocked)
            : toCheck(spec, instead || await spec.run(ctx), 'user');
        done.set(spec.id, check);
    }
    return buildReport('user', [...done.values()], input.now);
}
