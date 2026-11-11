import { ExternalLink } from 'lucide-react';
import AppIcon from '@/components/icons/AppIcon';
import useTranslation from '@/hooks/useTranslation';
import type { ShellItem } from './shellOptions';
import type { NavigateFn } from '../actionRunner/runnerContext';

/**
 * The app's own links (nav.items, schema 3, shellOptions.ts) in the three places a shell lists
 * screens: the top bar, the sidebar and the phone menu. A screen of the app is a nav button; an
 * address (http or https, checked again in shellOptions.ts) is a plain link that opens a new
 * tab with rel="noopener noreferrer", so the other site gets neither this page nor its address.
 */

interface LinksProps {
    items: ShellItem[];
    screenId?: string | null;
    onNavigate: NavigateFn | null;
    /** bar: a row in the top bar (desktop); list: sidebar rows; drawer: rows of the phone menu. */
    variant: 'bar' | 'list' | 'drawer';
    onPicked?: () => void;
}

const VARIANT_CLASS: Record<LinksProps['variant'], string> = {
    bar: 'hidden sm:flex items-center gap-1 shrink-0',
    list: 'flex flex-col gap-0.5 pt-2 mt-1 border-t [border-color:var(--border-subtle)]!',
    drawer: 'flex flex-col gap-0.5 pt-2 mt-1 border-t [border-color:var(--border-subtle)]!',
};

const ITEM_CLASS: Record<LinksProps['variant'], string> = {
    bar: 'app-nav-item flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium whitespace-nowrap',
    list: 'app-nav-item flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-left',
    drawer: 'app-nav-item flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-left',
};

export default function NavLinks({ items, screenId, onNavigate, variant, onPicked }: LinksProps) {
    const { t } = useTranslation();
    if (!items.length) return null;
    const cls = ITEM_CLASS[variant];
    const icon = (item: ShellItem) => (item.icon ? <AppIcon name={item.icon} className="w-4 h-4 shrink-0" /> : null);
    return (
        <div className={VARIANT_CLASS[variant]} data-app-nav-links={variant}>
            {items.map((item) => {
                if (item.url) {
                    return (
                        <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer" className={cls} data-app-nav-link={item.id}>
                            {icon(item)}
                            <span className="app-nav-item-label truncate">{item.label}</span>
                            <ExternalLink className="w-3 h-3 shrink-0 opacity-60" aria-label={t('studio_apps_lk18.opens_new_tab', 'Opens in a new tab')} />
                        </a>
                    );
                }
                const isActive = item.screenId === screenId;
                return (
                    <button
                        key={item.id}
                        type="button"
                        className={cls}
                        aria-current={isActive ? 'page' : undefined}
                        data-active={isActive || undefined}
                        data-app-nav-link={item.id}
                        onClick={() => { onPicked?.(); if (onNavigate && item.screenId) onNavigate(item.screenId); }}
                    >
                        {icon(item)}
                        <span className="app-nav-item-label truncate">{item.label}</span>
                    </button>
                );
            })}
        </div>
    );
}
