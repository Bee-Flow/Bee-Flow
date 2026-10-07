/**
 * Contract readers for chat signals, ported from the allow-list parsers of
 * agent-hub data/useChatMonitoring.ts (parseConfig, parseSettings,
 * parseEffective, parseCatalogue, parseDpia, parseBands, parseSummary,
 * parseRopa). A figure is a number, '<5', 'hidden' or null and nothing else:
 * anything unknown reads as hidden, never as a guess; the health kind is
 * never shown.
 */
import { field, pick, shapeOf, type FieldReader } from '@/core/api/contract';

import {
    DPIA_RISK_LEVELS,
    EMPLOYEE_SURFACES,
    LEGAL_BASES,
    RETENTION,
    SIGNALS,
    SURFACES,
    WORKS_COUNCIL,
    WORKS_COUNCIL_REASONS,
    type DpiaInfo,
    type StoredSettings,
    type Surface,
    type WorksCouncilScope,
} from '../model/chatSignals/form';
import type { NoticeTemplateInfo } from '../model/chatSignals/noticeText';
import type { RopaActivityView } from '../model/chatSignals/ropaPreview';

/** A shown figure: a number, "<5", "hidden" (suppressed), or null where it does not apply. */
export type Cell = number | '<5' | 'hidden' | null;

export interface PausedSurface {
    surface: string;
    missing: string[];
}

export interface ChatSignalsEffective {
    state: 'off' | 'scheduled' | 'on';
    from: string | null;
    surfaces: Surface[];
    paused: PausedSurface[];
    signals: string[];
}

export interface CatalogueSurface {
    id: string;
    population: 'employees' | 'visitors';
    available: boolean;
}

export interface ChatSignalsCatalogue {
    surfaces: CatalogueSurface[];
    retention: { min: number; max: number; default: number };
    k: { outcomes: number; kinds: number };
}

export interface ChatSignalsConfig {
    settings: StoredSettings;
    effective: ChatSignalsEffective;
    catalogue: ChatSignalsCatalogue;
    dpia: DpiaInfo;
    dpoRecorded: boolean;
    contributors: Record<string, string>;
    privacyNoticeUrlSet: boolean;
    template: NoticeTemplateInfo;
    canWiden: boolean;
    installHasOrganisations: boolean;
}

export interface KindRow {
    kind: string;
    protected: Cell;
    exposed: Cell;
}

export interface SurfaceFigures {
    status: 'shown' | 'suppressed' | 'no_full_period' | 'no_data';
    k: number | null;
    contributors: string | null;
    turns: Cell;
    pct: Record<string, Cell>;
    kinds: { status: 'shown' | 'suppressed' | 'off'; k: number | null; rows: KindRow[] };
}

export interface ChatSignalsSummary {
    surfaces: { surface: Surface; figures: SurfaceFigures }[];
}

export interface ChatSignalsRopa {
    activity: RopaActivityView | null;
    controllerName: string | null;
}

export const CHAT_SIGNALS_ACTIVITY_ID = 'chat-compliance-signals';

/* ───────────────────────── allow-list helpers ───────────────────────── */

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec => field.recordOrNull<Rec>(v) ?? {};
/** A non-blank string, or null (the web's `str`). */
const text = (v: unknown): string | null => {
    const s = field.strOrNull(v);
    return s !== null && s.trim() ? s : null;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** The vocabulary's members that the payload lists, in the vocabulary's order. */
const listOf = <T extends string>(v: unknown, vocabulary: readonly T[]): T[] => {
    const given = field.strArray(v);
    return vocabulary.filter((id) => given.includes(id));
};
const CODE_RE = /^[a-z_]{1,48}$/;
const isCode = (v: unknown): v is string => typeof v === 'string' && CODE_RE.test(v);
const codes = (v: unknown): string[] => field.strArray(v).filter(isCode);
const rows = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);

