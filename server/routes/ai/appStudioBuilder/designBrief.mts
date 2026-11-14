/**
 * App Studio Builder: variety in the look of a NEW app.
 *
 * Two machine notes, both in the uncached per-turn user message (turnMessages.js), so the
 * system prompt and the tool schemas stay byte-stable:
 *
 *   DESIGN SEED    a few leanings picked from the app's id (designSeedNote). Deterministic: the
 *                  same app reads the same seed every turn, two apps read different ones, so two
 *                  apps built the same day from similar asks do not end up as twins. It costs no
 *                  model call and every band gets it.
 *
 *   DESIGN BRIEF   a short design direction written by a separate, tool-less model call at a
 *                  HIGHER temperature than the build rounds (requestDesignBrief). The builder
 *                  profiles keep their low temperature, which is what keeps tool calls reliable;
 *                  this one call is where the variety comes from. It goes through the same
 *                  adapter, model and usage totals as the build rounds (one usage row per turn),
 *                  is skipped for the small band, and never blocks a build: a failure, an empty
 *                  answer or a timeout means the turn goes on without it.
 *
 * Both are only offered while the look is still open: a fresh draft with no design yet and no
 * approved plan that carries one. The brief is written once per build and kept on the session
 * snapshot (`designBrief`) until the app finalizes, so later turns read the same text.
 *
 * Operator knobs (0 = no limit where a limit is meant):
 *   STUDIO_APP_DESIGN_BRIEF              "off" disables the model call (the seed stays)
 *   STUDIO_APP_DESIGN_BRIEF_TIMEOUT_MS   how long the call may take (default 20000, 0 = no limit)
 *   STUDIO_APP_DESIGN_BRIEF_TEMPERATURE  its sampling temperature (default 1, range 0..2)
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { ALL_APP_DESIGN_PRESETS, APP_DESIGN_PRESETS } = nodeRequire('../../../appStudio/appDesignPresets.js') as {
    ALL_APP_DESIGN_PRESETS: readonly PresetRow[];
    APP_DESIGN_PRESETS: readonly PresetRow[];
};
const { DESIGN_SPEC, NAV_STYLES } = nodeRequire('../../../appStudio/componentSpecs.js') as {
    DESIGN_SPEC: Record<string, { values?: readonly string[] }>;
    NAV_STYLES: readonly string[];
};
const { isFreshDraft } = nodeRequire('../../../appStudio/builderTools/templateTools.js') as { isFreshDraft: (draft: unknown) => boolean };
const { trackUsageTotals } = nodeRequire('../../../core/providers/usageNormalizer.js') as { trackUsageTotals: (totals: object, usage: unknown) => unknown };
const log = nodeRequire('../../../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

type PresetRow = { id: string; description: string };
type Env = Record<string, string | undefined>;

export const DESIGN_SEED_PREFIX = '[DESIGN SEED — machine-generated: leanings for this app\'s look, not requirements]';
export const DESIGN_BRIEF_PREFIX = '[DESIGN BRIEF — machine-generated: a design direction proposed for this new app]';

export const DESIGN_BRIEF_MAX_CHARS = 1200;
export const DESIGN_BRIEF_MAX_TOKENS = 500;
const DESIGN_BRIEF_ASK_CHARS = 2000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_TEMPERATURE = 1;

// ── The seed ─────────────────────────────────────────────────────────

const HOME_OPENERS = [
    'a hero page_header whose subtitle states one live fact',
    'a banner page_header with the KPI row directly under it',
    'a split page_header and the work area straight away, no KPI row',
    'a plain page_header above ONE wide headline tile',
];
const ROW_SHAPES = ['6 + 3 + 3', '8 + 4', '4 + 8', '7 + 5', '5 + 7', 'three equal columns of 4'];
const ACCENTS = [
    'spend look "gradient" on exactly one thing',
    'mark the group that matters most with card look "accent"',
    'give one section background "panel" and keep the rest bare',
    'use stat look "tinted" and keep the cards flat',
    'one card with look "solid" for the main call to action',
    'heading accent "bar" on every section title, nothing louder',
];
const LIST_LOOKS = ['browsing lists as cards', 'dense tables striped', 'tables minimal with generous spacing', 'lists as tiles where items are short'];

/** A stable number stream from a seed: 4 bytes per draw from one sha256. */
function draws(seed: string): (n: number) => number {
    const digest = createHash('sha256').update(`app-design-seed:${seed}`).digest();
    let at = 0;
    return (n: number) => {
        const value = digest.readUInt32BE(at % 28);
        at += 4;
        return value % n;
    };
}

