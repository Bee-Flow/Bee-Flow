/**
 * Chat signals in Compliance Settings: the ONE client module that knows the
 * wire contract of
 *   GET    /api/compliance/chat-monitoring            the configuration, the resolver's view, the catalogue
 *   PUT    /api/compliance/chat-monitoring            a full replacement (422 lists missing field codes)
 *   GET    /api/compliance/chat-monitoring/summary    the suppressed figures (every read is in the access log)
 *   DELETE /api/compliance/chat-monitoring/counts     delete the collected counts
 *   POST   /api/compliance/dpia/chat_monitoring       record the DPIA (the existing DPIA body)
 *   GET    /api/compliance/ropa                       only the chat-signals activity
 * through `fetchJson` (data/api.js), the hub's single network seam.
 *
 * Every reader is an allow-list. A figure is a number, '<5', 'hidden' or
 * null (not applicable) and nothing else; anything the parser does not
 * recognise reads as hidden, never as a guess.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatMonitoringUrls, fetchJson, jsonInit } from './api';
import {
    DPIA_RISK_LEVELS, EMPLOYEE_SURFACES, LEGAL_BASES, RETENTION, SIGNALS, SURFACES, WORKS_COUNCIL, WORKS_COUNCIL_REASONS,
    type DpiaInfo, type PutBody, type StoredSettings, type Surface, type WorksCouncilScope,
} from '../pages/settings/chatMonitoring/chatMonitoringForm';

type Rec = Record<string, unknown>;
/** A shown figure: a number, "<5", "hidden" (suppressed), or null where it does not apply (nothing to divide by). */
export type Cell = number | '<5' | 'hidden' | null;

export interface PausedSurface { surface: string; missing: string[] }

export interface ChatMonitoringEffective {
    state: 'off' | 'scheduled' | 'on';
    from: string | null;
    surfaces: Surface[];
    paused: PausedSurface[];
    signals: string[];
}

export interface CatalogueSurface { id: string; population: 'employees' | 'visitors'; available: boolean }

export interface ChatMonitoringConfig {
    settings: StoredSettings;
    effective: ChatMonitoringEffective;
    catalogue: { surfaces: CatalogueSurface[]; retention: { min: number; max: number; default: number }; k: { outcomes: number; kinds: number } };
    dpia: DpiaInfo;
    dpoRecorded: boolean;
    contributors: Record<string, string>;
    privacyNoticeUrlSet: boolean;
    template: { dpoContact: string | null; dsrUrl: string | null; shieldLogRetentionDays: number | null };
    canWiden: boolean;
}

export interface SurfaceFigures {
    status: 'shown' | 'suppressed' | 'no_full_period' | 'no_data';
    k: number | null;
    contributors: string | null;
    turns: Cell;
    pct: Record<string, Cell>;
    kinds: { status: 'shown' | 'suppressed' | 'off'; k: number | null; rows: Array<{ kind: string; protected: Cell; exposed: Cell }> };
}

export interface ChatMonitoringSummary { surfaces: Array<{ surface: Surface; figures: SurfaceFigures }> }

export interface RopaActivityView {
    name: string; purpose: string; processing: string; retention: string; legal_basis: string;
    data_categories: string[]; data_subjects: string[]; security_measures: string[];
}

export interface DpiaRecordBody { mode: 'attestation'; risk_level: 'low' | 'medium' | 'high'; expires_at: string | null; mitigations: string[] }

/* ───────────────────────── allow-list helpers ───────────────────────── */

