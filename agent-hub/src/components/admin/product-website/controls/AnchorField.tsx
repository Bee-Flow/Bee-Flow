import { FieldRow } from '../fields';
import { useTranslation } from '../../../../hooks/useTranslation';
import { ANCHOR_MAX } from '../../../../marketing/blockStyleEnums.generated.mjs';

/**
 * Types toward a legal anchor slug: lowercase, spaces and underscores become
 * hyphens, anything else is dropped. `final` also trims hyphens from the ends,
 * which would make the slug illegal (they are fine while the user is typing).
 */
export function slugifyAnchor(raw: string, final = false): string {
    const slug = raw
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-{2,}/g, '-')
        .replace(/^[^a-z]+/, '')
        .slice(0, ANCHOR_MAX);
    return final ? slug.replace(/-+$/, '') : slug;
}

export interface AnchorFieldProps {
    value: string | undefined;
    onChange: (anchor: string) => void;
}

/** The block's anchor id: the section's `id`, so a link can jump to it (`/page#install`). */
export default function AnchorField({ value, onChange }: AnchorFieldProps) {
    const { t } = useTranslation();
    return (
        <FieldRow
            label={t('cms_site.site.blockstyle.anchor', 'Anchor id')}
            hint={t('cms_site.site.blockstyle.anchor_hint', 'Lets a link jump to this block: link to /page#install, or choose an anchor link. Lowercase letters, digits and hyphens; unique on the page.')}
        >
            <input
                type="text"
                value={value || ''}
                onChange={(e) => onChange(slugifyAnchor(e.target.value))}
                onBlur={(e) => onChange(slugifyAnchor(e.target.value, true))}
                placeholder={t('cms_site.site.blockstyle.anchor_placeholder', 'install')}
                maxLength={ANCHOR_MAX}
                spellCheck={false}
                className="w-full px-2 py-1.5 rounded text-xs font-mono border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
        </FieldRow>
    );
}
