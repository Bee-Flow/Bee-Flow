import { regionStyle, type ChangeRegion } from './pdfCompareMath';

/**
 * Red outlined boxes over the changed regions. Positioned in percentages of the
 * page box, so they stay aligned through zoom, scroll and resize. The 2px
 * border is a screen-space CSS border, not scaled with the page.
 */
export default function ChangeBoxes({ regions, activeIndex = -1 }: { regions: ChangeRegion[]; activeIndex?: number }) {
    if (!regions.length) return null;
    return (
        <div className="pointer-events-none absolute inset-0" data-pdf-changes={regions.length}>
            {regions.map((r, i) => (
                <div
                    key={i}
                    data-pdf-change={i}
                    style={regionStyle(r)}
                    className={`absolute box-border rounded-[2px] border-2 border-red-500 ${i === activeIndex ? 'bg-red-500/25 ring-2 ring-red-400/80' : 'bg-red-500/10'}`}
                />
            ))}
        </div>
    );
}
