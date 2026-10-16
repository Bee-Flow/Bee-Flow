import type { CSSProperties } from 'react';
import type { BackgroundVideoData } from './motion.types';

const FITS = ['cover', 'contain'] as const;
const POSITIONS = ['center', 'top', 'bottom'] as const;
const OVERLAYS = ['none', 'dark', 'light', 'gradient', 'custom'] as const;

/** Hex, rgb()/hsl() or a theme variable; anything else is ignored rather than written into CSS. */
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([0-9 ,.%/]+\)|var\(--[a-z0-9-]+\))$/i;

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
    return allowed.find((a) => a === value) ?? fallback;
}

export function hasBackgroundVideo(video?: BackgroundVideoData | null): boolean {
    return [video?.src, video?.webmSrc, video?.poster].some((v) => typeof v === 'string' && v.trim() !== '');
}

export function hasVideoSource(video?: BackgroundVideoData | null): boolean {
    return [video?.src, video?.webmSrc].some((v) => typeof v === 'string' && v.trim() !== '');
}

export interface BackgroundVideoLook {
    fit: (typeof FITS)[number];
    position: (typeof POSITIONS)[number];
    overlay: (typeof OVERLAYS)[number];
    overlayStyle: CSSProperties;
}

/** The sanitised look of a background video: class keys plus the overlay's dynamic colour and strength. */
export function backgroundVideoLook(video: BackgroundVideoData): BackgroundVideoLook {
    const overlay = pick(video.overlay, OVERLAYS, 'dark');
    const raw = Number(video.overlayOpacity);
    const percent = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 45;
    const overlayStyle: CSSProperties = { opacity: percent / 100 };
    const color = typeof video.overlayColor === 'string' ? video.overlayColor.trim() : '';
    if (overlay === 'custom' && SAFE_COLOR.test(color)) overlayStyle.background = color;
    return {
        fit: pick(video.fit, FITS, 'cover'),
        position: pick(video.position, POSITIONS, 'center'),
        overlay,
        overlayStyle,
    };
}

/** Classes for the section that carries the video: light text unless the overlay is light. */
export function backgroundVideoSectionClass(video?: BackgroundVideoData | null): string {
    if (!video || !hasBackgroundVideo(video)) return '';
    return backgroundVideoLook(video).overlay === 'light' ? 'has-bg-video' : 'has-bg-video has-bg-video--on-dark';
}