/** `count` distinct items of `list`, order and choice fixed by `pick`. */
function pickSome<T>(list: readonly T[], count: number, pick: (n: number) => number): T[] {
    const pool = [...list];
    const out: T[] = [];
    while (out.length < count && pool.length) out.push(pool.splice(pick(pool.length), 1)[0]);
    return out;
}

export interface DesignSeed {
    presets: string[];
    opener: string;
    rowShape: string;
    accent: string;
    listLook: string;
}

/** The leanings of one app. `core` keeps to what the small band's catalogue lists. */
export function designSeed(seed: string, { core = false }: { core?: boolean } = {}): DesignSeed {
    const pick = draws(seed);
    const presets = (core ? APP_DESIGN_PRESETS : ALL_APP_DESIGN_PRESETS).filter((p) => p.id !== 'classic').map((p) => p.id);
    return {
        presets: pickSome(presets, 3, pick),
        opener: HOME_OPENERS[pick(HOME_OPENERS.length)],
        rowShape: ROW_SHAPES[pick(ROW_SHAPES.length)],
        accent: ACCENTS[pick(ACCENTS.length)],
        listLook: LIST_LOOKS[pick(LIST_LOOKS.length)],
    };
}

/** The seed as the lines both the note and the brief request carry. */
export function renderDesignSeed(seed: DesignSeed, { core = false }: { core?: boolean } = {}): string {
    const lines = [`presets to consider first: ${seed.presets.join(', ')}`];
    if (!core) lines.push(`home screen: ${seed.opener}`, `main row: ${seed.rowShape} rather than equal columns by habit`, `accent: ${seed.accent}`, `data: ${seed.listLook}`);
    else lines.push(`home screen: ${seed.opener}`);
    return lines.join('; ');
}

type Draft = { appId?: string | null; builderSessionId?: string | null; def?: object | null };

/** True while nothing has decided the app's look yet. */
export function lookIsOpen(draftWrap: Draft, approvedPlan: unknown): boolean {
    if (!isFreshDraft(draftWrap) || (draftWrap.def as { design?: unknown } | null | undefined)?.design) return false;
    const plan = approvedPlan as { design?: unknown } | null | undefined;
    return !(plan && typeof plan === 'object' && plan.design);
}

/** What the seed is drawn from: the app's id, or the session's while the app has none yet. */
export const seedSourceOf = (draftWrap: Draft): string => String(draftWrap.appId || draftWrap.builderSessionId || 'new-app');

/** The DESIGN SEED note, or null once the look is decided. */
export function designSeedNote(draftWrap: Draft, { approvedPlan = null, core = false }: { approvedPlan?: unknown; core?: boolean } = {}): string | null {
    if (!lookIsOpen(draftWrap, approvedPlan)) return null;
    const seed = renderDesignSeed(designSeed(seedSourceOf(draftWrap), { core }), { core });
    return `${DESIGN_SEED_PREFIX}\nWhere the ask leaves the look open, lean this way, so this app does not look like the previous one: ${seed}.\nWhat the user asks for, and a design they approved, always win over these.`;
}

// ── The brief ────────────────────────────────────────────────────────

/** A finite number from an env value inside [min, max], else the fallback. */
function envNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function designBriefSettings(env: Env = process.env): { enabled: boolean; timeoutMs: number; temperature: number } {
    return {
        enabled: (env.STUDIO_APP_DESIGN_BRIEF || '').trim().toLowerCase() !== 'off',
        timeoutMs: envNumber(env.STUDIO_APP_DESIGN_BRIEF_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 0, 600_000),
        temperature: envNumber(env.STUDIO_APP_DESIGN_BRIEF_TEMPERATURE, DEFAULT_TEMPERATURE, 0, 2),
    };
}

