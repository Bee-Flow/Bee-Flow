import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import SectionFrame from '../components/SectionFrame';
import ReactFrame from '../reactBlock/ReactFrame';
import { readSiteTheme, themeCss, type FrameMode } from '../reactBlock/frameDoc';
import { resolveBlockProps } from '../reactBlock/blockProps';
import { loadReactRuntime, loadedReactRuntime } from '../reactBlock/loadRuntime';
import { logger } from '../../utils/logger';

/**
 * React component block: an author's TSX, compiled by the CMS on save
 * (`compiled`, shared/cmsReact/compile.mjs), rendered in a sandboxed frame
 * with a React runtime this site serves itself (reactBlock/runtime).
 *
 * The frame gets the site's theme as `--bf-*` variables, read from this
 * section's computed style (so a dark band re-themes the component like any
 * other block) and re-read when the design changes. Its props are the block's
 * stored props with images and links resolved (reactBlock/blockProps).
 *
 * Without compiled code the public site renders nothing; the editor preview
 * shows why (compileError).
 */
interface ReactComponentData {
    enabled?: boolean;
    compiled?: unknown;
    compileError?: unknown;
    css?: unknown;
    fields?: unknown;
    props?: unknown;
    width?: unknown;
    minHeight?: unknown;
}

export const DEFAULT_MIN_HEIGHT = 240;
const MAX_MIN_HEIGHT = 4000;

/** The frame's starting height: the block's minHeight within 0..4000, else 240. */
export function frameMinHeight(value: unknown): number {
    const n = Number(value);
    if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return DEFAULT_MIN_HEIGHT;
    return Math.min(Math.max(Math.round(n), 0), MAX_MIN_HEIGHT);
}

function isEditorPreview(): boolean {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('preview');
}

const NO_SUBSCRIPTION = () => undefined;

/** The theme rule for the frame, re-read when the site's design or the block's band changes. */
function useSiteTheme(el: HTMLElement | null): string {
    const subscribe = useCallback((notify: () => void) => {
        if (!el || typeof MutationObserver === 'undefined') return NO_SUBSCRIPTION;
        const observer = new MutationObserver(notify);
        const watched = new Set([el.closest('.marketing-root'), el.closest('.cms-block-wrap'), document.documentElement]);
        for (const node of watched) {
            if (node) observer.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
        }
        return () => observer.disconnect();
    }, [el]);
    const snapshot = useCallback(() => themeCss(readSiteTheme(el)), [el]);
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The runtime text, once its chunk has arrived. */
function useRuntime(): string | null {
    const [runtime, setRuntime] = useState<string | null>(loadedReactRuntime);
    useEffect(() => {
        if (runtime !== null) return undefined;
        let live = true;
        loadReactRuntime().then(
            (text) => { if (live) setRuntime(text); },
            (err: unknown) => logger.warn('[ReactComponent] the React runtime could not be loaded', err),
        );
        return () => { live = false; };
    }, [runtime]);
    return runtime;
}

function CompilePlaceholder({ error }: { error: string }) {
    return (
        <div
            role="status"
            className="min-h-[160px] [display:flex] [flex-direction:column] [gap:0.5rem] [justify-content:center] [padding:1.5rem] [border:1px_dashed_rgba(15,23,42,0.18)] [border-radius:12px] [color:var(--text-muted,#94A3B8)] [font-size:0.9rem] [line-height:1.5]"
        >
            <strong className="[color:var(--text-primary,#0F172A)]">
                {error ? 'This React component does not compile yet.' : 'Write a React component in the editor panel. It renders here in a sandboxed frame.'}
            </strong>
            {error ? <pre className="[margin:0] [white-space:pre-wrap] [word-break:break-word] [font:12.5px/1.5_ui-monospace,SFMono-Regular,Menlo,monospace] [color:#B91C1C]">{error}</pre> : null}
        </div>
    );
}

export default function ReactComponent({ data }: { data?: ReactComponentData | null }) {
    const [el, setEl] = useState<HTMLElement | null>(null);
    const theme = useSiteTheme(el);
    const runtime = useRuntime();
    if (!data || data.enabled === false) return null;

    const mode: FrameMode = isEditorPreview() ? 'editor' : 'public';
    const compiled = typeof data.compiled === 'string' ? data.compiled : '';
    const compileError = typeof data.compileError === 'string' ? data.compileError : '';
    if (!compiled && mode === 'public') return null;
    const inner = data.width === 'full' ? 'react-component-block__full' : 'container';

    return (
        <SectionFrame id="react-component" name="React component" enabled>
            <section ref={setEl} className="react-component-block">
                <div className={inner}>
                    {compiled ? (
                        <ReactFrame
                            runtime={el ? runtime : null}
                            compiled={compiled}
                            css={typeof data.css === 'string' ? data.css : ''}
                            theme={theme}
                            props={resolveBlockProps(data.fields, data.props)}
                            mode={mode}
                            minHeight={frameMinHeight(data.minHeight)}
                            title="React component"
                        />
                    ) : (
                        <CompilePlaceholder error={compileError} />
                    )}
                </div>
            </section>
        </SectionFrame>
    );
}
