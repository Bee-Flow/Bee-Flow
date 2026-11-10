/**
 * The organisation-wide import test (catalogue 3.5, `level: 'org_app'`), run
 * by POST /api/teams-setup/org/app-import/diagnostics for an organisation
 * admin of the caller's own organisation.
 *
 * It asks Entra for the app token of the organisation's verified tenant, reads
 * the application permissions from its `roles` claim (best effort: unreadable
 * roles let the Graph probes decide), and, for ONE covered member (the one the
 * admin picked, else the admin when covered), lists their calendar and looks
 * up one Teams meeting they organise, its recordings and transcripts with that
 * token: the calls the poller makes. A member who is not covered is never
 * probed, so before the setting is switched on only the app registration
 * checks run (b.coverage says not_enabled, the member probes are skipped). Read-only: nothing is written to Microsoft or to Bee Flow, and the
 * report holds codes, counts, permission names, the tenant and the client id;
 * never the token, a meeting, an attendee or the member's Microsoft identity.
 */

import { createRequire } from 'node:module';
import { microsoftCredentialsForTenant } from '../../../auth/oauth/microsoftConnections.mts';
import { buildReport, firstNonPass, PROBE_TIMEOUT, raceProbe, skippedCheck, toCheck } from '../teamsSetup/checks.mts';
import type { CheckStatus, Outcome, TeamsCheck, TeamsDiagnosticsReport } from '../teamsSetup/checks.mts';
import { fromGraphError } from '../teamsSetup/graphOutcome.mts';
import { tokenResultOutcome } from '../teamsSetup/appRegistration.mts';
import { appImportAllowed, probeTimeoutMs } from '../teamsSetup/limits.mts';
import { appImportState, coverageForUser } from './coverage.mts';
import type { AuthConfigLike, CoverageResult, TeamsAppImportState } from './coverage.mts';
import { orgVerifiedTenant } from './orgTenant.mts';
import type { OrgTenant } from './orgTenant.mts';
import { appSessionFor, getAppToken } from './appToken.mts';
import type { AppSession, AppToken, AppTokenFailure } from './appToken.mts';

const nodeRequire = createRequire(import.meta.url);

type Meeting = { start?: string | null; end?: string | null; organizerSelf?: boolean; joinUrl?: string | null };
type Artifact = { id?: string };

export interface AppImportDiagnosticsDeps {
    loadConfig: () => Promise<AuthConfigLike>;
    orgTenant: typeof orgVerifiedTenant;
    getAppToken: typeof getAppToken;
    appImportState: typeof appImportState;
    coverageForUser: typeof coverageForUser;
    calendar: {
        listRecentlyEndedTeamsMeetings: (a: { session: unknown; lookbackHours: number; graceMinutes: number }) => Promise<Meeting[]>;
        listUpcomingTeamsMeetings: (a: { session: unknown; windowHours: number }) => Promise<Meeting[]>;
    };
    artifacts: {
        getOnlineMeetingByJoinUrl: (session: unknown, joinUrl: string) => Promise<Record<string, unknown> | null>;
        listRecordings: (session: unknown, meetingId: string) => Promise<Artifact[]>;
        listTranscripts: (session: unknown, meetingId: string) => Promise<Artifact[]>;
    };
    log: { warn: (...args: unknown[]) => void };
}

type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<AppImportDiagnosticsDeps>({
    loadConfig: () => (nodeRequire('../../../auth/permissions.js') as Pick<AppImportDiagnosticsDeps, 'loadConfig'>).loadConfig,
    orgTenant: () => orgVerifiedTenant,
    getAppToken: () => getAppToken,
    appImportState: () => appImportState,
    coverageForUser: () => coverageForUser,
    calendar: () => nodeRequire('../teamsCalendar.js'),
    artifacts: () => nodeRequire('../teamsArtifacts.js'),
    log: () => nodeRequire('../../../telemetry/log.js'),
});

/** Test seam: swap collaborators (the rest stay the real ones). */
export function init(overrides: Partial<AppImportDiagnosticsDeps> = {}): void { lazy.init(overrides); }

export interface AppImportDiagnosticsInput {
    orgId: string;
    /** The admin running the test: the default probe member when covered. */
    callerId: string;
    /** A member the admin picked (the route checked it is a member of `orgId`). */
    probeUserId?: string | null;
    timeoutMs?: number;
    now?: Date;
}

interface Ctx {
    input: AppImportDiagnosticsInput;
    timeoutMs: number;
    config: AuthConfigLike;
    orgTenant: OrgTenant | null;
    token: AppToken | null;
    clientId: string | null;
    state: TeamsAppImportState | null;
    session: AppSession | null;
    probe: { joinUrl: string } | null;
    meetingId: string | null;
}