export interface BriefGate {
    profile: { toolset?: string } | null | undefined;
    draftWrap: Draft;
    approvedPlan: unknown;
    isApproval?: boolean;
    workMode?: string | null;
    storedBrief?: unknown;
    env?: Env;
}

/** Whether THIS turn asks the model for a brief: a new app, a capable band, nothing decided or written yet. */
export function wantsDesignBrief({ profile, draftWrap, approvedPlan, isApproval = false, workMode = null, storedBrief = null, env = process.env }: BriefGate): boolean {
    if (!designBriefSettings(env).enabled) return false;
    if (!profile || profile.toolset === 'core') return false; // the small band builds from its compact menu
    if (isApproval || workMode === 'discuss') return false;
    if (typeof storedBrief === 'string' && storedBrief.trim()) return false;
    return lookIsOpen(draftWrap, approvedPlan);
}

/** The request: what there is to choose from, the app's seed, and the answer's fixed form. */
export function designBriefMessages(ask: string, seed: string): { role: string; content: string }[] {
    const presets = ALL_APP_DESIGN_PRESETS.map((p) => `${p.id} (${p.description})`).join('\n');
    const system = `You are a product designer. Before an internal business app is built, you decide how it should look and feel. You do not build it and you call no tools: you write a short brief for the builder.

What exists to choose from:
PRESETS (a complete look each; "custom" when none fits):
${presets}
FONTS: ${(DESIGN_SPEC.font.values || []).join(', ')}
NAVIGATION: ${NAV_STYLES.join(', ')}
SURFACES: ${(DESIGN_SPEC.surface.values || []).join(', ')}
Screens are sections of a 12-column grid holding components (page headers plain/banner/hero/split, stat tiles, cards, lists, tables, charts, kanban boards, forms). There is no free CSS: a move must be something those parts can do.

Read the ask for who uses the app, where, and for what, and let that decide the look. Do not fall back on the safest choice. Never purple, violet or indigo.

Answer in exactly this form and nothing else:
DIRECTION: one sentence a person would recognise the app by
PRESET: a preset id, or custom
PRIMARY: #rrggbb
FONT: a font
NAV: a navigation style
SURFACE: a surface
MOVES:
- three concrete design moves, one per line, each something a person would point at`;
    const user = `The ask:\n${ask.slice(0, DESIGN_BRIEF_ASK_CHARS)}\n\nLeanings for this app, to break ties: ${seed}.`;
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** The model's answer as note text: trimmed, capped, null when there is nothing. */
export function cleanBrief(content: unknown): string | null {
    if (typeof content !== 'string') return null;
    const text = content.trim();
    if (!text) return null;
    return text.length > DESIGN_BRIEF_MAX_CHARS ? text.slice(0, DESIGN_BRIEF_MAX_CHARS) : text;
}

/** The DESIGN BRIEF note for a brief text (this turn's or the snapshot's), or null. */
export function designBriefNote(brief: unknown): string | null {
    const text = cleanBrief(brief);
    if (!text) return null;
    return `${DESIGN_BRIEF_PREFIX}\nA designer's first take, written before the build. Start from it for app_set_theme and for a plan's design; where the user's own words say otherwise, the user wins.\n${text}`;
}

type RoundResponse = { content?: string | null; usage?: unknown } | null | undefined;
type StreamFn = (adapter: unknown, cfg: unknown, modelId: string, messages: unknown[], options: object, opts: object) => Promise<RoundResponse>;

export interface BriefRequest {
    adapter: unknown;
    cfg: { providerType?: string };
    modelId: string;
    ask: string;
    seed: string;
    userId: string;
    usageTotals: object;
    /** The client's abort signal: a closed tab ends this call too. */
    signal?: AbortSignal;
    stream?: StreamFn;
    env?: Env;
}

/**
 * Ask for the brief. Resolves to its text, or null on any failure, an empty answer or a timeout:
 * the build goes on either way. Tokens the call used are added to the turn's usage totals.
 */
export async function requestDesignBrief({ adapter, cfg, modelId, ask, seed, userId, usageTotals, signal, stream, env = process.env }: BriefRequest): Promise<string | null> {
    const { timeoutMs, temperature } = designBriefSettings(env);
    const run: StreamFn = stream || (nodeRequire('../../../usecases/ai/appStudioBuilder/modelStream.js') as { streamWithRetry: StreamFn }).streamWithRetry;
    const abort = new AbortController();
    const onClientAbort = () => abort.abort();
    if (signal?.aborted) return null;
    signal?.addEventListener('abort', onClientAbort, { once: true });
    let timer: NodeJS.Timeout | null = null;
    const timedOut = new Promise<null>((resolve) => {
        if (timeoutMs > 0) timer = setTimeout(() => { abort.abort(); resolve(null); }, timeoutMs);
    });
    const startedAt = Date.now();
    try {
        const call = run(adapter, cfg, modelId, designBriefMessages(ask, seed), {
            maxTokens: DESIGN_BRIEF_MAX_TOKENS, temperature, reasoningEffort: 'none', userId: String(userId),
        }, { send: () => {}, signal: abort.signal, retries: 0 });
        // A late rejection after the timeout won must not surface as unhandled.
        call.catch(() => {});
        const response = await Promise.race([call, timedOut]);
        if (!response) {
            log.warn(`[AppStudioBuilder] design brief skipped: no answer within ${timeoutMs}ms`);
            return null;
        }
        if (response.usage) trackUsageTotals(usageTotals, response.usage); // the turn's one usage row, like a build round
        const brief = cleanBrief(response.content);
        log.info(`[AppStudioBuilder] design brief ${brief ? `${brief.length} chars` : 'empty'} in ${Date.now() - startedAt}ms (temperature ${temperature})`);
        return brief;
    } catch (err) {
        log.warn(`[AppStudioBuilder] design brief skipped: ${(err as Error).message}`);
        return null;
    } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onClientAbort);
    }
}

