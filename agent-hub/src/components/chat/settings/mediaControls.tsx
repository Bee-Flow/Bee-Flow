import React from 'react';

/**
 * Shared, accent-driven controls for the chat-composer media-generation
 * settings popovers (ElevenLabs / MusicGen / VideoGen / …). Each was
 * re-declared verbatim per panel with only the accent colour changing; pass
 * `accent` (a CSS colour string) instead.
 */

interface SliderProps {
    label: string;
    value?: number | null;
    min: number;
    max: number;
    step: number;
    defaultVal: number;
    unit?: string;
    onChange: (value: number) => void;
    accent: string;
}

interface ToggleProps {
    label: string;
    desc?: string;
    value: boolean;
    onChange: (value: boolean) => void;
    accent: string;
}

interface PillProps {
    label: string;
    selected: boolean;
    onClick: () => void;
    accent: string;
}

interface PillSelectProps {
    label?: string;
    options: Array<string | { value: string; label: string }>;
    value: string;
    onChange: (value: string) => void;
    accent: string;
}

export const Slider = ({ label, value, min, max, step, defaultVal, unit, onChange, accent }: SliderProps) => {
    const v = value ?? defaultVal;
    const pct = ((v - min) / (max - min)) * 100;
    return (
        <div>
            <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</label>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                    {v}{unit || ''}
                </span>
            </div>
            <input type="range" min={min} max={max} step={step} value={v} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(parseFloat(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                style={{ accentColor: accent, background: `linear-gradient(to right, ${accent} ${pct}%, var(--border-subtle) ${pct}%)` }}
            />
            <div className="flex justify-between text-[9px] mt-0.5 text-[var(--text-muted)]">
                <span>{min}{unit || ''}</span><span>{max}{unit || ''}</span>
            </div>
        </div>
    );
};

export const Toggle = ({ label, desc, value, onChange, accent }: ToggleProps) => (
    <div className="flex items-center justify-between py-0.5">
        <div>
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</span>
            {desc && <p className="text-[9px] text-[var(--text-muted)]">{desc}</p>}
        </div>
        <button onClick={() => onChange(!value)}
            className="w-8 h-[18px] rounded-full transition-all relative flex-shrink-0"
            style={{ background: value ? accent : 'var(--border-subtle)' }}>
            <div className="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all shadow-sm"
                 style={{ left: value ? '15px' : '2px' }} />
        </button>
    </div>
);

const Pill = ({ label, selected, onClick, accent }: PillProps) => (
    <button onClick={onClick}
        className="px-2.5 py-1 rounded-md text-[10px] font-medium transition-all"
        style={{
            background: selected ? `color-mix(in srgb, ${accent} 15%, transparent)` : 'var(--bg-tertiary)',
            color: selected ? accent : 'var(--text-tertiary)',
            border: `1px solid ${selected ? `color-mix(in srgb, ${accent} 30%, transparent)` : 'var(--border-subtle)'}`,
        }}>
        {label}
    </button>
);

/** A row of mutually-exclusive Pills bound to one value. */
export const PillSelect = ({ label, options, value, onChange, accent }: PillSelectProps) => (
    <div>
        {label && <label className="block text-[11px] font-medium mb-1.5 text-[var(--text-secondary)]">{label}</label>}
        <div className="flex gap-1 flex-wrap">
            {options.map(opt => {
                const val = typeof opt === 'string' ? opt : opt.value;
                const lbl = typeof opt === 'string' ? opt : opt.label;
                return <Pill key={val} label={lbl} selected={value === val} onClick={() => onChange(val)} accent={accent} />;
            })}
        </div>
    </div>
);
