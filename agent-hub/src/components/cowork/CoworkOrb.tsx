import { useId } from 'react';
import texture from '@/assets/cowork-neural-orb.webp';
import { useReducedMotion } from '@/hooks/useReducedMotion';

export type ActivityTone = 'thinking' | 'executing' | 'repair' | 'rest';

// Coordinates follow three fibres in the texture, in percentages of its original square.
const FIBRES = {
    thinking: 'M28.6 33.7 Q37 29.4 46.4 28.2 T64.9 23.3',
    executing: 'M27.4 40.4 Q37.5 36.4 47.8 39.3 C56.8 42 64.7 50.6 75.7 46.2',
    repair: 'M22.6 52 Q26.5 55.4 32.5 56.6 C42.7 57.1 49.8 60.4 58.2 65.8',
};

export default function CoworkOrb({ tone = 'thinking', activity }: { tone?: ActivityTone; activity?: string }) {
    const id = useId();
    const reducedMotion = useReducedMotion();
    return <div aria-hidden="true" className="cowork-orb" data-tone={tone}>
        <div className="cowork-orb-volume">
            <img src={texture} alt="" width="640" height="640" draggable={false} />
            {tone !== 'rest' && !reducedMotion && <svg className="cowork-orb-light" viewBox="0 0 100 100" fill="none">
                <defs>
                    <radialGradient id={id + '-fade'}>
                        <stop offset="65%" stopColor="white" /><stop offset="100%" stopColor="black" />
                    </radialGradient>
                    <mask id={id + '-core'}><circle cx="50" cy="50" r="44" fill={`url(#${id}-fade)`} /></mask>
                    <filter id={id + '-flow'} filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100" colorInterpolationFilters="sRGB">
                        <feTurbulence type="fractalNoise" baseFrequency=".024 .033" numOctaves="1" seed="8" />
                        <feOffset result="shiftedField">
                            <animate attributeName="dx" values="-7;7;-7" dur="12s" repeatCount="indefinite" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" />
                            <animate attributeName="dy" values="4;-4;4" dur="9s" repeatCount="indefinite" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" />
                        </feOffset>
                        <feDisplacementMap in="SourceGraphic" in2="shiftedField" scale="8" xChannelSelector="R" yChannelSelector="G" />
                    </filter>
                </defs>
                {/* The fibres and the signals bend together. The soft mask anchors the rim to the original silhouette. */}
                <g mask={`url(#${id}-core)`}>
                    <g filter={`url(#${id}-flow)`}>
                        <image href={texture} width="100" height="100" />
                        <Synapse fibre={FIBRES.thinking} duration="5.8s" begin="-2s" />
                        <Synapse fibre={FIBRES.repair} duration="7.2s" begin="-4.6s" />
                        <path key={activity} className="cowork-orb-signal" d={FIBRES[tone]} pathLength="1" />
                    </g>
                </g>
            </svg>}
        </div>
    </div>;
}

function Synapse({ fibre, duration, begin }: { fibre: string; duration: string; begin: string }) {
    return <g opacity="0">
        <animateMotion path={fibre} dur={duration} begin={begin} repeatCount="indefinite" />
        <animate attributeName="opacity" values="0;.85;.55;0;0" keyTimes="0;.18;.40;.66;1" dur={duration} begin={begin} repeatCount="indefinite" />
        <circle r="1.2" fill="#adcbff" opacity=".22" />
        <circle r=".44" fill="#edf7ff" />
    </g>;
}