interface Spec {
    id: string;
    dependsOn: string[];
    /** Prerequisites that also count as passed with these statuses ("unknown counts as pass"). */
    passLike?: Record<string, CheckStatus[]>;
    instead?: (done: Map<string, TeamsCheck>) => Outcome | null;
    run: (ctx: Ctx) => Promise<Outcome>;
}

const UNKNOWN_IS_PASS: CheckStatus[] = ['unknown'];
const ROLE_MEETINGS = 'OnlineMeetings.Read.All';
const ROLE_RECORDINGS = 'OnlineMeetingRecording.Read.All';
const ROLE_CALENDAR = 'Calendars.Read';
const ROLE_TRANSCRIPTS = 'OnlineMeetingTranscript.Read.All';

async function probe<T>(ctx: Ctx, run: () => Promise<T>, then: (value: T) => Outcome): Promise<Outcome> {
    const r = await raceProbe(run, ctx.timeoutMs);
    if (r.ok) return then(r.value);
    if (r.timedOut) return { ...PROBE_TIMEOUT };
    return fromGraphError(r.error, { context: 'app' });
}

async function instance(): Promise<Outcome> {
    return appImportAllowed()
        ? { status: 'pass', code: 'ok' }
        : { status: 'fail', code: 'app_import_disabled_instance', fix: 'instance_disabled', fixer: 'platform_admin' };
}

async function orgTenantCheck(ctx: Ctx): Promise<Outcome> {
    const t = await lazy.deps.orgTenant(ctx.input.orgId, { fresh: true });
    ctx.orgTenant = t;
    if (t.ok) return { status: 'pass', code: 'ok', params: { tenantId: t.tenantId, source: t.source } };
    return { status: 'fail', code: t.reason, fix: 'bind_directory', fixer: 'platform_admin' };
}

async function appCredentials(ctx: Ctx): Promise<Outcome> {
    const tenantId = ctx.orgTenant?.ok ? ctx.orgTenant.tenantId : null;
    const creds = tenantId ? microsoftCredentialsForTenant(ctx.config, tenantId) : null;
    if (!creds) return { status: 'fail', code: 'app_not_configured', fix: 'configure_app_registration', fixer: 'platform_admin' };
    ctx.clientId = creds.clientId;
    return { status: 'pass', code: 'ok', params: { clientId: creds.clientId } };
}

function tokenFailureOutcome(f: AppTokenFailure, tenantId: string): Outcome {
    const r = f.result;
    if ('ok' in r) return tokenResultOutcome(r, { tenantId });
    if (r.kind === 'not_configured') return { status: 'fail', code: 'app_not_configured', fix: 'configure_app_registration', fixer: 'platform_admin' };
    // The tenant link moved between the checks, or Microsoft issued a token for another tenant.
    return { status: 'fail', code: 'entra_error_no_code', fix: 'see_microsoft_error', fixer: 'platform_admin' };
}

async function appTokenCheck(ctx: Ctx): Promise<Outcome> {
    const tenantId = ctx.orgTenant?.ok ? ctx.orgTenant.tenantId : '';
    const r = await raceProbe(() => lazy.deps.getAppToken({ orgId: ctx.input.orgId, tenantId }), ctx.timeoutMs);
    if (!r.ok) {
        if (r.timedOut) return { ...PROBE_TIMEOUT };
        // getAppToken returns every answer of the token endpoint, network failures
        // included (tokenFailureOutcome); a throw is Bee Flow's own read failing
        // (the tenant link, the configuration), so not a network problem.
        lazy.deps.log.warn('[TeamsAppImport] app token check failed inside Bee Flow:', (r.error as Error)?.message);
        return { status: 'unknown', code: 'graph_error', fix: 'try_again_later', fixer: 'user' };
    }
    if (!r.value.ok) return tokenFailureOutcome(r.value, tenantId);
    ctx.token = r.value;
    return { status: 'pass', code: 'ok', params: { tenantId } };
}

function roleCheck(permission: string, missingStatus: 'fail' | 'warn') {
    return async (ctx: Ctx): Promise<Outcome> => {
        const roles = ctx.token?.roles;
        if (!Array.isArray(roles)) return { status: 'unknown', code: 'roles_unreadable', fix: null, fixer: null };
        if (roles.includes(permission)) return { status: 'pass', code: 'ok', params: { permission } };
        return { status: missingStatus, code: 'role_missing', params: { permission }, fix: 'grant_application_permission', fixer: 'entra_admin' };
    };
}

async function stateOf(ctx: Ctx): Promise<TeamsAppImportState> {
    if (!ctx.state) ctx.state = await lazy.deps.appImportState(ctx.input.orgId);
    return ctx.state;
}