export function readCell(v: unknown): Cell {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    return v === '<5' ? '<5' : 'hidden';
}

/** The codes a refused PUT listed under `details.missing` (a 422). */
export const readMissingCodes = (body: unknown): string[] => codes(pick(pick(body, 'details'), 'missing'));

/* ───────────────────────── configuration ───────────────────────── */

function readScope(v: unknown): WorksCouncilScope {
    const s = rec(v);
    return { surfaces: listOf(s.surfaces, EMPLOYEE_SURFACES), signals: listOf(s.signals, SIGNALS), max_retention_days: num(s.max_retention_days) };
}

export function readChatSignalsSettings(v: unknown): StoredSettings {
    const s = rec(v);
    return {
        enabled: s.enabled === true,
        surfaces: listOf(s.surfaces, SURFACES),
        signals: listOf(s.signals, SIGNALS),
        effective_from: text(s.effective_from),
        retention_days: num(s.retention_days) ?? RETENTION.default,
        legal_basis: field.oneOfOrNull(LEGAL_BASES)(s.legal_basis),
        lia_at: text(s.lia_at),
        works_council: field.oneOfOrNull(WORKS_COUNCIL)(s.works_council),
        works_council_reason: field.oneOfOrNull(WORKS_COUNCIL_REASONS)(s.works_council_reason),
        works_council_at: text(s.works_council_at),
        works_council_scope: readScope(s.works_council_scope),
        dpia_ref: text(s.dpia_ref),
        dpia_at: text(s.dpia_at),
        dpia_risk_level: field.oneOfOrNull(DPIA_RISK_LEVELS)(s.dpia_risk_level),
        dpo_advice_at: text(s.dpo_advice_at),
        prior_consultation_at: text(s.prior_consultation_at),
        notice_url: text(s.notice_url),
        notice_published_at: text(s.notice_published_at),
        enabled_at: text(s.enabled_at),
        enabled_by_name: text(s.enabled_by_name),
    };
}

function readEffective(v: unknown): ChatSignalsEffective {
    const e = rec(v);
    return {
        state: field.oneOf(['off', 'scheduled', 'on'] as const, 'off')(e.state),
        from: text(e.from),
        surfaces: listOf(e.surfaces, SURFACES),
        paused: rows(e.paused)
            .filter((p) => typeof p.surface === 'string')
            .map((p) => ({ surface: String(p.surface), missing: codes(p.missing) })),
        signals: listOf(e.signals, SIGNALS),
    };
}

const DEFAULT_CATALOGUE: CatalogueSurface[] = [
    { id: 'direct', population: 'employees', available: true },
    { id: 'agent', population: 'employees', available: true },
    { id: 'agent_public', population: 'visitors', available: true },
    { id: 'notebook', population: 'employees', available: false },
];

function readCatalogue(v: unknown): ChatSignalsCatalogue {
    const c = rec(v);
    const listed = rows(c.surfaces)
        .filter((s) => isCode(s.id))
        .map((s): CatalogueSurface => ({
            id: String(s.id),
            population: s.population === 'visitors' ? 'visitors' : 'employees',
            available: s.available === true,
        }));
    const r = rec(c.retention);
    const k = rec(c.k);
    return {
        surfaces: listed.length ? listed : DEFAULT_CATALOGUE,
        retention: { min: num(r.min) ?? RETENTION.min, max: num(r.max) ?? RETENTION.max, default: num(r.default) ?? RETENTION.default },
        k: { outcomes: num(k.outcomes) ?? 5, kinds: num(k.kinds) ?? 10 },
    };
}

const readDpia = shapeOf({
    kind: field.oneOf(['internal', 'external', 'none'] as const, 'none'),
    current: field.bool(false),
    expires_at: text,
    risk_level: field.oneOfOrNull(DPIA_RISK_LEVELS),
    approved_at: text,
});

