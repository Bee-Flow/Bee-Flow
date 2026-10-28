import type { TierTrackProps } from '../TierSlider.types';
import useTranslation from '@/hooks/useTranslation';
import { THUMB_PAD, THUMB_RADIUS, FILL_START_PCT, FILL_MIN_END_PCT, FILL_MAX_END_PCT } from './TierSlider.constants';

/** Horizontal centre of stop `i`, as a CSS length usable by both rows. */
const stopCenter = (i: number, count: number) => (count < 2
    ? '50%'
    : `calc(${THUMB_PAD}px + (100% - ${THUMB_PAD * 2}px) * ${i / (count - 1)})`);

// …which puts the four stops at 20 / 28 / 36 / 44% ink at the thumb — far
// enough apart to tell the levels apart at a glance without the shallow end
// disappearing into the track.
const inkMix = (pct: number) => `color-mix(in srgb, var(--text-primary) ${pct}%, var(--bg-tertiary))`;

const fillGradientFor = (travel: number) => {
    const end = Math.round(FILL_MIN_END_PCT + (FILL_MAX_END_PCT - FILL_MIN_END_PCT) * travel);
    return `linear-gradient(90deg, ${inkMix(FILL_START_PCT)} 0%, ${inkMix(end)} 100%)`;
};

/**
 * The track itself: a filled bar, one dot per stop, and the labels under it.
 * `activeIndex` is -1 when the selected tier isn't on the depth scale, which
 * dims the whole track rather than parking the thumb somewhere misleading.
 */
export function TierTrack({ stops, activeIndex, metaFor, onSelect, trackRef, onPointerDown, onPointerMove, onPointerEnd, onKeyDown }: TierTrackProps) {
    const { t } = useTranslation();
    const onScale = activeIndex >= 0;
    const count = stops.length;
    // How far along the track the thumb has travelled, 0–1.
    const travel = onScale && count > 1 ? activeIndex / (count - 1) : 0;

    return (
        <>
            <div
                ref={trackRef}
                role="slider"
                tabIndex={0}
                aria-label={t('tier.response_depth', 'Response depth')}
                aria-valuemin={0}
                aria-valuemax={Math.max(0, count - 1)}
                aria-valuenow={Math.max(0, activeIndex)}
                aria-valuetext={onScale ? metaFor(stops[activeIndex]).label : 'Not on the depth scale'}
                onKeyDown={onKeyDown}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                data-testid="tier-slider-track"
                style={{
                    position: 'relative', height: '40px', borderRadius: '9999px',
                    border: '1px solid var(--border-subtle)',
                    background: 'var(--bg-tertiary)',
                    cursor: 'pointer', touchAction: 'none',
                    opacity: onScale ? 1 : 0.45,
                }}
            >
                {/* Fill runs from the left inset to the far edge of the thumb,
                    so its rounded cap sits under the thumb instead of poking
                    out past it. Colour tracks travel — see fillColorFor. */}
                <div
                    data-testid="tier-slider-fill"
                    aria-hidden="true"
                    style={{
                        position: 'absolute', left: '5px', top: '5px', bottom: '5px',
                        width: onScale
                            ? `calc(${stopCenter(activeIndex, count)} + ${THUMB_RADIUS - 5}px)`
                            : '0px',
                        borderRadius: '9999px',
                        background: fillGradientFor(travel),
                        opacity: onScale ? 1 : 0,
                        transition: 'width 0.18s ease, background 0.28s ease',
                    }}
                />
                {stops.map((key, i) => {
                    const isActive = i === activeIndex;
                    const isPassed = onScale && i < activeIndex;
                    const meta = metaFor(key);
                    const dot = isActive ? 28 : 10;
                    return (
                        <button
                            key={key}
                            type="button"
                            tabIndex={-1}
                            onClick={(e) => { e.stopPropagation(); onSelect(key); }}
                            title={`${meta.label} — ${meta.desc || ''}`.trim()}
                            aria-label={meta.label}
                            data-testid={`tier-slider-stop-${key}`}
                            style={{
                                position: 'absolute',
                                left: stopCenter(i, count),
                                top: '50%',
                                // Centres the dot on its stop whatever its size,
                                // so growing the active one moves nothing else.
                                transform: 'translate(-50%, -50%)',
                                width: `${dot}px`, height: `${dot}px`,
                                borderRadius: '9999px', border: 'none', padding: 0, cursor: 'pointer',
                                background: isActive ? '#fff' : isPassed ? 'rgba(255,255,255,0.6)' : 'var(--text-tertiary)',
                                opacity: isActive || isPassed ? 1 : 0.45,
                                boxShadow: isActive ? '0 1px 4px rgba(0,0,0,0.25)' : 'none',
                                transition: 'width 0.18s ease, height 0.18s ease, background 0.18s ease',
                            }}
                        />
                    );
                })}
            </div>

            {/* Same `stopCenter` expression as the dots. The outer two are
                nudged inward so a wide label ("Deep Thinking") stays inside the
                panel instead of centring itself off the edge. */}
            <div data-testid="tier-slider-labels" className="[position:relative] h-[16px] [margin-top:8px]">
                {stops.map((key, i) => (
                    <span
                        key={key}
                        style={{
                            position: 'absolute',
                            left: stopCenter(i, count),
                            transform: `translateX(${i === 0 ? '-30%' : i === count - 1 ? '-70%' : '-50%'})`,
                            whiteSpace: 'nowrap',
                            fontSize: '10px', lineHeight: '16px',
                            color: i === activeIndex ? 'var(--text-primary)' : 'var(--text-tertiary)',
                            fontWeight: i === activeIndex ? 600 : 400,
                        }}
                    >
                        {t(`tier.${key}`, metaFor(key).label)}
                    </span>
                ))}
            </div>
        </>
    );
}
