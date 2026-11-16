import { useEffect, useMemo, useRef, useState } from 'react';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import { buildReactFrameDoc, buildSealedOuterDoc, SEALED_FRAME_SANDBOX, type FrameMode, type FramePolicy } from './frameDoc';
import type { BlockProps } from './blockProps';

/**
 * The sandboxed frame of one `react-component` block.
 *
 * No allow-same-origin: the frame is an opaque origin, cannot read this page,
 * its cookies or storage, and can only talk through postMessage. The parent
 * listens to its own frame only (`e.source === frame.contentWindow`, the check
 * that keeps two blocks on one page apart and ignores every other window).
 *
 * The srcdoc is rebuilt only when the code, the stylesheet, the theme or the
 * mode change (that reloads the frame and resets the component's state). New
 * props are posted into the running frame instead (`bf-react-props`), so live
 * editing a prop keeps the component's state.
 *
 * policy 'sealed' (App Studio's react_block, frameDoc.ts SEALED_FRAME_CSP): the
 * sandbox is scripts only, the document carries a policy that loads and connects
 * nothing, the props (the app's data) go in by postMessage only, once the frame
 * has loaded and on every change, and a `bf-react-event` from this frame is
 * handed to onFrameEvent, which decides whether it does anything. The element
 * here is the OUTER frame (frameDoc.ts buildSealedOuterDoc, ./sealedRelay.ts):
 * the component runs in a frame inside it and talks through its relay.
 */
export const FRAME_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation';

/** A frame may not report itself taller than this (px); a runaway layout loop stays on screen. */
export const MAX_FRAME_HEIGHT = 20000;

export interface ReactFrameProps {
    /** The runtime text; null while it loads (the frame then holds its space, empty). */
    runtime: string | null;
    compiled: string;
    css: string;
    /** The `:root{…}` rule of themeCss. */
    theme: string;
    props: BlockProps;
    mode: FrameMode;
    minHeight: number;
    title: string;
    /** The page's language, for the frame's `<html lang>`. */
    lang?: string;
    /** 'site' (default) or 'sealed'; see above. */
    policy?: FramePolicy;
    /** Sealed only: the data of a `bf-react-event` message from this frame (untrusted). */
    onFrameEvent?: (data: Record<string, unknown>) => void;
    /** Fill the parent's height instead of following the content (a fixed box). */
    fill?: boolean;
}

type FrameMessage = { type?: unknown; height?: unknown } & Record<string, unknown>;

function postProps(frame: HTMLIFrameElement | null, props: BlockProps): void {
    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- sandboxed srcDoc frame has an opaque origin, so '*' is the only target that reaches it; the props are the block's public content, or a sealed app block's inputs the viewer may already read, sent to this element's own frame
    frame?.contentWindow?.postMessage({ type: 'bf-react-props', props }, '*');
}

/** The frame's height from a resize message, or null when the message carries none. */
function reportedHeight(data: FrameMessage): number | null {
    const h = Number(data.height);
    if (!Number.isFinite(h) || h < 0) return null;
    return Math.min(Math.ceil(h), MAX_FRAME_HEIGHT);
}

export default function ReactFrame({ runtime, compiled, css, theme, props, mode, minHeight, title, lang = '', policy = 'site', onFrameEvent, fill = false }: ReactFrameProps) {
    const sealed = policy === 'sealed';
    const frameRef = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState(minHeight);

    // One JSON string per distinct set of props: a parent that hands a new
    // object with the same values posts nothing and rebuilds nothing.
    const propsJson = JSON.stringify(props ?? {});
    const currentProps = useMemo(() => JSON.parse(propsJson) as BlockProps, [propsJson]);
    const latestProps = useRef(currentProps);
    useEffect(() => { latestProps.current = currentProps; }, [currentProps]);

    // The props the document is built with: the ones current when the
    // document last had to be rebuilt, not every later edit.
    const [docProps, setDocProps] = useState(currentProps);
    useAdjustOnChange([runtime, compiled, css, theme, mode, lang, policy], () => setDocProps(currentProps));
    const srcDoc = useMemo(
        () => {
            if (runtime === null) return undefined;
            const doc = buildReactFrameDoc({ runtime, compiled, css, theme, props: docProps, mode, lang, policy });
            // Sealed: the component's frame sits inside an outer frame whose policy it cannot navigate past (frameDoc.ts).
            return policy === 'sealed' ? buildSealedOuterDoc(doc, title) : doc;
        },
        [runtime, compiled, css, theme, docProps, mode, lang, policy, title],
    );
    const onEvent = useRef(onFrameEvent);
    useEffect(() => { onEvent.current = onFrameEvent; }, [onFrameEvent]);

    useEffect(() => {
        if (srcDoc === undefined || currentProps === docProps) return;
        postProps(frameRef.current, currentProps);
    }, [currentProps, docProps, srcDoc]);

    useEffect(() => {
        const onMessage = (e: MessageEvent) => {
            const frame = frameRef.current;
            if (!frame || e.source !== frame.contentWindow) return;
            const data = (e.data && typeof e.data === 'object' ? e.data : {}) as FrameMessage;
            if (data.type === 'bf-react-event') {
                if (sealed) onEvent.current?.(data);
                return;
            }
            if (data.type !== 'bf-react-resize') return;
            const next = reportedHeight(data);
            if (next !== null) setHeight(next);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [sealed]);

    // Props edited while the new document was loading were posted to the old
    // one; send the latest once the frame is up. A sealed document holds no
    // props at all: it always gets them here.
    const onLoad = () => {
        if (sealed || latestProps.current !== docProps) postProps(frameRef.current, latestProps.current);
    };

    return (
        <iframe
            ref={frameRef}
            srcDoc={srcDoc}
            title={title}
            sandbox={sealed ? SEALED_FRAME_SANDBOX : FRAME_SANDBOX}
            data-cms-frame="react"
            loading={sealed ? undefined : 'lazy'}
            height={fill ? undefined : height}
            onLoad={onLoad}
            referrerPolicy={sealed ? 'no-referrer' : undefined}
            allow={sealed ? '' : undefined}
            className={`w-[100%] [border:none] [display:block] [overflow:hidden] [background:transparent]${fill ? ' h-full' : ''}`}
        />
    );
}
