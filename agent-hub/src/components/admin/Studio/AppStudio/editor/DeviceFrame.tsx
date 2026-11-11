import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { PortalRoot } from '@/components/shared/portalRoot';
import { Toaster } from '@/components/shared/Toast';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { PreviewDevice } from '../state/appEditorState';
import { startFrameSync } from './deviceFrameSync';

/**
 * The Preview at a device's width.
 *
 * An app's responsive rules are @media rules, and those read the WINDOW's
 * width, so a canvas column that is narrower or wider than a phone can never
 * show the phone layout. Here the preview tree is portalled into a blank
 * same-origin iframe of the device's width: inside it the media queries read
 * the frame, which is the whole point. The frame gets a copy of every
 * stylesheet and the theme attributes of the editor's document
 * (deviceFrameSync), and a PortalRoot so the app's dialogs, drag overlay and
 * toasts open INSIDE the frame, as they would on the device.
 *
 * It is the same React tree as the unframed preview (a portal keeps every
 * context), so data, variables and form values carry over. When the column is
 * narrower than the device the frame is scaled down to fit; it still lays out
 * at the device's own width.
 */

type FramedDevice = Exclude<PreviewDevice, 'fit'>;

export const DEVICE_WIDTH: Record<FramedDevice, number> = { desktop: 1280, tablet: 834, phone: 390 };

// Static classes for the three widths (Tailwind only emits literal class names).
const WIDTH_CLASS: Record<FramedDevice, string> = { desktop: 'w-[1280px]', tablet: 'w-[834px]', phone: 'w-[390px]' };

// Standards mode (a bare about:blank is quirks mode) and a device viewport.
const SRC_DOC = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>';

/**
 * Scale the frame down when the column cannot hold the device width. Written
 * to the elements directly: the numbers change with every resize of the
 * column, and they are layout, not state.
 */
function useFitScale(areaRef: RefObject<HTMLDivElement | null>, boxRef: RefObject<HTMLDivElement | null>, frameRef: RefObject<HTMLIFrameElement | null>, width: number): number {
    const [scale, setScale] = useState(1);
    useLayoutEffect(() => {
        const area = areaRef.current;
        const box = boxRef.current;
        const frame = frameRef.current;
        if (!area || !box || !frame) return undefined;
        const fit = () => {
            const room = area.clientWidth;
            const next = room > 0 && room < width ? room / width : 1;
            if (next < 1) {
                box.style.width = `${Math.floor(width * next)}px`;
                frame.style.height = `${area.clientHeight / next}px`;
                frame.style.transform = `scale(${next})`;
                frame.style.transformOrigin = 'top left';
            } else {
                box.style.width = '';
                frame.style.height = '';
                frame.style.transform = '';
                frame.style.transformOrigin = '';
            }
            setScale(next);
        };
        fit();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(fit);
        observer.observe(area);
        return () => observer.disconnect();
    }, [areaRef, boxRef, frameRef, width]);
    return scale;
}

export function deviceLabel(device: FramedDevice, t: TranslateFn): string {
    if (device === 'phone') return t('studio_apps_device.phone', 'Phone');
    if (device === 'tablet') return t('studio_apps_device.tablet', 'Tablet');
    return t('studio_apps_device.desktop', 'Desktop');
}

export default function DeviceFrame({ device, children }: { device: FramedDevice; children: ReactNode }) {
    const { t } = useTranslation();
    const width = DEVICE_WIDTH[device];
    const areaRef = useRef<HTMLDivElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<HTMLIFrameElement>(null);
    const [body, setBody] = useState<HTMLElement | null>(null);
    const scale = useFitScale(areaRef, boxRef, frameRef, width);

    // The srcdoc document exists once the frame has loaded; a reload (the
    // element was moved) hands over a fresh body and the portal follows it.
    const onLoad = useCallback(() => {
        setBody(frameRef.current?.contentDocument?.body ?? null);
    }, []);
    useEffect(() => {
        if (!body) return undefined;
        return startFrameSync(document, body.ownerDocument);
    }, [body]);

    const label = deviceLabel(device, t);
    const size = scale < 1
        ? t('studio_apps_device.size_scaled', '{width} px, shown at {percent}%', { width, percent: Math.round(scale * 100) })
        : t('studio_apps_device.size', '{width} px', { width });

    return (
        <div className="flex h-full min-h-0 flex-col items-center gap-2 bg-[var(--bg-tertiary)] px-4 pb-4 pt-2" data-device-frame={device}>
            <div className="text-xs text-[var(--text-tertiary)]" data-device-frame-caption="">
                <span className="font-medium text-[var(--text-secondary)]">{label}</span>
                {' · '}
                {size}
            </div>
            <div ref={areaRef} className="flex min-h-0 w-full flex-1 justify-center">
                <div ref={boxRef} className="h-full max-w-full shrink-0 overflow-hidden rounded-xl border border-[var(--border-default)] shadow-lg">
                    <iframe
                        ref={frameRef}
                        title={t('studio_apps_device.frame_title', 'App preview at {device} width', { device: label })}
                        srcDoc={SRC_DOC}
                        onLoad={onLoad}
                        className={`block h-full border-0 bg-[var(--bg-primary)] ${WIDTH_CLASS[device]}`}
                    />
                </div>
            </div>
            {body ? createPortal(
                <PortalRoot.Provider value={body}>
                    {children}
                    <Toaster capture />
                </PortalRoot.Provider>,
                body,
            ) : null}
        </div>
    );
}