async function enabled(ctx: Ctx): Promise<Outcome> {
    const s = (await stateOf(ctx)).settings;
    return s.enabled
        ? { status: 'pass', code: 'ok', params: { coverage: s.coverage } }
        : { status: 'warn', code: 'not_enabled', fix: 'enable_app_import', fixer: 'org_admin' };
}

/**
 * Who is covered now. While the setting is off nobody is, and the app token is
 * never used for a member it does not cover (coverage.mts, rule 2), so the
 * member probes wait until it is switched on: the check says that, rather than
 * "nobody covered" with a sign-in remedy. The other counts are what the
 * setting would cover.
 */
async function coverageCheck(ctx: Ctx): Promise<Outcome> {
    const { counts, settings } = await stateOf(ctx);
    const params = { covered: counts.covered, withoutIdentity: counts.withoutIdentity, otherTenant: counts.otherTenant, withoutAccess: counts.withoutAccess, notSelected: counts.notSelected };
    if (!settings.enabled) return { status: 'warn', code: 'not_enabled', params, fix: 'enable_app_import', fixer: 'org_admin' };
    if (counts.covered > 0) return { status: 'pass', code: 'ok', params };
    return { status: 'warn', code: 'nobody_covered', params, fix: 'members_sign_in_with_microsoft', fixer: 'org_admin' };
}

async function probeUser(ctx: Ctx): Promise<Outcome> {
    const picked = ctx.input.probeUserId || null;
    const userId = picked || ctx.input.callerId;
    const coverage: CoverageResult = await lazy.deps.coverageForUser(userId, ctx.input.orgId, { fresh: true });
    if (!coverage.covered) {
        if (!picked) return { status: 'unknown', code: 'no_probe_user', fix: 'pick_probe_user', fixer: 'org_admin' };
        return { status: 'fail', code: 'probe_user_not_covered', params: { reason: coverage.reason }, fix: 'pick_probe_user', fixer: 'org_admin' };
    }
    if (!ctx.token) return { status: 'fail', code: 'probe_user_not_covered', params: { reason: 'app_not_configured' }, fix: 'pick_probe_user', fixer: 'org_admin' };
    ctx.session = appSessionFor(coverage, ctx.token);
    return { status: 'pass', code: 'ok', params: { self: userId === ctx.input.callerId } };
}

// The calendar probed is the probe member's, not the admin's: the admin's way
// forward is a member who organises Teams meetings, not a meeting of their own.
const PICK_ANOTHER_MEMBER = Object.freeze({ fix: 'pick_probe_user', fixer: 'org_admin' as const });

const organised = (list: Meeting[]) => (Array.isArray(list) ? list : []).filter((m) => m && m.organizerSelf === true && typeof m.joinUrl === 'string' && m.joinUrl);
const timeOf = (v: string | null | undefined) => { const t = new Date(v || 0).getTime(); return Number.isFinite(t) ? t : 0; };

async function calendar(ctx: Ctx): Promise<Outcome> {
    const session = ctx.session;
    return probe(ctx, async () => {
        const ended = organised(await lazy.deps.calendar.listRecentlyEndedTeamsMeetings({ session, lookbackHours: 168, graceMinutes: 0 }));
        const upcoming = ended.length ? [] : organised(await lazy.deps.calendar.listUpcomingTeamsMeetings({ session, windowHours: 48 }));
        return { ended, upcoming };
    }, ({ ended, upcoming }) => {
        const params = { endedOrganised: ended.length, upcoming: upcoming.length };
        const pick = [...ended].sort((a, b) => timeOf(b.end) - timeOf(a.end))[0] || [...upcoming].sort((a, b) => timeOf(a.start) - timeOf(b.start))[0];
        ctx.probe = pick ? { joinUrl: String(pick.joinUrl) } : null;
        if (!pick) return { status: 'warn', code: 'no_teams_meetings', params, ...PICK_ANOTHER_MEMBER };
        return { status: 'pass', code: 'ok', params };
    });
}

const NO_MEETING: Outcome = Object.freeze({ status: 'unknown', code: 'no_meeting_to_probe', ...PICK_ANOTHER_MEMBER });

async function accessPolicy(ctx: Ctx): Promise<Outcome> {
    const target = ctx.probe;
    if (!target) return { ...NO_MEETING };
    const outcome = await probe(ctx, () => lazy.deps.artifacts.getOnlineMeetingByJoinUrl(ctx.session, target.joinUrl), (meeting) => {
        if (!meeting || typeof meeting.id !== 'string') return { status: 'fail', code: 'meeting_not_available', fix: 'meeting_not_available', fixer: 'user' };
        ctx.meetingId = meeting.id;
        return { status: 'pass', code: 'ok' };
    });
    if (outcome.code === 'application_access_policy_missing' && ctx.clientId) return { ...outcome, params: { ...(outcome.params || {}), clientId: ctx.clientId } };
    return outcome;
}

