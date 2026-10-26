import React from 'react';
import Disclosure from '@/components/shared/Disclosure';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import Slider from '@/components/shared/Slider';
import { SECTION_IDS } from '../useLookForm';
import type { LookForm, LookSectionProps } from '../useLookForm';
import type { GlassTier } from '@/components/appearance/ThemeContext.types';

import { useTranslation } from '@/hooks/useTranslation';

type TierKey = 'subtle' | 'default' | 'opaque';
type TierFormKey = 'glassTierSubtle' | 'glassTierDefault' | 'glassTierOpaque';

const TIER_DEFAULTS: Record<TierKey, GlassTier> = {
    subtle:  { blur: 10, saturate: 170, brightness: 1.05 },
    default: { blur: 16, saturate: 170, brightness: 1.05 },
    opaque:  { blur: 60, saturate: 220, brightness: 1.05 },
};

const TIER_LABELS: Record<TierKey, string> = {
    subtle:  'Subtle — sidebar, chrome',
    default: 'Default — cards, panels',
    opaque:  'Opaque — modals, popovers',
};

/**
 * AdvancedGlassDisclosure — collapsed drawer holding the rarely-used glass
 * knobs (animation, grain, border style) and the per-tier blur/saturate/
 * brightness overrides. Kept out of the main scroll so the editor stays
 * approachable; power users open it when they need to dig in.
 */
export default function AdvancedGlassDisclosure({ form, setForm, saving }: LookSectionProps) {
    const { t } = useTranslation();
    return (
        <section
            id={SECTION_IDS.advanced}
            aria-labelledby={`${SECTION_IDS.advanced}-heading`}
        >
            <Disclosure
                title={t('appearance.advanced_glass_disclosure_advanced_glass_options', 'Advanced glass options')}
                hint="Animation, grain, border style, per-tier overrides"
                variant="card"
            >
                <div className="space-y-5 pt-2">
                    <FormField
                        label="Animation"
                        hint="Subtle: wallpaper drifts. Lively: adds a sweeping specular sheen."
                    >
                        <SegmentedControl
                            value={form.glassAnimation}
                            onChange={(v: string) => setForm((f: LookForm | null) => ({ ...(f as LookForm), glassAnimation: v }))}
                            options={[
                                { value: 'off',    label: 'Off' },
                                { value: 'subtle', label: 'Subtle' },
                                { value: 'lively', label: 'Lively' },
                            ]}
                            disabled={saving}
                            ariaLabel="Glass animation"
                        />
                    </FormField>

                    <FormField
                        label="Grain"
                        hint="Adds a fractal-noise texture so glass reads as real frosted material."
                    >
                        <SegmentedControl
                            value={form.glassGrain}
                            onChange={(v: string) => setForm((f: LookForm | null) => ({ ...(f as LookForm), glassGrain: v }))}
                            options={[
                                { value: 'off',     label: 'Off' },
                                { value: 'subtle',  label: 'Subtle' },
                                { value: 'frosted', label: 'Frosted' },
                            ]}
                            disabled={saving}
                            ariaLabel="Glass grain"
                        />
                    </FormField>

                    <FormField
                        label="Border"
                        hint="Thin specular ring on each glass surface. Iridescent uses a rainbow gradient."
                    >
                        <SegmentedControl
                            value={form.glassBorder}
                            onChange={(v: string) => setForm((f: LookForm | null) => ({ ...(f as LookForm), glassBorder: v }))}
                            options={[
                                { value: 'none',       label: 'None' },
                                { value: 'subtle',     label: 'Subtle' },
                                { value: 'bright',     label: 'Bright' },
                                { value: 'iridescent', label: 'Iridescent' },
                            ]}
                            disabled={saving}
                            ariaLabel="Glass border"
                        />
                    </FormField>

                    <div
                        className="rounded-xl border p-4 space-y-4 [border-color:var(--border-subtle)] [background:var(--bg-tertiary)]"
                        data-surface="default"
                    >
                        <div>
                            <h4 className="text-sm font-medium text-[var(--text-primary)]">
                                {t('appearance.advanced_glass_disclosure_per_tier_overrides', 'Per-tier overrides')}
                            </h4>
                            <p className="text-[11px] mt-0.5 text-[var(--text-muted)]">
                                {t('appearance.advanced_glass_disclosure_override_the_intensity_derived_blur', 'Override the intensity-derived blur / saturate / brightness for each tier individually. Leave a tier off to keep the default.')}
                            </p>
                        </div>
                        {Object.keys(TIER_DEFAULTS).map((tierKey: string) => (
                            <TierEditor
                                key={tierKey}
                                tierKey={tierKey as TierKey}
                                value={form[`glassTier${capitalize(tierKey)}` as TierFormKey]}
                                onChange={(v: GlassTier | null) => setForm((f: LookForm | null) => ({ ...(f as LookForm), [`glassTier${capitalize(tierKey)}`]: v }))}
                                disabled={saving}
                            />
                        ))}
                    </div>
                </div>
            </Disclosure>
        </section>
    );
}

interface TierEditorProps {
    tierKey: TierKey;
    value: GlassTier | null;
    onChange: (value: GlassTier | null) => void;
    disabled: boolean;
}

function TierEditor({ tierKey, value, onChange, disabled }: TierEditorProps) {
    const enabled = !!value;
    const v = value || TIER_DEFAULTS[tierKey];
    return (
        <div>
            <label className="flex items-center gap-2 mb-2 cursor-pointer">
                <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.checked ? TIER_DEFAULTS[tierKey] : null)}
                    className="[accent-color:var(--accent-primary)]"
                    disabled={disabled}
                />
                <span className="text-sm font-medium text-[var(--text-primary)]">
                    {TIER_LABELS[tierKey]}
                </span>
            </label>
            {enabled && (
                <div className="ml-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <Slider
                        label="Blur"
                        min={0} max={60} step={1}
                        suffix="px"
                        value={v.blur}
                        onChange={(n: number) => onChange({ ...v, blur: n })}
                        disabled={disabled}
                    />
                    <Slider
                        label="Saturate"
                        min={100} max={300} step={5}
                        suffix="%"
                        value={v.saturate}
                        onChange={(n: number) => onChange({ ...v, saturate: n })}
                        disabled={disabled}
                    />
                    <Slider
                        label="Brightness"
                        min={0.8} max={1.3} step={0.01}
                        suffix="×"
                        value={v.brightness}
                        onChange={(n: number) => onChange({ ...v, brightness: n })}
                        disabled={disabled}
                    />
                </div>
            )}
        </div>
    );
}

function capitalize(s: string) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
