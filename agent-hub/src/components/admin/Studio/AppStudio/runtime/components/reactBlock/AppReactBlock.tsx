import { TriangleAlert } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { themeVariables } from '@shared/blockTemplate/index.mjs';
import useTranslation from '@/hooks/useTranslation';
import ReactFrame from '@/marketing/reactBlock/ReactFrame';
import { useReactRuntime } from '@/marketing/reactBlock/loadRuntime';
import { useRuntime, type RuntimeValue } from '../../RuntimeContext';
import type { NodeProps } from '../appNode.types';
import { isBoxed, useBlockScope, useBlockTheme, wiredEvents } from '../customBlock/blockHost';
import { sanitizeBlockCssClient } from '../customBlock/blockCss';
import { themeVariablesOf, type BlockTheme } from '../customBlock/blockTheme';
import { acceptFrameEvent, createEventGate } from './frameEvents';

/**
 * App Studio runtime: 'react_block'. Spec: server/appStudio/componentSpecs/types/react_block.js.
 *
 * The builder's own React component (compiled on save by app_edit_react_block), drawn in the
 * website's React frame (marketing/reactBlock/ReactFrame.tsx) with policy 'sealed':
 *   - sandbox="allow-scripts" only: an opaque origin, no popups, no top navigation, no forms;
 *   - the document's first head element is a policy that loads nothing and connects nowhere
 *     (frameDoc.ts SEALED_FRAME_CSP): no fetch, XHR, WebSocket or beacon can carry data out;
 *   - that frame sits inside an outer sandboxed frame whose policy has frame-src 'none', so the
 *     component cannot navigate its own frame to an outside address, whatever policy the page
 *     has; the outer frame's relay passes on only props in, heights and events out (sealedRelay.ts);
 *   - the data goes in only as the block's declared inputs, resolved here under the viewer's
 *     own session like every binding, by postMessage into this element's own frame;
 *   - what comes out is an event: only one the block wired, from this frame's window, plain
 *     JSON within a size cap, rate-limited (./frameEvents.ts), and only outside the editor. It
 *     runs through the app's own runAction, where the server authorises every step.
 */

interface ReactBlockValue {
    source?: unknown;
    css?: unknown;
    inputs?: unknown;
    events?: unknown;
    compiled?: unknown;
    compileError?: unknown;
}

interface ReactBlockProps {
    block?: ReactBlockValue | null;
}

interface Live {
    wired: Record<string, string>;
    editing: boolean;
    runAction: RuntimeValue['runAction'];
    item: unknown;
    index: unknown;
}

const NOTICE = 'flex min-h-24 w-full items-center justify-center gap-2 border border-dashed border-[var(--border-default)] px-3 py-4 text-center text-sm text-[var(--text-muted)] rounded-[var(--app-radius,8px)] bfa-react_block__notice';

/** The `:root{…}` rule the frame gets: the app's look as `--bf-*`, plus the names the frame's base stylesheet reads. */
function appFrameTheme(theme: BlockTheme): string {
    const scheme = theme.appearance === 'dark' ? 'dark' : 'light';
    return `:root{color-scheme:${scheme};${themeVariables(themeVariablesOf(theme))}--bf-font-body:var(--bf-font);--bf-text-secondary:var(--bf-text-muted);}`;
}

function Notice({ status, text, detail }: { status: string; text: string; detail?: string }) {
    return (
        <div className={NOTICE} role="note" data-app-react-block={status}>
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
                {text}
                {detail ? <span className="block break-words text-xs text-[var(--error-ink)]">{detail}</span> : null}
            </span>
        </div>
    );
}

export default function AppReactBlock({ node }: NodeProps<ReactBlockProps>) {
    const { t, locale } = useTranslation();
    const runtime = useRuntime();
    const stored = node.props?.block;
    const block = useMemo<ReactBlockValue>(() => (stored && typeof stored === 'object' ? stored : {}), [stored]);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const editing = runtime.mode === 'edit';
    const compiled = typeof block.compiled === 'string' ? block.compiled : '';
    const scope = useBlockScope(block, runtime);
    const theme = useBlockTheme(hostRef, compiled !== '');
    const wired = useMemo(() => wiredEvents(block.events), [block.events]);
    const css = useMemo(() => sanitizeBlockCssClient(block.css).css, [block.css]);
    const frameRuntime = useReactRuntime();

    const live = useRef<Live>({ wired, editing, runAction: runtime.runAction, item: runtime.scope.item, index: runtime.scope.index });
    useLayoutEffect(() => {
        live.current = { wired, editing, runAction: runtime.runAction, item: runtime.scope.item, index: runtime.scope.index };
    });
    const gate = useRef(createEventGate());
    const onFrameEvent = useCallback((data: Record<string, unknown>) => {
        const now = live.current;
        // The editor hands the frame's events to nobody: a click there selects the block.
        if (now.editing) return;
        const accepted = acceptFrameEvent(data, now.wired);
        if (!accepted || !gate.current()) return;
        void now.runAction(accepted.actionId, { value: accepted.value, item: now.item, index: typeof now.index === 'number' ? now.index : undefined });
    }, []);

    const boxed = isBoxed(node);
    const source = typeof block.source === 'string' ? block.source : '';
    if (!source.trim()) {
        return editing ? <Notice status="empty" text={t('studio_apps_react_block.empty', 'Empty React block. Ask the builder to write its component.')} /> : null;
    }
    if (!compiled) {
        const detail = typeof block.compileError === 'string' ? block.compileError.split('\n')[0] : '';
        return editing ? <Notice status="not-compiled" text={t('studio_apps_react_block.not_compiled', 'This React block does not compile yet.')} detail={detail} /> : null;
    }
    return (
        <div ref={hostRef} className={`relative w-full min-w-0 bfa-react_block__root${boxed ? ' h-full min-h-0' : ''}`} data-app-react-block="drawn">
            <ReactFrame
                runtime={frameRuntime}
                compiled={compiled}
                css={css}
                theme={appFrameTheme(theme)}
                props={scope.values}
                mode={editing ? 'editor' : 'public'}
                minHeight={24}
                title={t('studio_apps_react_block.frame_title', 'React block')}
                lang={locale}
                policy="sealed"
                onFrameEvent={onFrameEvent}
                fill={boxed}
            />
            {editing ? <div className="absolute inset-0" data-react-block-shield="true" aria-hidden="true" /> : null}
        </div>
    );
}