/** Contributor bands per chat type ('<5', '5-9', …); anything else is dropped. */
function readBands(v: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [surface, band] of Object.entries(rec(v))) {
        if (CODE_RE.test(surface) && typeof band === 'string' && band.length <= 8) out[surface] = band;
    }
    return out;
}

const readTemplate: FieldReader<NoticeTemplateInfo> = (v) => {
    const tpl = rec(v);
    return { dpoContact: text(tpl.dpo_contact), dsrUrl: text(tpl.dsr_url), shieldLogRetentionDays: num(tpl.shield_log_retention_days) };
};

/** GET/PUT /api/compliance/chat-monitoring (buildView). */
export function readChatSignalsConfig(body: unknown): ChatSignalsConfig {
    const b = rec(body);
    return {
        settings: readChatSignalsSettings(b.settings),
        effective: readEffective(b.effective),
        catalogue: readCatalogue(b.catalogue),
        dpia: readDpia(b.dpia),
        dpoRecorded: b.dpo_recorded === true,
        contributors: readBands(b.contributors),
        privacyNoticeUrlSet: b.privacy_notice_url_set === true,
        template: readTemplate(b.template),
        canWiden: b.can_widen === true,
        installHasOrganisations: b.install_has_organisations === true,
    };
}

/* ───────────────────────── summary ───────────────────────── */

function readKinds(v: unknown): SurfaceFigures['kinds'] {
    const k = rec(v);
    const kindRows = Object.entries(rec(k.rows))
        .filter(([kind]) => CODE_RE.test(kind) && kind !== 'health')
        .map(([kind, row]) => ({ kind, protected: readCell(rec(row).protected), exposed: readCell(rec(row).exposed) }));
    return { status: field.oneOf(['shown', 'suppressed', 'off'] as const, 'off')(k.status), k: num(k.k), rows: kindRows };
}

function readFigures(v: unknown): SurfaceFigures {
    const f = rec(v);
    const pct: Record<string, Cell> = {};
    for (const [key, cell] of Object.entries(rec(f.pct))) if (CODE_RE.test(key)) pct[key] = readCell(cell);
    return {
        status: field.oneOf(['shown', 'suppressed', 'no_full_period', 'no_data'] as const, 'no_data')(f.status),
        k: num(f.k),
        contributors: field.strOrNull(f.contributors),
        turns: readCell(f.turns),
        pct,
        kinds: readKinds(f.kinds),
    };
}

/** GET /api/compliance/chat-monitoring/summary: the chat types in catalogue order. */
export function readChatSignalsSummary(body: unknown): ChatSignalsSummary {
    const surfaces = rec(pick(body, 'surfaces'));
    return { surfaces: SURFACES.filter((s) => s in surfaces).map((surface) => ({ surface, figures: readFigures(surfaces[surface]) })) };
}

/* ───────────────────────── register ───────────────────────── */

function readActivity(a: Rec): RopaActivityView {
    return {
        name: text(a.name) ?? '',
        purpose: text(a.purpose) ?? '',
        processing: text(a.processing) ?? '',
        retention: text(a.retention) ?? '',
        legal_basis: text(a.legal_basis) ?? '',
        data_categories: field.strArray(a.data_categories),
        data_subjects: field.strArray(a.data_subjects),
        security_measures: field.strArray(a.security_measures),
    };
}

/** GET /api/compliance/ropa: only the chat-signals activity, plus the controller's name for the notice. */
export function readChatSignalsRopa(body: unknown): ChatSignalsRopa {
    const b = rec(body);
    const name = text(rec(b.controller).name);
    const found = rows(b.activities).find((a) => a.activity_id === CHAT_SIGNALS_ACTIVITY_ID);
    return { activity: found ? readActivity(found) : null, controllerName: name && name !== b.organization_id ? name : null };
}

/** DELETE /api/compliance/chat-monitoring/counts: the number of rows removed. */
export const readDeletedCount = (body: unknown): number => num(pick(body, 'deleted')) ?? 0;
