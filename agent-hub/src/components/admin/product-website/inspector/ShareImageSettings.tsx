import { useTranslation } from '@/hooks/useTranslation';

type ShareImageTemplate = 'light' | 'dark' | 'brand';

export interface ShareImageDesign {
    template: ShareImageTemplate;
    motif: boolean;
}

const TEMPLATES: ShareImageTemplate[] = ['light', 'dark', 'brand'];

/** What the server stores (design.shareImage), with the same defaults as sanitizeDesign. */
export function readShareImage(design: object): ShareImageDesign {
    const raw = 'shareImage' in design ? design.shareImage : undefined;
    const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const template = TEMPLATES.find(t => t === src.template) ?? 'light';
    return { template, motif: src.motif !== false };
}

interface ShareImageSettingsProps<D extends object> {
    design: D;
    onChange: (design: D) => void;
}

/**
 * Card style of the generated share image: pages without their own og:image get
 * a 1200x630 card from the page title and the brand colours (server/core/seo/ogCard.js).
 * Lives in the Design inspector; saved with the rest of the design.
 */
export default function ShareImageSettings<D extends object>({ design, onChange }: ShareImageSettingsProps<D>) {
    const { t } = useTranslation();
    const current = readShareImage(design);
    const set = (next: Partial<ShareImageDesign>) => onChange({ ...design, shareImage: { ...current, ...next } });
    const label: Record<ShareImageTemplate, string> = {
        light: t('cms_share.template_light', 'Light'),
        dark: t('cms_share.template_dark', 'Dark'),
        brand: t('cms_share.template_brand', 'Brand colour'),
    };

    return (
        <section className="shrink-0 border-t border-[var(--border-subtle)] p-3 flex flex-col gap-2 text-[var(--text-primary)]">
            <h4 className="text-xs font-semibold">{t('cms_share.title', 'Share image')}</h4>
            <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                {t('cms_share.help', 'Pages without their own share image get a card made from the page title and your brand colours.')}
            </p>
            <label className="flex flex-col gap-0.5">
                <span className="text-[10px] text-[var(--text-muted)]">{t('cms_share.template', 'Card style')}</span>
                <select
                    className="w-full px-2 py-1 rounded text-xs border bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-[var(--border-default)]"
                    value={current.template}
                    onChange={e => set({ template: TEMPLATES.find(x => x === e.target.value) ?? 'light' })}
                >
                    {TEMPLATES.map(id => <option key={id} value={id}>{label[id]}</option>)}
                </select>
            </label>
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                <input type="checkbox" checked={current.motif} onChange={e => set({ motif: e.target.checked })} />
                {t('cms_share.motif', 'Honeycomb pattern')}
            </label>
        </section>
    );
}
