import { SPOTLIGHT_PAD } from './tourDom';
import type { TargetRect } from './OnboardingTour.types';

/** Dimmer: spotlight cutout when we have a target, else a flat scrim. */
export function TourSpotlight({ rect }: { rect: TargetRect | null }) {
    return rect ? (
        <div
            aria-hidden="true"
            style={{
                position: 'fixed',
                top: rect.top - SPOTLIGHT_PAD,
                left: rect.left - SPOTLIGHT_PAD,
                width: rect.width + SPOTLIGHT_PAD * 2,
                height: rect.height + SPOTLIGHT_PAD * 2,
                borderRadius: 12,
                boxShadow:
                    '0 0 0 9999px rgba(8, 9, 15, 0.62), 0 0 0 2px var(--accent-primary), 0 0 0 7px color-mix(in srgb, var(--accent-primary) 32%, transparent)',
                pointerEvents: 'none',
                transition: 'top .2s ease, left .2s ease, width .2s ease, height .2s ease',
                zIndex: 9998,
                animation: 'beeflowTourPulse 2s ease-in-out infinite',
            }}
        />
    ) : (
        <div aria-hidden="true" className="[position:fixed] [inset:0] [background:rgba(8,_9,_15,_0.62)] [z-index:9998]" />
    );
}

/** The keyframes the spotlight and the card animate with (and the reduced-motion override). */
export function TourStyles() {
    return (
        <style>{`
                @keyframes beeflowTourIn {
                    from { opacity: 0; transform: translateY(6px) scale(0.98); }
                    to   { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes beeflowTourPulse {
                    0%, 100% { box-shadow: 0 0 0 9999px rgba(8,9,15,0.62), 0 0 0 2px var(--accent-primary), 0 0 0 7px color-mix(in srgb, var(--accent-primary) 32%, transparent); }
                    50%      { box-shadow: 0 0 0 9999px rgba(8,9,15,0.62), 0 0 0 2px var(--accent-primary), 0 0 0 11px color-mix(in srgb, var(--accent-primary) 14%, transparent); }
                }
                @keyframes beeflowHintPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
                @media (prefers-reduced-motion: reduce) {
                    [aria-modal="true"], [aria-hidden="true"], #beeflow-tour-title { animation: none !important; }
                }
            `}</style>
    );
}
