import { FieldRow, Toggle } from '../fields';
import { SegmentedControl } from '../primitives';
import type { SegmentedOption } from '../primitives.types';
import { useTranslation } from '../../../../hooks/useTranslation';

/** The motif keys of block.style (a missing key = no motif). */
export interface BlockMotif {
    motif?: string;
    motifSide?: string;
    motifTiles?: boolean;
}

export interface MotifControlProps {
    value: BlockMotif;
    onChange: (patch: BlockMotif) => void;
}

/**
 * MotifControl: switches on the built-in brand honeycomb for a block. It is
 * painted in the site's brand colours, so nothing is uploaded; side and the
 * filled tiles are the only knobs.
 */
export default function MotifControl({ value, onChange }: MotifControlProps) {
    const { t } = useTranslation();
    const on = value.motif === 'honeycomb';
    const side = value.motifSide === 'left' || value.motifSide === 'center' ? value.motifSide : 'right';
    const sideOptions: SegmentedOption<string>[] = [
        { value: 'left', label: t('cms_site.site.controls.motif_left', 'Left') },
        { value: 'center', label: t('cms_site.site.controls.motif_center', 'Center') },
        { value: 'right', label: t('cms_site.site.controls.motif_right', 'Right') },
    ];
    return (
        <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3">
            <Toggle
                label={t('cms_site.site.controls.motif_honeycomb', 'Brand honeycomb')}
                value={on}
                onChange={(next: boolean) => onChange({ motif: next ? 'honeycomb' : 'none' })}
            />
            <p className="text-[11px] text-[var(--text-muted)] mb-2 leading-relaxed">
                {t('cms_site.site.controls.motif_hint', 'A hexagon pattern in the brand colours behind this block. No image to upload.')}
            </p>
            {on ? (
                <>
                    <FieldRow label={t('cms_site.site.controls.motif_side', 'Side')}>
                        <SegmentedControl options={sideOptions} value={side} onChange={(s: string) => onChange({ motifSide: s })} />
                    </FieldRow>
                    <Toggle
                        label={t('cms_site.site.controls.motif_tiles', 'Filled tiles')}
                        value={value.motifTiles === true}
                        onChange={(next: boolean) => onChange({ motifTiles: next })}
                    />
                </>
            ) : null}
        </div>
    );
}
