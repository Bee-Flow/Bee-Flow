import { FieldRow, Toggle } from '../fields';
import { PxSizeInput, SegmentedControl } from '../primitives';
import type { SegmentedOption } from '../primitives.types';
import { useTranslation } from '@/hooks/useTranslation';
import {
    BG_POSITIONS, BG_REPEATS, BG_SIZE_PX_MAX, BG_SIZE_PX_MIN, backgroundSizePx, cleanBackgroundSize,
} from '@/marketing/blockStyleEnums.generated.mjs';

/** The placement keys of block.style, all optional (a missing key = cover / center / no-repeat / shown on mobile). */
interface BackgroundPlacement {
    backgroundSize?: string;
    backgroundPosition?: string;
    backgroundRepeat?: string;
    backgroundHideMobile?: boolean;
}

export interface BackgroundPlacementControlProps {
    value: BackgroundPlacement;
    onChange: (patch: BackgroundPlacement) => void;
}

type SizeMode = 'cover' | 'contain' | 'auto' | 'px';
const DEFAULT_PX = 480;

const POSITION_LABELS: Record<string, [string, string]> = {
    'top-left': ['cms_site.site.controls.bg_pos_top_left', 'Top left'],
    'top': ['cms_site.site.controls.bg_pos_top', 'Top'],
    'top-right': ['cms_site.site.controls.bg_pos_top_right', 'Top right'],
    'left': ['cms_site.site.controls.bg_pos_left', 'Left'],
    'center': ['cms_site.site.controls.bg_pos_center', 'Center'],
    'right': ['cms_site.site.controls.bg_pos_right', 'Right'],
    'bottom-left': ['cms_site.site.controls.bg_pos_bottom_left', 'Bottom left'],
    'bottom': ['cms_site.site.controls.bg_pos_bottom', 'Bottom'],
    'bottom-right': ['cms_site.site.controls.bg_pos_bottom_right', 'Bottom right'],
};

/**
 * BackgroundPlacementControl: where a block's background image sits. Size
 * (cover, contain, auto or a pixel width), a 3x3 anchor grid, repeat, and a
 * switch to hide the image on phones. Each control writes an enum member or a
 * whole number of pixels, the only values the server store accepts.
 */
export default function BackgroundPlacementControl({ value, onChange }: BackgroundPlacementControlProps) {
    const { t } = useTranslation();
    const size = cleanBackgroundSize(value.backgroundSize);
    const px = backgroundSizePx(size);
    const mode: SizeMode = px !== null ? 'px' : (size as SizeMode | null) || 'cover';
    const position = (BG_POSITIONS as string[]).includes(value.backgroundPosition || '') ? value.backgroundPosition : 'center';
    const repeat = (BG_REPEATS as string[]).includes(value.backgroundRepeat || '') ? value.backgroundRepeat : 'no-repeat';

    const sizeOptions: SegmentedOption<SizeMode>[] = [
        { value: 'cover', label: t('cms_site.site.controls.bg_size_cover', 'Cover') },
        { value: 'contain', label: t('cms_site.site.controls.bg_size_contain', 'Contain') },
        { value: 'auto', label: t('cms_site.site.controls.bg_size_auto', 'Auto') },
        { value: 'px', label: t('cms_site.site.controls.bg_size_px', 'Width') },
    ];
    const repeatOptions: SegmentedOption<string>[] = [
        { value: 'no-repeat', label: t('cms_site.site.controls.bg_repeat_none', 'None') },
        { value: 'repeat', label: t('cms_site.site.controls.bg_repeat_both', 'Tile') },
        { value: 'repeat-x', label: t('cms_site.site.controls.bg_repeat_x', 'Across') },
        { value: 'repeat-y', label: t('cms_site.site.controls.bg_repeat_y', 'Down') },
    ];

    return (
        <div className="mt-2">
            <FieldRow label={t('cms_site.site.controls.bg_size', 'Size')}>
                <SegmentedControl
                    options={sizeOptions}
                    value={mode}
                    onChange={(m: SizeMode) => onChange({ backgroundSize: m === 'px' ? `${px ?? DEFAULT_PX}px` : m })}
                />
            </FieldRow>
            {mode === 'px' ? (
                <FieldRow label={t('cms_site.site.controls.bg_width', 'Width (px)')} hint={t('cms_site.site.controls.bg_width_hint', 'The image keeps its aspect ratio.')}>
                    <PxSizeInput
                        value={px}
                        min={BG_SIZE_PX_MIN}
                        max={BG_SIZE_PX_MAX}
                        ariaLabel={t('cms_site.site.controls.bg_width', 'Width (px)')}
                        onChange={(n: number) => onChange({ backgroundSize: cleanBackgroundSize(n) || `${DEFAULT_PX}px` })}
                    />
                </FieldRow>
            ) : null}
            <FieldRow label={t('cms_site.site.controls.bg_position', 'Position')}>
                <div role="radiogroup" aria-label={t('cms_site.site.controls.bg_position', 'Position')} className="inline-grid grid-cols-3 gap-1">
                    {(BG_POSITIONS as string[]).map((anchor) => {
                        const [key, fallback] = POSITION_LABELS[anchor];
                        const label = t(key, fallback);
                        const active = anchor === position;
                        return (
                            <button
                                key={anchor}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                aria-label={label}
                                title={label}
                                onClick={() => onChange({ backgroundPosition: anchor })}
                                className={`w-7 h-7 rounded border transition-colors ${active
                                    ? 'bg-[var(--accent-primary)] border-[var(--accent-primary)]'
                                    : 'bg-[var(--bg-tertiary)] border-[var(--border-default)] hover:border-[var(--accent-primary)]'}`}
                            />
                        );
                    })}
                </div>
            </FieldRow>
            <FieldRow label={t('cms_site.site.controls.bg_repeat', 'Repeat')}>
                <SegmentedControl options={repeatOptions} value={repeat} onChange={(r: string) => onChange({ backgroundRepeat: r })} />
            </FieldRow>
            <Toggle
                label={t('cms_site.site.controls.bg_hide_mobile', 'Hide on mobile')}
                value={value.backgroundHideMobile === true}
                onChange={(on: boolean) => onChange({ backgroundHideMobile: on })}
            />
        </div>
    );
}
