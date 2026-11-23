/**
 * The document with what is filled in so far, next to the form that fills it
 * in (the editor's "Fill in & preview" tab, and "Preview" under a chat
 * answer). A field that is still needed shows as its label in brackets, so a
 * person sees where it ends up and what is still open; everything else reads
 * as the download will.
 *
 * The page is the server's (GET /api/studio-documents/:id/values/preview):
 * sanitised there, and shown here in a frame without an origin
 * (`sandbox="allow-scripts"`, never `allow-same-origin`), as the editor's own
 * sheet is.
 *
 * DRAWN AGAIN WITHOUT A FLASH. Every saved value is a new page. The new one
 * loads in a second frame behind the one on screen, is scrolled to where the
 * reader was, and only then takes its place: no white flash, no jump to the
 * top. The frame's own script (server/services/documentEditBridge.js) says
 * when it is up and where it is scrolled to; nothing is ever asked back from
 * it, and it is never made editable.
 */
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { Eye } from 'lucide-react';

import { useFilledPreviewQuery } from '@/api/queries/chatTemplateFill';
import type { TemplateFillApi } from '@/api/templateFillApi';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import useTranslation from '@/hooks/useTranslation';
import { logger } from '@/utils/logger';
import { nOf } from '@/utils/plural';
import { FILL_LINK } from './fillStyles';

/** How long the new page gets to settle at the reader's place before it is shown. */
const SWAP_MS = 90;
/** A page whose script never reports (blocked, or broken) is shown anyway after this long. */
const SHOW_ANYWAY_MS = 1500;

interface Layer { id: number; html: string }
interface Layers { front: Layer | null; back: Layer | null; count: number }

const firstLayers = (html: string | undefined): Layers => (html === undefined
    ? { front: null, back: null, count: 0 }
    : { front: null, back: { id: 1, html }, count: 1 });

/** The colour of the desk behind the sheet, from the app's theme. */
function deskColour(): string {
    try {
        return getComputedStyle(document.documentElement).getPropertyValue('--bg-tertiary').trim();
    } catch {
        return '';
    }
}

/**
 * Call `onChange` whenever the app's theme may have changed: applyTheme writes
 * `data-theme`, `class` and `style` on <html>.
 */
function useThemeChange(onChange: () => void) {
    const changed = useEffectEvent(onChange);
    useEffect(() => {
        if (typeof MutationObserver === 'undefined') return undefined;
        const observer = new MutationObserver(() => changed());
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
        return () => observer.disconnect();
    }, []);
}

/**
 * The form field that has the focus (`data-fill-field` on its row), read in
 * the capture phase so it is known before the form reports the new spot.
 */
function useFocusedField() {
    const field = useRef<string | null>(null);
    useEffect(() => {
        const onFocus = (e: FocusEvent) => {
            const target = e.target instanceof Element ? e.target : null;
            const row = target?.closest<HTMLElement>('[data-fill-field]');
            if (row?.dataset.fillField) field.current = row.dataset.fillField;
        };
        window.addEventListener('focusin', onFocus, true);
        return () => window.removeEventListener('focusin', onFocus, true);
    }, []);
    return field;
}

function post(frame: HTMLIFrameElement | undefined, message: Record<string, unknown>) {
    // '*' is the only usable target for a frame without an origin.
    try { frame?.contentWindow?.postMessage(message, '*'); } catch (err) { logger.debug('preview frame gone', err); } // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- sandboxed srcDoc frame has an opaque origin
}

/** Mark the passage of the field the person is at, and (when asked) bring it into view. */
function pointAt(frame: HTMLIFrameElement | undefined, spot: string, scroll: boolean) {
    post(frame, { __beeflowDocAnchors: true, activeId: 'spot', anchors: spot ? [{ id: 'spot', quote: spot }] : [] });
    if (spot && scroll) post(frame, { __beeflowDocReveal: true, quote: spot });
}

/**
 * The page on screen and the one loading behind it. `html` changing puts a new
 * page behind; `promote` shows it and drops the old one.
 */
function useLayers(html: string | undefined) {
    const [layers, setLayers] = useState<Layers>(() => firstLayers(html));
    useAdjustOnChange([html], () => {
        if (html !== undefined) setLayers((l) => ({ ...l, back: { id: l.count + 1, html }, count: l.count + 1 }));
    });
    const promote = (id: number) => setLayers((l) => (l.back?.id === id ? { front: l.back, back: null, count: l.count } : l));
    return { layers, promote };
}

