/**
 * Learn media — where lesson videos come from, and whether they are there.
 *
 * Videos are NOT in git and NOT in the image. A deployment that wants them
 * installs a media pack (`npm run learn-media:fetch`) into LEARN_MEDIA_DIR,
 * and the server serves it at GET /learn-media/* (server/learning/learnMedia.js).
 * An operator can point browsers at a CDN instead: the agent-hub container
 * writes LEARN_MEDIA_BASE_URL into /beeflow-runtime.js
 * (docker-entrypoint.d/19-beeflow-runtime-config.sh), the same runtime-config
 * file the telemetry switch uses.
 *
 * Pack layout, relative to the base:
 *   manifest.json = { version, videos: { <videoId>: { file, burnedCaptions?,
 *                     captions: { en }, poster, duration, transcript: [string] } },
 *                     files? }
 *
 * `burnedCaptions: true` means the subtitles are part of the picture (the
 * clip-studio pack default): the player then adds no caption track of its own,
 * or a learner would read every line twice. The transcript stays either way.
 *
 * Absence is the NORMAL case (a fresh self-host has no pack), so every failure
 * here — no manifest, a 404, HTML where JSON was expected, a malformed entry,
 * a slow network — collapses to "unavailable", and the player drops the video
 * step before the learner ever sees it. Nothing throws.
 */
import { useEffect, useState } from 'react';
import { API_BASE } from '../../utils/helpers';
import { STEP_TYPES, stepType } from './stepTypes';

export interface LearnVideo {
    file: string;
    /** The subtitles are burned into the video itself: no player caption track. */
    burnedCaptions?: true;
    captions: { en?: string };
    poster?: string;
    duration?: number;
    transcript: string[];
}

export interface LearnManifest {
    version: string;
    videos: Record<string, LearnVideo>;
}

export type LearnManifestState =
    | { status: 'loading' }
    | { status: 'ready'; manifest: LearnManifest; base: string }
    | { status: 'unavailable' };

/** A lesson step as the player sees it; only the fields this module reads. */
export interface LessonStepLike {
    id?: string;
    type?: string;
    videoId?: string;
}

/** How long the manifest may take before the lesson plays without its video. */
export const MANIFEST_TIMEOUT_MS = 2500;

const DEFAULT_PATH = '/learn-media';

// A pack-relative file name: no scheme, no leading slash, no `..`, no dot
// files, and one of the extensions the server is willing to serve.
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
function safeRelative(value: unknown, exts: readonly string[]): string | null {
    if (typeof value !== 'string' || !value || value.length > 200) return null;
    const parts = value.split('/');
    if (!parts.every((p) => SAFE_SEGMENT.test(p) && !p.includes('..'))) return null;
    const lower = value.toLowerCase();
    return exts.some((e) => lower.endsWith(e)) ? value : null;
}

/**
 * The base URL lessons load media from: the runtime override when it is an
 * absolute https URL, else the server's own /learn-media under the API base
 * (relative in production, the API host in dev, NC's proxy path in the embed).
 */
export function learnMediaBase(runtime: unknown = readRuntime()): string {
    const configured = (runtime as { learnMedia?: { baseUrl?: unknown } } | null)?.learnMedia?.baseUrl;
    if (typeof configured === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(configured.trim())) {
        return configured.trim().replace(/\/+$/, '');
    }
    return `${String(API_BASE || '').replace(/\/+$/, '')}${DEFAULT_PATH}`;
}

function readRuntime(): unknown {
    try {
        return typeof window !== 'undefined'
            ? (window as unknown as { __BEEFLOW_RUNTIME__?: unknown }).__BEEFLOW_RUNTIME__ ?? null
            : null;
    } catch {
        return null;
    }
}