async function recordings(ctx: Ctx): Promise<Outcome> {
    const meetingId = String(ctx.meetingId);
    return probe(ctx, () => lazy.deps.artifacts.listRecordings(ctx.session, meetingId),
        (list) => ({ status: 'pass', code: 'ok', params: { count: Array.isArray(list) ? list.length : 0 } }));
}

async function transcripts(ctx: Ctx): Promise<Outcome> {
    const meetingId = String(ctx.meetingId);
    return probe(ctx, () => lazy.deps.artifacts.listTranscripts(ctx.session, meetingId),
        (list) => ({ status: 'pass', code: 'ok', params: { count: Array.isArray(list) ? list.filter((t) => t && typeof t.id === 'string').length : 0 } }));
}

const noMeetingInstead = (done: Map<string, TeamsCheck>): Outcome | null => {
    const cal = done.get('b.calendar');
    return cal?.status === 'warn' && cal.code === 'no_teams_meetings' ? { ...NO_MEETING } : null;
};

const CATALOGUE: readonly Spec[] = Object.freeze([
    { id: 'b.instance', dependsOn: [], run: instance },
    { id: 'b.org_tenant', dependsOn: ['b.instance'], run: orgTenantCheck },
    { id: 'b.app_credentials', dependsOn: ['b.org_tenant'], run: appCredentials },
    { id: 'b.app_token', dependsOn: ['b.app_credentials'], run: appTokenCheck },
    { id: 'b.role_meetings', dependsOn: ['b.app_token'], run: roleCheck(ROLE_MEETINGS, 'fail') },
    { id: 'b.role_recordings', dependsOn: ['b.app_token'], run: roleCheck(ROLE_RECORDINGS, 'fail') },
    { id: 'b.role_calendar', dependsOn: ['b.app_token'], run: roleCheck(ROLE_CALENDAR, 'fail') },
    { id: 'b.role_transcripts', dependsOn: ['b.app_token'], run: roleCheck(ROLE_TRANSCRIPTS, 'warn') },
    { id: 'b.enabled', dependsOn: [], run: enabled },
    { id: 'b.coverage', dependsOn: ['b.org_tenant'], run: coverageCheck },
    { id: 'b.probe_user', dependsOn: ['b.coverage', 'b.app_token'], run: probeUser },
    { id: 'b.calendar', dependsOn: ['b.probe_user', 'b.role_calendar'], passLike: { 'b.role_calendar': UNKNOWN_IS_PASS }, run: calendar },
    { id: 'b.access_policy', dependsOn: ['b.calendar', 'b.role_meetings'], passLike: { 'b.role_meetings': UNKNOWN_IS_PASS }, instead: noMeetingInstead, run: accessPolicy },
    { id: 'b.recordings', dependsOn: ['b.access_policy', 'b.role_recordings'], passLike: { 'b.role_recordings': UNKNOWN_IS_PASS }, run: recordings },
    { id: 'b.transcripts', dependsOn: ['b.access_policy', 'b.role_transcripts'], passLike: { 'b.role_transcripts': UNKNOWN_IS_PASS }, run: transcripts },
] as Spec[]);

/** The catalogue ids in report order. */
export const APP_IMPORT_CHECK_IDS: readonly string[] = Object.freeze(CATALOGUE.map((s) => s.id));

export async function runAppImportDiagnostics(input: AppImportDiagnosticsInput): Promise<TeamsDiagnosticsReport> {
    const ctx: Ctx = {
        input,
        timeoutMs: input.timeoutMs ?? probeTimeoutMs(),
        config: await lazy.deps.loadConfig(),
        orgTenant: null,
        token: null,
        clientId: null,
        state: null,
        session: null,
        probe: null,
        meetingId: null,
    };
    const done = new Map<string, TeamsCheck>();
    for (const spec of CATALOGUE) {
        // The one exception of decision 15: no meeting on the calendar is "nothing to probe", not a
        // skip, as long as the other prerequisites hold.
        const instead = spec.instead?.(done) || null;
        const prerequisites = instead ? spec.dependsOn.filter((id) => id !== 'b.calendar') : spec.dependsOn;
        const blocked = firstNonPass(done, prerequisites, spec.passLike);
        const shape = { id: spec.id, option: 'B' as const, dependsOn: spec.dependsOn };
        const check = blocked
            ? skippedCheck(shape, blocked)
            : toCheck(shape, instead || await spec.run(ctx), 'org_app');
        done.set(spec.id, check);
    }
    return buildReport('org_app', [...done.values()], input.now);
}
