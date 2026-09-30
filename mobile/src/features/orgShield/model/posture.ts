/**
 * The Overview tab's "how things stand" rows, derived from the fields — a port
 * of the web's orgShieldPosture.js. Pure: no copy, so the interesting part
 * (which setting is a problem) is tested on tone and value, not on English.
 *
 * `egress` sharpens two rows once the activity endpoints have shown personal
 * data leaving Europe; without it they stay plain rather than nagging.
 */

import { PII_CATALOG, presetFor } from './piiCatalog';
import type { GuardStatus, ShieldEnv, ShieldFields } from './types';

export type PostureTone = 'ok' | 'note' | 'warn' | 'error';
export type PostureTab = 'detection' | 'processing' | 'outbound';

export type PostureId =
    | 'guard'
    | 'categories'
    | 'sensitivity'
    | 'action'
    | 'transparency'
    | 'routines'
    | 'dlp'
    | 'toolcalls'
    | 'websearch'
    | 'eu'
    | 'customterms'
    | 'allowlist';

export interface PostureRow {
    id: PostureId;
    /** The tab that owns the control; null when nothing on this screen fixes it. */
    tab: PostureTab | null;
    tone: PostureTone;
    value: Record<string, unknown>;
}

export interface Posture {
    off: boolean;
    rows: PostureRow[];
    attention: number;
}

export interface PostureInputs {
    env: ShieldEnv;
    canTokenize: boolean;
    canGuardWebSearch: boolean;
    guard: GuardStatus | null;
    egress?: { piiNonEuCount: number | null; piiCategories: string[] } | null;
}

function detectionRows(f: ShieldFields, total: number): PostureRow[] {
    const preset = presetFor(f.piiConfidenceThreshold);
    return [
        {
            id: 'categories',
            tab: 'detection',
            // On, but nothing ticked: nothing will ever be found.
            tone: f.piiCategories.length === 0 ? 'warn' : 'ok',
            value: { n: f.piiCategories.length, total },
        },
        {
            id: 'sensitivity',
            tab: 'detection',
            tone: 'ok',
            value: preset ? { presetId: preset.id } : { customPct: Math.round(f.piiConfidenceThreshold * 100) },
        },
    ];
}

function processingRows(f: ShieldFields, canTokenize: boolean): PostureRow[] {
    const unlicensed = f.piiAction === 'tokenize' && !canTokenize;
    const transparencyOn = f.piiAction === 'tokenize' && f.showRawPayload;
    return [
        { id: 'action', tab: 'processing', tone: unlicensed ? 'warn' : 'ok', value: { action: f.piiAction, unlicensed } },
        { id: 'transparency', tab: 'processing', tone: transparencyOn ? 'note' : 'ok', value: { on: transparencyOn } },
        { id: 'routines', tab: 'processing', tone: 'ok', value: { on: f.applyToAutomations } },
    ];
}

function outboundRows(f: ShieldFields, inputs: PostureInputs, total: number): PostureRow[] {
    const nonEu = inputs.egress?.piiNonEuCount ?? null;
    const leaked = nonEu !== null && nonEu > 0;
    const rows: PostureRow[] = [
        { id: 'dlp', tab: 'outbound', tone: 'ok', value: { on: f.dlpEnabled, mode: f.dlpEnabled ? f.dlpMode : null } },
        {
            id: 'toolcalls',
            tab: 'detection',
            tone: leaked ? 'warn' : 'ok',
            value: {
                external: f.toolPiiPolicy.external.blockCategories.length,
                internal: f.toolPiiPolicy.internal.blockCategories.length,
                total,
                leakedCount: leaked ? nonEu : null,
                leakedCategories: leaked ? (inputs.egress?.piiCategories ?? []) : [],
            },
        },
    ];
    if (inputs.env.hasWebSearchEnabled) {
        rows.push({
            id: 'websearch',
            tab: 'outbound',
            tone: 'ok',
            value: { on: f.webSearchGuard, licensed: inputs.canGuardWebSearch },
        });
    }
    if (inputs.env.hasEuModelsConfigured) {
        rows.push({ id: 'eu', tab: 'outbound', tone: !f.euModeEnabled && leaked ? 'warn' : 'ok', value: { on: f.euModeEnabled } });
    }
    return rows;
}

function listRows(f: ShieldFields): PostureRow[] {
    return [
        {
            id: 'customterms',
            tab: 'detection',
            tone: 'ok',
            value: {
                n: f.customSensitiveTerms.length,
                sample: f.customSensitiveTerms
                    .slice(0, 2)
                    .map((term) => term.label || term.pattern)
                    .filter(Boolean),
            },
        },
        {
            id: 'allowlist',
            tab: 'detection',
            // The one control that makes the shield leak by design.
            tone: f.piiAllowTerms.length > 0 ? 'note' : 'ok',
            value: { terms: f.piiAllowTerms.length, publicOrgs: f.piiAllowPublicOrgs },
        },
    ];
}

export function derivePosture(f: ShieldFields, inputs: PostureInputs): Posture {
    if (!f.enabled) return { off: true, rows: [], attention: 0 };
    const total = PII_CATALOG.length;
    const rows = [
        ...detectionRows(f, total),
        ...processingRows(f, inputs.canTokenize),
        ...outboundRows(f, inputs, total),
        ...listRows(f),
    ];
    const guard = inputs.guard;
    // First: without a reachable detector every control on the page is decoration.
    if (guard && (!guard.configured || !guard.reachable)) {
        rows.unshift({ id: 'guard', tab: null, tone: 'error', value: { configured: guard.configured } });
    }
    return { off: false, rows, attention: rows.filter((r) => r.tone === 'warn' || r.tone === 'error').length };
}