/** Absolute-or-rooted URL of a pack file. */
export function mediaUrl(base: string, rel: string): string {
    return `${base}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** True when the base is on another origin (CDN): <video> then needs crossOrigin for its captions. */
export function isCrossOrigin(base: string): boolean {
    if (!/^https?:\/\//i.test(base)) return false;
    try {
        return typeof window === 'undefined' || new URL(base).origin !== window.location.origin;
    } catch {
        return true;
    }
}

/**
 * Validate a parsed manifest. Malformed entries are dropped one by one (a pack
 * with one bad clip still serves the others); a document that is not a
 * manifest at all yields null.
 */
export function parseManifest(raw: unknown): LearnManifest | null {
    if (!isPlainObject(raw)) return null;
    const doc = raw as { version?: unknown; videos?: unknown };
    if (!isPlainObject(doc.videos)) return null;
    const videos: Record<string, LearnVideo> = {};
    for (const [id, value] of Object.entries(doc.videos as Record<string, unknown>)) {
        const video = /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? parseVideo(value) : null;
        if (video) videos[id] = video;
    }
    return { version: String(doc.version ?? ''), videos };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseVideo(value: unknown): LearnVideo | null {
    if (!isPlainObject(value)) return null;
    const file = safeRelative(value.file, ['.mp4']);
    if (!file) return null;
    const en = safeRelative(isPlainObject(value.captions) ? value.captions.en : undefined, ['.vtt']);
    const poster = safeRelative(value.poster, ['.jpg', '.webp']);
    const d = value.duration;
    const duration = typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : undefined;
    const transcript = Array.isArray(value.transcript)
        ? value.transcript.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
        : [];
    return { file, ...(value.burnedCaptions === true ? { burnedCaptions: true as const } : {}), captions: en ? { en } : {}, ...(poster ? { poster } : {}), ...(duration ? { duration } : {}), transcript };
}

// ── The one fetch, shared by every player and step ─────────────────────────
let settled: LearnManifestState | null = null;
let inflight: Promise<LearnManifestState> | null = null;

type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

/**
 * Load the manifest once per page. Resolves (never rejects) to 'ready' or
 * 'unavailable'; a timeout counts as unavailable so a dead CDN cannot hold
 * a lesson hostage.
 */
export function loadLearnManifest(
    { fetchImpl, base = learnMediaBase(), timeoutMs = MANIFEST_TIMEOUT_MS }: { fetchImpl?: FetchLike; base?: string; timeoutMs?: number } = {},
): Promise<LearnManifestState> {
    if (settled) return Promise.resolve(settled);
    if (inflight) return inflight;
    const doFetch: FetchLike | undefined = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
    const attempt = (async (): Promise<LearnManifestState> => {
        if (!doFetch) return { status: 'unavailable' };
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => { ctrl?.abort(); resolve(null); }, timeoutMs);
        });
        try {
            const res = await Promise.race([
                doFetch(mediaUrl(base, 'manifest.json'), { credentials: 'omit', signal: ctrl?.signal }),
                timeout,
            ]);
            if (!res || !res.ok) return { status: 'unavailable' };
            const manifest = parseManifest(await res.json());
            return manifest ? { status: 'ready', manifest, base } : { status: 'unavailable' };
        } catch {
            return { status: 'unavailable' };
        } finally {
            if (timer) clearTimeout(timer);
        }
    })();
    inflight = attempt.then((state) => {
        settled = state;
        inflight = null;
        return state;
    });
    return inflight;
}

/** Tests only: forget the cached manifest. */
export function resetLearnManifestCache(): void {
    settled = null;
    inflight = null;
}

/**
 * The manifest as React state. `enabled: false` (a lesson without video
 * steps) never fetches and reports 'unavailable' straight away. A manifest
 * already loaded on this page is returned on the first render, without a
 * loading frame.
 */
export function useLearnManifest(enabled: boolean): LearnManifestState {
    const [state, setState] = useState<LearnManifestState>(() => (enabled ? (settled || { status: 'loading' }) : { status: 'unavailable' }));
    useEffect(() => {
        if (!enabled) { setState({ status: 'unavailable' }); return undefined; }
        let alive = true;
        if (settled) { setState(settled); return undefined; }
        setState({ status: 'loading' });
        loadLearnManifest().then((s) => { if (alive) setState(s); });
        return () => { alive = false; };
    }, [enabled]);
    return state;
}

/** The manifest entry for a video step, or null when the pack lacks it. */
export function videoEntry(step: LessonStepLike | null | undefined, manifest: LearnManifest | null | undefined): LearnVideo | null {
    if (!step?.videoId || !manifest) return null;
    return Object.prototype.hasOwnProperty.call(manifest.videos, step.videoId) ? manifest.videos[step.videoId] : null;
}

export function hasVideoSteps(steps: readonly LessonStepLike[] | null | undefined): boolean {
    return (steps || []).some((s) => stepType(s) === STEP_TYPES.VIDEO);
}

/**
 * The steps a learner should actually see: every video step whose clip is not
 * in the manifest — or that failed to play (`broken`, by step id) — is
 * removed, so nobody ever lands on an empty step. Other steps pass through
 * untouched and in order.
 */
export function filterAvailableSteps<T extends LessonStepLike>(
    steps: readonly T[],
    manifest: LearnManifest | null | undefined,
    broken: ReadonlySet<string> = new Set(),
): T[] {
    return steps.filter((s) => stepType(s) !== STEP_TYPES.VIDEO
        || (!!videoEntry(s, manifest) && !(s.id && broken.has(s.id))));
}
