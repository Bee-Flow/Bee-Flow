/**
 * Port of agent-hub chatMonitoring/chatMonitoringPreview.ts (the DPIA view and missing codes),
 * pinned by preview.test.ts, which runs the web module beside it.
 *
 * The client-side preview of the server's missing codes (build spec 3.1),
 * for the form as it stands. Codes the browser cannot know (the default
 * bucket on an installation with organisations, a release without the
 * objection switch) are left to the server's 422.
 */
import {
    MISSING_CODES,
    addDaysUtc,
    buildPutBody,
    classifyChange,
    dayOf,
    defaultStartDate,
    isDay,
    isEmployeeSurface,
    isHttpsUrl,
    utcDay,
    type ChangeKind,
    type ChatMonitoringForm,
    type DpiaInfo,
    type MissingCode,
    type PreviewContext,
    type RiskLevel,
    type StoredSettings,
} from './form';

const DPIA_VALIDITY_DAYS = 365;

export interface DpiaView {
    kind: 'internal' | 'external' | 'none';
    current: boolean;
    riskLevel: RiskLevel | null;
    /** The last day it counts as current, or the day it expired. */
    expiresAt: string | null;
}

/**
 * The DPIA the preconditions read: an internal record (from the server) wins;
 * otherwise the external reference as typed in the form, current for a year
 * from its date and never from a date in the future.
 */
export function dpiaView(form: ChatMonitoringForm, server: DpiaInfo | null, now: Date): DpiaView {
    if (server?.kind === 'internal') {
        return { kind: 'internal', current: server.current, riskLevel: server.risk_level, expiresAt: dayOf(server.expires_at) || null };
    }
    if (form.dpia_external && form.dpia_ref.trim() && isDay(form.dpia_at)) {
        const today = utcDay(now);
        const expiresAt = addDaysUtc(form.dpia_at, DPIA_VALIDITY_DAYS);
        return { kind: 'external', current: form.dpia_at <= today && today < expiresAt, riskLevel: form.dpia_risk_level || null, expiresAt };
    }
    return { kind: 'none', current: false, riskLevel: null, expiresAt: null };
}

const missingOrFuture = (day: string, today: string): boolean => !isDay(day) || day > today;

function scopeIsWider(form: ChatMonitoringForm, before: StoredSettings): boolean {
    const stored = before.works_council_scope;
    if (!stored.surfaces.length) return false;
    const max = Number(form.scope_max_retention);
    return form.scope_surfaces.some((s) => !stored.surfaces.includes(s))
        || form.scope_signals.some((s) => !stored.signals.includes(s))
        || (Number.isFinite(max) && max > (stored.max_retention_days ?? 0));
}

/** The scope covers the selection, and its retention is a whole 30 to 90 days (the server refuses anything else). */
function scopeCovers(form: ChatMonitoringForm): boolean {
    const max = Number(form.scope_max_retention);
    if (!Number.isInteger(max) || max < 30 || max > 90) return false;
    return form.surfaces.filter(isEmployeeSurface).every((s) => form.scope_surfaces.includes(s))
        && form.signals.every((s) => form.scope_signals.includes(s))
        && Number(form.retention_days) <= max;
}

function worksCouncilCodes(form: ChatMonitoringForm, before: StoredSettings, today: string): MissingCode[] {
    const wc = form.works_council;
    if (!wc || wc === 'pending') return ['works_council'];
    if (wc === 'not_applicable') return form.works_council_reason ? [] : ['works_council_reason'];
    // consent or court_replacement: a date, and a scope that covers this with a newer date when it grew.
    const out: MissingCode[] = [];
    if (missingOrFuture(form.works_council_at, today)) out.push('works_council_at');
    const newerDate = form.works_council_at > dayOf(before.works_council_at);
    if (!scopeCovers(form) || (scopeIsWider(form, before) && !newerDate)) out.push('works_council_scope');
    return out;
}

function dpiaCodes(form: ChatMonitoringForm, ctx: PreviewContext, today: string): MissingCode[] {
    const dpia = dpiaView(form, ctx.dpia, ctx.now);
    const out: MissingCode[] = [];
    if (!dpia.current) out.push('dpia');
    if (dpia.kind === 'external' && !dpia.riskLevel) out.push('dpia_risk_level');
    if (dpia.riskLevel === 'high' && missingOrFuture(form.prior_consultation_at, today)) out.push('prior_consultation_at');
    if (ctx.dpoRecorded && missingOrFuture(form.dpo_advice_at, today)) out.push('dpo_advice_at');
    return out;
}

function noticeCodes(form: ChatMonitoringForm, startDay: string, today: string): MissingCode[] {
    const out: MissingCode[] = [];
    if (!isHttpsUrl(form.notice_url)) out.push('notice_url');
    const published = form.notice_published_at;
    if (missingOrFuture(published, today) || (startDay !== '' && published > startDay)) out.push('notice_published_at');
    return out;
}

function startCodes(form: ChatMonitoringForm, now: Date): MissingCode[] {
    if (!isDay(form.start_date) || form.start_date < utcDay(now)) return ['effective_from'];
    if (form.start_date < defaultStartDate(now) && !form.ack_informed_before_start) return ['informed_before_start'];
    return [];
}

function globalCodes(form: ChatMonitoringForm, ctx: PreviewContext, change: ChangeKind): MissingCode[] {
    const out: MissingCode[] = [];
    if (!form.surfaces.length) out.push('surfaces_required');
    if (!form.signals.includes('outcomes')) out.push('outcomes_required');
    if (!form.legal_basis) out.push('legal_basis');
    const liaOnFile = ctx.before.legal_basis === 'art6_1_f' && !!ctx.before.lia_at;
    if (form.legal_basis === 'art6_1_f' && !form.ack_lia_documented && !liaOnFile) out.push('lia_documented');
    const days = Number(form.retention_days);
    if (!Number.isInteger(days) || days < 30 || days > 90) out.push('retention_days');
    if (change.widen && !form.ack_notice_published) out.push('notice_published');
    if (change.widen && !form.ack_ropa_reviewed) out.push('ropa_reviewed');
    return out;
}

/**
 * The codes that would stop this save, in the server's order. Switching off
 * or only narrowing needs nothing; a widen or a maintain while on is
 * checked in full, the acknowledgements only on a widen.
 */
export function previewMissing(form: ChatMonitoringForm, ctx: PreviewContext): MissingCode[] {
    const change = classifyChange(ctx.before, buildPutBody(form, { enabled: true, now: ctx.now }));
    if (!change.widen && !change.maintain) return [];
    const today = utcDay(ctx.now);
    const codes = new Set<MissingCode>(globalCodes(form, ctx, change));
    if (change.employeeWidened) startCodes(form, ctx.now).forEach((c) => codes.add(c));
    if (form.surfaces.some(isEmployeeSurface)) {
        const startDay = change.employeeWidened ? form.start_date : dayOf(ctx.before.effective_from);
        [...dpiaCodes(form, ctx, today), ...worksCouncilCodes(form, ctx.before, today), ...noticeCodes(form, startDay, today)]
            .forEach((c) => codes.add(c));
    }
    if (form.surfaces.includes('agent_public') && !isHttpsUrl(form.notice_url) && !ctx.privacyNoticeUrlSet) codes.add('agent_public_notice');
    // A link that is typed but not https is refused whatever is selected.
    if (form.notice_url.trim() && !isHttpsUrl(form.notice_url)) codes.add('notice_url');
    return MISSING_CODES.filter((c) => codes.has(c));
}