/** The two frames, what they report, and what is sent to them. */
function useFrames(html: string | undefined, spot: string, onEscape?: () => void) {
    const { layers, promote } = useLayers(html);
    const frames = useRef(new Map<number, HTMLIFrameElement>());
    const scrollY = useRef(0);
    const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
    const later = (ms: number, run: () => void) => {
        const timer = setTimeout(() => { timers.current.delete(timer); run(); }, ms);
        timers.current.add(timer);
    };
    useEffect(() => {
        const pending = timers.current;
        return () => { pending.forEach(clearTimeout); pending.clear(); };
    }, []);

    const theme = () => ({ __beeflowDocTheme: true, desk: deskColour(), fit: true });
    const onReady = useEffectEvent((id: number, frame: HTMLIFrameElement) => {
        post(frame, theme());
        if (scrollY.current) post(frame, { __beeflowDocScroll: true, y: scrollY.current });
        pointAt(frame, spot, false);
        // The first page has nothing to wait behind; a later one first settles at the reader's place.
        later(layers.front ? SWAP_MS : 0, () => promote(id));
    });
    // A key the frame passed on: Escape inside the page closes the dialog it is in.
    const onFrameKey = useEffectEvent((key: unknown) => { if (key === 'escape') onEscape?.(); });
    useThemeChange(() => frames.current.forEach((frame) => post(frame, theme())));
    useEffect(() => {
        const onMessage = (e: MessageEvent) => {
            const data: unknown = e.data;
            if (!data || typeof data !== 'object') return;
            const d = data as Record<string, unknown>;
            // The frames have no origin ("null"): which window sent it is the check.
            for (const [id, frame] of frames.current) {
                if (e.source !== frame.contentWindow) continue;
                if (d.__beeflowDocReady) onReady(id, frame);
                else if (d.__beeflowDocScrolled) scrollY.current = Number(d.y) || 0;
                else if (d.__beeflowDocKey === true) onFrameKey(d.key);
                return;
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, []);

    // A page that never reports is shown all the same.
    const backId = layers.back?.id;
    const showAnyway = useEffectEvent((id: number) => promote(id));
    useEffect(() => {
        if (backId === undefined) return undefined;
        const timer = setTimeout(() => showAnyway(backId), SHOW_ANYWAY_MS);
        return () => clearTimeout(timer);
    }, [backId]);

    // The field the person is at: marked in the page that is on screen. Only a
    // move to another field scrolls; its text changing (a value typed in) marks
    // it again where the reader is, and a new page keeps the reader's place (onReady marks it there).
    const frontId = layers.front?.id;
    const focused = useFocusedField();
    const scrolledFor = useRef<string | null | undefined>(undefined);
    const showSpot = useEffectEvent((text: string) => {
        if (frontId === undefined) return;
        const moved = !!text && focused.current !== scrolledFor.current;
        if (moved) scrolledFor.current = focused.current;
        pointAt(frames.current.get(frontId), text, moved);
    });
    useEffect(() => { showSpot(spot); }, [spot]);
    const attach = (id: number) => (frame: HTMLIFrameElement | null) => {
        if (frame) frames.current.set(id, frame);
        else frames.current.delete(id);
    };
    return { layers, attach };
}

interface FilledPreviewProps {
    documentId: string;
    /** The document's revision as the form last heard it: another one reads the page again. */
    revision: string;
    load: TemplateFillApi['preview'];
    /** The text of the field the person is at (its value, or its label in brackets): brought into view and marked. */
    spot?: string;
    /** What the host puts at the right of the caption (the editor: back to the text). */
    actions?: ReactNode;
    /** Escape pressed inside the page (the frame has the keyboard then): a dialog closes on it. */
    onEscape?: () => void;
}

function Caption({ gaps, known, actions }: { gaps: number; known: boolean; actions?: ReactNode }) {
    const { t } = useTranslation();
    let text = '';
    if (known) {
        text = gaps > 0
            ? nOf(t, 'chat_templates.preview_gaps', gaps, '1 field that is still needed is shown as [its name].', '{count} fields that are still needed are shown as [their name].')
            : t('chat_templates.preview_complete', 'This is how the document reads with what is filled in.');
    }
    return (
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-1.5 text-xs text-[var(--text-secondary)]">
            <span className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                <Eye size={13} aria-hidden="true" />{t('chat_templates.preview_title', 'Preview')}
            </span>
            <span role="status" data-testid="filled-preview-caption" data-gaps={known ? gaps : undefined} className="min-w-0 flex-1">{text}</span>
            {actions}
        </div>
    );
}

export default function FilledPreview({ documentId, revision, load, spot = '', actions, onEscape }: FilledPreviewProps) {
    const { t } = useTranslation();
    const query = useFilledPreviewQuery(documentId, revision, load);
    const { layers, attach } = useFrames(query.data?.html, spot, onEscape);
    const failed = query.isError && !layers.front && !layers.back;
    return (
        <div className="flex h-full min-h-0 w-full flex-col" data-testid="filled-preview">
            <Caption gaps={query.data?.gaps.length ?? 0} known={!!query.data} actions={actions} />
            <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--bg-tertiary)]">
                {[layers.front, layers.back].map((layer) => layer && (
                    <iframe key={layer.id} ref={attach(layer.id)} srcDoc={layer.html} sandbox="allow-scripts" referrerPolicy="no-referrer"
                        title={t('chat_templates.preview_frame', 'The document with what is filled in')}
                        aria-hidden={layer !== layers.front} tabIndex={layer === layers.front ? 0 : -1}
                        data-testid={layer === layers.front ? 'filled-preview-frame' : 'filled-preview-next'}
                        className={`absolute inset-0 block h-full w-full border-0 bg-transparent ${layer === layers.front ? '' : 'pointer-events-none opacity-0'}`} />
                ))}
                {!layers.front && !failed && (
                    <div className="absolute inset-0 flex items-center justify-center" role="status" aria-label={t('chat_templates.preview_loading', 'Loading the preview…')}>
                        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent-primary)] border-t-transparent" aria-hidden="true" />
                    </div>
                )}
                {failed && (
                    <p role="alert" className="absolute inset-0 m-0 flex items-center justify-center gap-1 px-6 text-center text-sm text-[var(--text-secondary)]">
                        {t('chat_templates.preview_failed', 'The preview could not be shown.')}
                        <button type="button" onClick={() => { void query.refetch(); }} className={FILL_LINK}>{t('chat_templates.form_check_retry', 'Try again')}</button>
                    </p>
                )}
            </div>
        </div>
    );
}
