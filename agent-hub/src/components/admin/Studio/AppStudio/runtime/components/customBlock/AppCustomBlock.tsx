import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { FRAME_SANDBOX, clampFrameHeight, isBlockName } from '@shared/blockTemplate/index.mjs';
import useTranslation from '@/hooks/useTranslation';
import { resolveBinding } from '../../resolveBinding';
import { useRuntime, type RuntimeValue } from '../../RuntimeContext';
import { HEIGHT_PX } from '../../styleResolver.constants';
import { isFill, resolveHeightCss } from '../../styleResolver.helpers';
import type { NodeProps } from '../appNode.types';
import { blockEntries, buildBlockFrame, type BlockEmit, type BlockValue } from './blockPipeline';
import { FALLBACK_THEME, resolveBlockTheme, themeVariablesOf, type BlockTheme } from './blockTheme';

/**
 * App Studio runtime: 'custom_block'. Spec: server/appStudio/componentSpecs/types/custom_block.js.
 *
 * The builder's own HTML template and stylesheet, drawn in a frame that runs no script and
 * loads nothing (./blockPipeline.ts and @shared/blockTemplate say how). This component is the
 * app's side: it resolves the block's inputs under the viewer's own session, the way every
 * component resolves a binding, has the frame document built from them, and hears a click
 * on a wired control.
 *
 * The frame holds no code and no data of its own: a wired control carries a number, and the
 * event and value behind that number stay here. An action runs through the app's own
 * runAction (the server authorises every step, as for a button), only an action the block
 * wired, and never in the editor (the canvas does not hand the frame any event).
 */

interface BlockProps {
    block?: BlockValue | null;
}

interface Live {
    emits: BlockEmit[];
    wired: Record<string, string>;
    runAction: RuntimeValue['runAction'];
    item: unknown;
    index: unknown;
}

const NOTICE = 'flex min-h-24 w-full items-center justify-center gap-2 border border-dashed border-[var(--border-default)] px-3 py-4 text-center text-sm text-[var(--text-muted)] rounded-[var(--app-radius,8px)] bfa-custom_block__notice';

/** `value` as plain JSON data: what a formula of the block may see, and what an action is handed. */
function jsonSafe(value: unknown): unknown {
    if (value === undefined) return null;
    try {
        return JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
        return null;
    }
}

/** The block's inputs resolved for this viewer, as plain data, and one text that changes when they do. */
function useBlockScope(block: BlockValue, runtime: RuntimeValue) {
    const { actionState, dataState, scope } = runtime;
    const values: Record<string, unknown> = {};
    for (const [name, binding] of blockEntries(block.inputs)) {
        // A stored block has usable names only; one that never passed the server may not.
        if (!isBlockName(name)) continue;
        values[name] = jsonSafe(resolveBinding(binding as never, { actionState, dataState, scope } as never).value);
    }
    const payload = JSON.stringify(values);
    return useMemo(() => ({ values: JSON.parse(payload) as Record<string, unknown>, payload }), [payload]);
}

/** The events of the block that name an action: event name → action id. */
function wiredEvents(events: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, actionId] of blockEntries(events)) if (isBlockName(name) && typeof actionId === 'string' && actionId) out[name] = actionId;
    return out;
}

/**
 * The app's look where the block sits. The theme reaches the page as attributes and inline
 * variables on the elements around the block (the app shell, the host theme on <html>), so
 * it is read once the block is drawn (`drawn`) and again whenever one of those changes.
 */
function useBlockTheme(hostRef: RefObject<HTMLDivElement | null>, drawn: boolean): BlockTheme {
    const [theme, setTheme] = useState<BlockTheme>(FALLBACK_THEME);
    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        const read = () => {
            const next = resolveBlockTheme(host);
            setTheme((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
        };
        read();
        if (typeof MutationObserver === 'undefined') return undefined;
        const observer = new MutationObserver(read);
        for (let el = host.parentElement; el; el = el.parentElement) observer.observe(el, { attributes: true });
        return () => observer.disconnect();
    }, [hostRef, drawn]);
    return theme;
}

/** The control a click or key press in the frame landed on, read without trusting what the frame's nodes are. */
function emitIndexOf(target: unknown): number | null {
    const node = target as { closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null } | null;
    const control = node && typeof node.closest === 'function' ? node.closest('[data-bf-emit]') : null;
    const raw = control ? control.getAttribute('data-bf-emit') : null;
    const index = raw === null ? NaN : Number(raw);
    return Number.isInteger(index) && index >= 0 ? index : null;
}

/** Enter or Space on a link that acts as a button (a <button> turns both into a click itself). */
function isLinkActivation(event: Event): boolean {
    const pressed = (event as KeyboardEvent).key;
    const tag = (event.target as { localName?: string } | null)?.localName;
    return (pressed === 'Enter' || pressed === ' ') && tag === 'a';
}

