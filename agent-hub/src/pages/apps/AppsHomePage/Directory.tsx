import { ChevronRight } from 'lucide-react';
import AppIcon from '@/components/icons/AppIcon';
import useTranslation from '@/hooks/useTranslation';
import type { AppCardProps, SectionLabelProps, DirectoryProps } from '../AppsHomePage.types';
import { CATEGORY_LABELS, CARD_CLASSES, CARD_STYLE, GRID_CLASSES, DESC_CLASSES } from './AppsHomePage.constants';
import { accentTile, appCategory, isNewlyPublished } from './AppsHomePage.helpers';

function AppCard({ app, now }: AppCardProps) {
    const { t } = useTranslation();
    const category = appCategory(app);
    return (
        <a href={`/app/apps/${app.id}`} className={CARD_CLASSES} style={CARD_STYLE}>
            <div className="flex items-start gap-2.5">
                <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
                    style={accentTile(app.accentColor)}
                >
                    <AppIcon name={app.icon || 'LayoutGrid'} className="w-4 h-4" />
                </span>
                <div className="flex-1 min-w-0 pt-0.5 flex items-start gap-2">
                    <div className="text-sm font-semibold truncate flex-1 min-w-0 text-[var(--text-primary)]">
                        {app.name || t('apps.untitled', 'Untitled app')}
                    </div>
                    {isNewlyPublished(app, now) && (
                        <span
                            className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium leading-none mt-0.5 bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                        >
                            {t('apps.new_badge', 'new')}
                        </span>
                    )}
                </div>
            </div>
            <div className={DESC_CLASSES} style={{ color: 'var(--text-secondary)' }}>
                {app.description || ''}
            </div>
            {/* The footer is PERMANENT, not a hover reveal: "Open" is the one
                thing every card promises, and a promise that appears only
                under a mouse is invisible on a phone and to a keyboard. */}
            <div
                className="mt-2 pt-2 border-t flex items-center gap-2 text-[11px] border-[var(--border-subtle)] text-[var(--text-tertiary)]"
            >
                <span className="truncate min-w-0">{category ? CATEGORY_LABELS[category](t) : ''}</span>
                <span className="ml-auto inline-flex items-center gap-0.5 shrink-0 font-medium">
                    {t('apps.open', 'Open')}
                    <ChevronRight className="w-3 h-3" aria-hidden="true" />
                </span>
            </div>
        </a>
    );
}

function SectionLabel({ children }: SectionLabelProps) {
    return (
        <h2
            className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]"
        >
            {children}
        </h2>
    );
}

export function Directory({ recentlyUsed, apps, now, noMatches }: DirectoryProps) {
    const { t } = useTranslation();
    const hasRecents = recentlyUsed.length > 0;
    return (
        <>
            {hasRecents && (
                <section data-testid="apps-recent" className="mb-5">
                    <div className="mb-2">
                        <SectionLabel>{t('apps.recently_used', 'Recently used')}</SectionLabel>
                    </div>
                    <div className={GRID_CLASSES}>
                        {recentlyUsed.map((app) => (
                            <AppCard key={app.id} app={app} now={now} />
                        ))}
                    </div>
                </section>
            )}
            {/* Every app stays in this grid, recent ones included:
                the shortcut above is a shortcut, not a filter that
                moves an app out of the place you look for it. */}
            <section data-testid="apps-all">
                {(hasRecents || apps.length > 1) && (
                    <div className="mb-2 flex items-baseline gap-3">
                        {hasRecents && (
                            <SectionLabel>{t('apps.all_apps', 'All apps')}</SectionLabel>
                        )}
                        {apps.length > 1 && (
                            <span
                                className="ml-auto text-[10px] text-[var(--text-tertiary)]"
                            >
                                {t('apps.sorted_by_name', 'Sorted by name')}
                            </span>
                        )}
                    </div>
                )}
                {noMatches ? (
                    <p className="text-xs text-[var(--text-secondary)]">
                        {t('apps.no_matches', 'No apps match your search.')}
                    </p>
                ) : (
                    <div className={GRID_CLASSES}>
                        {apps.map((app) => <AppCard key={app.id} app={app} now={now} />)}
                    </div>
                )}
            </section>
            {/* The footnote. Two sentences a first-time reader
                needs and a returning one never reads again, so it
                sits at the BOTTOM in a dashed box: present, and
                never in the way of the grid. */}
            <p
                className="mt-6 rounded-[9px] border border-dashed px-[14px] py-[11px] text-[11.5px] leading-[17px] border-[var(--border-subtle)] text-[var(--text-tertiary)]"
            >
                {t(
                    'apps.footnote',
                    'An app is a small tool someone in your organization built in App Studio — a form to fill in, a lookup, a job you would otherwise do by hand. You only see the apps that have been released to your group.',
                )}
            </p>
        </>
    );
}
