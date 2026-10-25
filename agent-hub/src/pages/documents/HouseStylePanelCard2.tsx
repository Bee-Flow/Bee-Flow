import { TranslateParams } from '../../hooks/useTranslation';
import type { DeckOptions, ColourKey, HouseStyle, CardProps } from './HouseStylePanel.types';

const COLOUR_FIELDS: { key: ColourKey; labelKey: string; fallback: string; varName: string }[] = [
    { key: 'accent', labelKey: 'documents.style.accent', fallback: 'Accent', varName: '--doc-accent' },
    { key: 'ink', labelKey: 'documents.style.ink', fallback: 'Text', varName: '--doc-ink' },
    { key: 'muted', labelKey: 'documents.style.muted', fallback: 'Muted text', varName: '--doc-muted' },
];

export function HouseStylePanelCard2({ t, style, disabled, set, meta }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; style: HouseStyle; disabled: boolean; set: (key: string, value: boolean | string | number) => void; meta: { editable: boolean; hasOrg: boolean; fonts: string[]; maxLogoBytes: number; deck: DeckOptions; }; }) {
    return <Card title={t('documents.style.look', 'Colours and type')}>
        <p className="text-sm mb-3 text-[var(--text-muted)]">
            {t('documents.style.look_hint', 'The assistant writes these as variables, so changing one restyles every document that uses the house style — including ones written months ago.')}
        </p>
        <div className="flex flex-wrap gap-4">
            {COLOUR_FIELDS.map((f) => (
                <label key={f.key} className="text-xs text-[var(--text-muted)]">
                    {t(f.labelKey, f.fallback)}
                    <span className="block font-mono text-[10px] mb-1 text-[var(--text-tertiary)]">
                        {f.varName}
                    </span>
                    <span className="flex items-center gap-2">
                        <input
                            type="color"
                            value={style[f.key]}
                            disabled={disabled}
                            onChange={(e) => set(f.key, e.target.value)}
                            className="w-9 h-9 rounded cursor-pointer"
                            aria-label={t(f.labelKey, f.fallback)} />
                        <input
                            type="text"
                            value={style[f.key]}
                            disabled={disabled}
                            onChange={(e) => set(f.key, e.target.value)}
                            className="w-24 px-2 py-1 rounded text-sm font-mono [background:var(--bg-tertiary)] [color:var(--text-primary)]! [border:1px_solid_var(--border-subtle)]" />
                    </span>
                </label>
            ))}
            <label className="text-xs text-[var(--text-muted)]">
                {t('documents.style.font', 'Typeface')}
                <span className="block font-mono text-[10px] mb-1 text-[var(--text-tertiary)]">--doc-font</span>
                <select
                    value={style.font}
                    disabled={disabled}
                    onChange={(e) => set('font', e.target.value)}
                    className="px-2 py-2 rounded text-sm [background:var(--bg-tertiary)] [color:var(--text-primary)]! [border:1px_solid_var(--border-subtle)]"
                >
                    {meta.fonts.map((f) => (
                        <option key={f} value={f}>{t(`documents.style.font_${f}`, f)}</option>
                    ))}
                </select>
            </label>
        </div>
    </Card>;
}

export function Card({ title, children }: CardProps) {
    return (
        <section
            className="rounded-xl p-5 mb-4 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]"
        >
            {title && (
                <h2 className="text-sm font-semibold mb-3 text-[var(--text-primary)]">{title}</h2>
            )}
            {children}
        </section>
    );
}