/**
 * The host's hold on the loaded frame: its height follows the content (unless the block has a
 * fixed box), and a click or Enter/Space on a numbered control runs the action wired to it.
 */
function useFrameHost(frameRef: RefObject<HTMLIFrameElement | null>, live: RefObject<Live>, auto: boolean) {
    const measure = useCallback(() => {
        const frame = frameRef.current;
        const body = frame?.contentDocument?.body;
        if (!frame || !body || !auto) return;
        // The body is as tall as its content (the document element is at least as tall as the frame).
        const height = `${clampFrameHeight(body.getBoundingClientRect().height)}px`;
        if (frame.style.height !== height) frame.style.height = height;
    }, [frameRef, auto]);

    const raise = useCallback((event: Event) => {
        const index = emitIndexOf(event.target);
        if (index === null) return;
        event.preventDefault();
        const now = live.current;
        const entry = now.emits[index];
        const actionId = entry ? now.wired[entry.event] : undefined;
        if (!entry || !actionId) return;
        void now.runAction(actionId, { value: jsonSafe(entry.value), item: now.item, index: typeof now.index === 'number' ? now.index : undefined });
    }, [live]);

    const onLoad = useCallback(() => {
        const doc = frameRef.current?.contentDocument;
        if (!doc) return;
        doc.addEventListener('click', raise);
        doc.addEventListener('keydown', (event) => {
            if (isLinkActivation(event)) raise(event);
        });
        // A <details> that opens or closes changes the height.
        doc.addEventListener('toggle', measure, true);
        measure();
    }, [frameRef, raise, measure]);

    useEffect(() => {
        const frame = frameRef.current;
        if (!frame || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(frame);
        return () => observer.disconnect();
    }, [frameRef, measure]);

    return onLoad;
}

/** A height from the style knobs wins; without one the frame is as tall as its content. */
function isBoxed(node: NodeProps<BlockProps>['node']): boolean {
    const style = node.style as { height?: string } | undefined;
    return isFill(node as never) || Boolean(resolveHeightCss(style as never)) || Boolean(HEIGHT_PX[style?.height || '']);
}

function BlockNotice({ status, text }: { status: string; text: string }) {
    return (
        <div className={NOTICE} role="note" data-app-custom-block={status}>
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{text}</span>
        </div>
    );
}

export default function AppCustomBlock({ node }: NodeProps<BlockProps>) {
    const { t, locale } = useTranslation();
    const runtime = useRuntime();
    const stored = node.props?.block;
    const block = useMemo<BlockValue>(() => (stored && typeof stored === 'object' ? stored : {}), [stored]);
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const editing = runtime.mode === 'edit';
    const scope = useBlockScope(block, runtime);
    const theme = useBlockTheme(hostRef, typeof block.template === 'string' && block.template.trim() !== '');
    const wired = useMemo(() => wiredEvents(block.events), [block.events]);
    const frame = useMemo(() => buildBlockFrame({
        block,
        scope: scope.values,
        // The editor hands the frame no event at all: a click there selects the block.
        events: editing ? [] : Object.keys(wired),
        theme: themeVariablesOf(theme),
        dark: theme.appearance === 'dark',
        lang: locale,
    }), [block, scope, editing, wired, theme, locale]);

    const live = useRef<Live>({ emits: frame.emits, wired, runAction: runtime.runAction, item: runtime.scope.item, index: runtime.scope.index });
    useLayoutEffect(() => {
        live.current = { emits: frame.emits, wired, runAction: runtime.runAction, item: runtime.scope.item, index: runtime.scope.index };
    });
    const boxed = isBoxed(node);
    const onLoad = useFrameHost(frameRef, live, !boxed);

    if (frame.empty) {
        return editing ? <BlockNotice status="empty" text={t('studio_apps_block.empty', 'Empty custom block. Write its template in the panel.')} /> : null;
    }
    return (
        <div ref={hostRef} className={`relative w-full min-w-0 bfa-custom_block__root${boxed ? ' h-full min-h-0' : ''}`} data-app-custom-block="drawn">
            <iframe
                ref={frameRef}
                title={t('studio_apps_block.frame_title', 'Custom block')}
                srcDoc={frame.doc}
                sandbox={FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                allow=""
                onLoad={onLoad}
                className={`block w-full border-0 bg-transparent bfa-custom_block__frame ${boxed ? 'h-full' : 'h-24'}`}
            />
            {editing ? <div className="absolute inset-0" data-custom-block-shield="true" aria-hidden="true" /> : null}
            {editing && frame.problems.length > 0 ? (
                <p className="relative mt-1 break-words text-xs text-[var(--error-ink)]" role="status" data-custom-block-problem="true">
                    {frame.problems[0]}
                </p>
            ) : null}
        </div>
    );
}