const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const oneOf = <T extends string>(v: unknown, vocabulary: readonly T[]): T | null => (vocabulary.includes(v as T) ? v as T : null);
const listOf = <T extends string>(v: unknown, vocabulary: readonly T[]): T[] => {
    const given = Array.isArray(v) ? v : [];
    return vocabulary.filter((id) => given.includes(id));
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const CODE_RE = /^[a-z_]{1,48}$/;
const codes = (v: unknown): string[] => strings(v).filter((c) => CODE_RE.test(c));

export function parseCell(v: unknown): Cell {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    return v === '<5' ? '<5' : 'hidden';
}

function parseScope(v: unknown): WorksCouncilScope {
    const s = rec(v);
    return { surfaces: listOf(s.surfaces, EMPLOYEE_SURFACES), signals: listOf(s.signals, SIGNALS), max_retention_days: num(s.max_retention_days) };
}

export function parseSettings(v: unknown): StoredSettings {
    const s = rec(v);
    return {
        enabled: s.enabled === true,
        surfaces: listOf(s.surfaces, SURFACES),
        signals: listOf(s.signals, SIGNALS),
        effective_from: str(s.effective_from),
        retention_days: num(s.retention_days) ?? RETENTION.default,
        legal_basis: oneOf(s.legal_basis, LEGAL_BASES),
        lia_at: str(s.lia_at),
        works_council: oneOf(s.works_council, WORKS_COUNCIL),
        works_council_reason: oneOf(s.works_council_reason, WORKS_COUNCIL_REASONS),
        works_council_at: str(s.works_council_at),
        works_council_scope: parseScope(s.works_council_scope),
        dpia_ref: str(s.dpia_ref),
        dpia_at: str(s.dpia_at),
        dpia_risk_level: oneOf(s.dpia_risk_level, DPIA_RISK_LEVELS),
        dpo_advice_at: str(s.dpo_advice_at),
        prior_consultation_at: str(s.prior_consultation_at),
        notice_url: str(s.notice_url),
        notice_published_at: str(s.notice_published_at),
        enabled_at: str(s.enabled_at),
        enabled_by_name: str(s.enabled_by_name),
    };
}

function parseEffective(v: unknown): ChatMonitoringEffective {
    const e = rec(v);
    return {
        state: oneOf(e.state, ['off', 'scheduled', 'on'] as const) ?? 'off',
        from: str(e.from),
        surfaces: listOf(e.surfaces, SURFACES),
        paused: (Array.isArray(e.paused) ? e.paused : []).map(rec)
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

function parseCatalogue(v: unknown): ChatMonitoringConfig['catalogue'] {
    const c = rec(v);
    const listed = (Array.isArray(c.surfaces) ? c.surfaces : []).map(rec)
        .filter((s) => typeof s.id === 'string' && CODE_RE.test(s.id))
        .map((s) => ({ id: String(s.id), population: s.population === 'visitors' ? 'visitors' as const : 'employees' as const, available: s.available === true }));
    const r = rec(c.retention);
    const k = rec(c.k);
    return {
        surfaces: listed.length ? listed : DEFAULT_CATALOGUE,
        retention: { min: num(r.min) ?? RETENTION.min, max: num(r.max) ?? RETENTION.max, default: num(r.default) ?? RETENTION.default },
        k: { outcomes: num(k.outcomes) ?? 5, kinds: num(k.kinds) ?? 10 },
    };
}

function parseDpia(v: unknown): DpiaInfo {
    const d = rec(v);
    return {
        kind: oneOf(d.kind, ['internal', 'external', 'none'] as const) ?? 'none',
        current: d.current === true,
        expires_at: str(d.expires_at),
        risk_level: oneOf(d.risk_level, DPIA_RISK_LEVELS),
        approved_at: str(d.approved_at),
    };
}

function parseBands(v: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [surface, band] of Object.entries(rec(v))) {
        if (CODE_RE.test(surface) && typeof band === 'string' && band.length <= 8) out[surface] = band;
    }
    return out;
}

export function parseConfig(body: unknown): ChatMonitoringConfig {
    const b = rec(body);
    const tpl = rec(b.template);
    return {
        settings: parseSettings(b.settings),
        effective: parseEffective(b.effective),
        catalogue: parseCatalogue(b.catalogue),
        dpia: parseDpia(b.dpia),
        dpoRecorded: b.dpo_recorded === true,
        contributors: parseBands(b.contributors),
        privacyNoticeUrlSet: b.privacy_notice_url_set === true,
        template: { dpoContact: str(tpl.dpo_contact), dsrUrl: str(tpl.dsr_url), shieldLogRetentionDays: num(tpl.shield_log_retention_days) },
        canWiden: b.can_widen === true,
    };
}

function parseKinds(v: unknown): SurfaceFigures['kinds'] {
    const k = rec(v);
    const rows = Object.entries(rec(k.rows))
        .filter(([kind]) => CODE_RE.test(kind) && kind !== 'health')
        .map(([kind, row]) => ({ kind, protected: parseCell(rec(row).protected), exposed: parseCell(rec(row).exposed) }));
    return { status: oneOf(k.status, ['shown', 'suppressed', 'off'] as const) ?? 'off', k: num(k.k), rows };
}

function parseFigures(v: unknown): SurfaceFigures {
    const f = rec(v);
    const pct: Record<string, Cell> = {};
    for (const [key, cell] of Object.entries(rec(f.pct))) if (CODE_RE.test(key)) pct[key] = parseCell(cell);
    return {
        status: oneOf(f.status, ['shown', 'suppressed', 'no_full_period', 'no_data'] as const) ?? 'no_data',
        k: num(f.k),
        contributors: typeof f.contributors === 'string' ? f.contributors : null,
        turns: parseCell(f.turns),
        pct,
        kinds: parseKinds(f.kinds),
    };
}

export function parseSummary(body: unknown): ChatMonitoringSummary {
    const surfaces = rec(rec(body).surfaces);
    return { surfaces: SURFACES.filter((s) => s in surfaces).map((surface) => ({ surface, figures: parseFigures(surfaces[surface]) })) };
}

export const CHAT_SIGNALS_ACTIVITY_ID = 'chat-compliance-signals';

export function parseRopa(body: unknown): { activity: RopaActivityView | null; controllerName: string | null } {
    const b = rec(body);
    const controller = rec(b.controller);
    const name = str(controller.name);
    const found = (Array.isArray(b.activities) ? b.activities : []).map(rec).find((a) => a.activity_id === CHAT_SIGNALS_ACTIVITY_ID);
    const activity = found ? {
        name: str(found.name) ?? '', purpose: str(found.purpose) ?? '', processing: str(found.processing) ?? '',
        retention: str(found.retention) ?? '', legal_basis: str(found.legal_basis) ?? '',
        data_categories: strings(found.data_categories), data_subjects: strings(found.data_subjects),
        security_measures: strings(found.security_measures),
    } : null;
    return { activity, controllerName: name && name !== b.organization_id ? name : null };
}

/** What a refused write said: the status, the code, and the missing field codes of a 422. */
export function refusalOf(e: unknown): { status: number | null; code: string | null; missing: string[] } {
    const err = rec(e);
    return { status: num(err.status), code: str(err.code), missing: codes(rec(err.details).missing) };
}

/* ───────────────────────── hooks ───────────────────────── */

export const chatMonitoringKeys = {
    all: ['compliance', 'chat-monitoring'] as const,
    config: ['compliance', 'chat-monitoring', 'config'] as const,
    summary: (days: number) => ['compliance', 'chat-monitoring', 'summary', days] as const,
    ropa: ['compliance', 'chat-monitoring', 'ropa'] as const,
};

export function useChatMonitoringConfig() {
    return useQuery<ChatMonitoringConfig, Error>({
        queryKey: chatMonitoringKeys.config,
        queryFn: async () => parseConfig(await fetchJson(chatMonitoringUrls.config())),
        retry: false,
        staleTime: 0,
    });
}

export function useSaveChatMonitoring() {
    const qc = useQueryClient();
    return useMutation<ChatMonitoringConfig, Error, PutBody>({
        mutationFn: async (body) => parseConfig(await fetchJson(chatMonitoringUrls.config(), jsonInit('PUT', body))),
        onSuccess: (config) => {
            qc.setQueryData(chatMonitoringKeys.config, config);
            void qc.invalidateQueries({ queryKey: chatMonitoringKeys.ropa });
            // The admin's own chat shows the notice too; let it catch up now.
            void qc.invalidateQueries({ queryKey: ['shield-status'] });
        },
    });
}

/** Reads only while `enabled`: every read is recorded in the access log, so the table opens on request. */
export function useChatMonitoringSummary(days: 30 | 90, { enabled }: { enabled: boolean }) {
    return useQuery<ChatMonitoringSummary, Error>({
        queryKey: chatMonitoringKeys.summary(days),
        queryFn: async () => parseSummary(await fetchJson(chatMonitoringUrls.summary(days))),
        enabled,
        retry: false,
        staleTime: 60_000,
    });
}

export function useDeleteChatMonitoringCounts() {
    const qc = useQueryClient();
    return useMutation<number, Error, void>({
        mutationFn: async () => num(rec(await fetchJson(chatMonitoringUrls.counts(), { method: 'DELETE' })).deleted) ?? 0,
        onSuccess: () => { void qc.invalidateQueries({ queryKey: [...chatMonitoringKeys.all, 'summary'] }); },
    });
}

export function useRecordChatMonitoringDpia() {
    const qc = useQueryClient();
    return useMutation<unknown, Error, DpiaRecordBody>({
        mutationFn: (body) => fetchJson(chatMonitoringUrls.dpia(), jsonInit('POST', body)),
        onSuccess: () => { void qc.invalidateQueries({ queryKey: chatMonitoringKeys.config }); },
    });
}

export function useChatMonitoringRopa({ enabled }: { enabled: boolean }) {
    return useQuery({
        queryKey: chatMonitoringKeys.ropa,
        queryFn: async () => parseRopa(await fetchJson(chatMonitoringUrls.ropa())),
        enabled,
        retry: false,
        staleTime: 60_000,
    });
}
