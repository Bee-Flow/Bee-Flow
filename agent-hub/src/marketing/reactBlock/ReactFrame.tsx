import { useEffect, useMemo, useRef, useState } from 'react';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import { buildReactFrameDoc, type FrameMode } from './frameDoc';
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
}

type FrameMessage = { type?: unknown; height?: unknown };

function postProps(frame: HTMLIFrameElement | null, props: BlockProps): void {
    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- sandboxed srcDoc frame has an opaque origin; the props are the block's public content
    frame?.contentWindow?.postMessage({ type: 'bf-react-props', props }, '*');
}

/** The frame's height from a resize message, or null when the message carries none. */
export function reportedHeight(data: FrameMessage): number | null {
    const h = Number(data.height);
    if (!Number.isFinite(h) || h < 0) return null;
    return Math.min(Math.ceil(h), MAX_FRAME_HEIGHT);
}

export default function ReactFrame({ runtime, compiled, css, theme, props, mode, minHeight, title }: ReactFrameProps) {
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
    useAdjustOnChange([runtime, compiled, css, theme, mode], () => setDocProps(currentProps));
    const srcDoc = useMemo(
        () => (runtime === null ? undefined : buildReactFrameDoc({ runtime, compiled, css, theme, props: docProps, mode })),
        [runtime, compiled, css, theme, docProps, mode],
    );

    useEffect(() => {
        if (srcDoc === undefined || currentProps === docProps) return;
        postProps(frameRef.current, currentProps);
    }, [currentProps, docProps, srcDoc]);

    useEffect(() => {
        const onMessage = (e: MessageEvent) => {
            const frame = frameRef.current;
            if (!frame || e.source !== frame.contentWindow) return;
            const data = (e.data && typeof e.data === 'object' ? e.data : {}) as FrameMessage;
            if (data.type !== 'bf-react-resize') return;
            const next = reportedHeight(data);
            if (next !== null) setHeight(next);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, []);

    // Props edited while the new document was loading were posted to the old
    // one; send the latest once the frame is up.
    const onLoad = () => {
        if (latestProps.current !== docProps) postProps(frameRef.current, latestProps.current);
    };

    return (
        <iframe
            ref={frameRef}
            srcDoc={srcDoc}
            title={title}
            sandbox={FRAME_SANDBOX}
            data-cms-frame="react"
            loading="lazy"
            height={height}
            onLoad={onLoad}
            className="w-[100%] [border:none] [display:block] [overflow:hidden] [background:transparent]"
        />
    );
}