// ── One turn ─────────────────────────────────────────────────────────

type Closable = { once: (event: 'close', fn: () => void) => unknown; off: (event: 'close', fn: () => void) => unknown; writableEnded?: boolean };

export interface TurnDesignInput extends Omit<BriefGate, 'storedBrief' | 'env'>, Omit<BriefRequest, 'seed' | 'signal' | 'env'> {
    draftWrap: Draft & { _designBrief?: string | null };
    priorSnapshot?: { designBrief?: unknown } | null;
    /** The SSE response: when the client goes away the brief call is aborted. */
    res?: Closable;
    env?: Env;
}

/**
 * The design notes of one turn, in the order they are read: the seed, then the brief. Asks for
 * a brief when this turn should have one, otherwise carries the session's. What is kept for
 * the snapshot is left on `draftWrap._designBrief`.
 */
export async function designNotesForTurn(input: TurnDesignInput): Promise<string[]> {
    const { profile, draftWrap, approvedPlan, priorSnapshot, res, env = process.env } = input;
    const core = profile?.toolset === 'core';
    const stored = cleanBrief(priorSnapshot?.designBrief);
    let brief = stored;
    if (wantsDesignBrief({ ...input, storedBrief: stored, env })) {
        const abort = new AbortController();
        const onClose = () => { if (!res?.writableEnded) abort.abort(); };
        res?.once('close', onClose);
        try {
            const seed = renderDesignSeed(designSeed(seedSourceOf(draftWrap)));
            brief = await requestDesignBrief({ ...input, seed, signal: abort.signal, env });
        } finally {
            res?.off('close', onClose);
        }
    }
    draftWrap._designBrief = brief;
    // An approved plan's design is the look the user agreed to: the brief has done its work.
    const plan = approvedPlan as { design?: unknown } | null | undefined;
    const planHasDesign = !!(plan && typeof plan === 'object' && plan.design);
    return [designSeedNote(draftWrap, { approvedPlan, core }), core || planHasDesign ? null : designBriefNote(brief)].filter((n): n is string => !!n);
}
