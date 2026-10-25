import { AlertTriangle, Info } from 'lucide-react';
import type { BlockerListProps, IssuePanelProps, IssueRowProps } from './PublishModal.types';
import useTranslation from '../../../../../hooks/useTranslation';

/**
 * `context` distinguishes the two ways this list appears. A refused publish
 * has to say what happened to the readers; a check the author asked for has
 * not changed anything, so saying so would be noise — and it may have no
 * errors at all, only things worth a look.
 */
export function BlockerList({ errors, warnings, revealTarget, onReveal, context = 'publish' }: BlockerListProps) {
    const { t } = useTranslation();
    const isCheck = context === 'check';
    // Four headings, not two halves of one: "{n} things ${isCheck ? 'are
    // broken' : 'to fix'}" glues an English predicate onto a count, which no
    // translation can take apart. Singular and plural are a key each (§2.1),
    // and both carry {n} so the count sits where the language wants it.
    const errorTitle = isCheck
        ? (errors.length === 1
            ? t('app_studio.publish.check_errors_title', '{n} thing is broken', { n: errors.length })
            : t('app_studio.publish.check_errors_title_plural', '{n} things are broken', { n: errors.length }))
        : (errors.length === 1
            ? t('app_studio.publish.errors_title', '{n} thing to fix before publishing', { n: errors.length })
            : t('app_studio.publish.errors_title_plural', '{n} things to fix before publishing', { n: errors.length }));
    return (
        <div className="space-y-3">
            {errors.length > 0 ? (
                <IssuePanel
                    issues={errors}
                    icon={<AlertTriangle className="h-4 w-4 shrink-0 [color:#b45309]" aria-hidden="true" />}
                    title={errorTitle}
                    note={isCheck
                        ? t('app_studio.publish.check_errors_note', 'These stop the app working for the people you share it with.')
                        : t('app_studio.publish.errors_note', 'Nothing changed for your readers — they still see the version you published last.')}
                    panelStyle={{ borderColor: '#b45309', background: 'color-mix(in srgb, #b45309 8%, transparent)' }}
                    revealTarget={revealTarget}
                    onReveal={onReveal}
                />
            ) : null}
            {warnings.length > 0 ? (
                <IssuePanel
                    issues={warnings}
                    icon={<Info className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />}
                    title={warnings.length === 1
                        ? t('app_studio.publish.warnings_title', '{n} thing worth a look', { n: warnings.length })
                        : t('app_studio.publish.warnings_title_plural', '{n} things worth a look', { n: warnings.length })}
                    note={t('app_studio.publish.warnings_note', 'These do not stop you publishing.')}
                    panelStyle={{ borderColor: 'var(--border-subtle)' }}
                    revealTarget={revealTarget}
                    onReveal={onReveal}
                />
            ) : null}
        </div>
    );
}

function IssuePanel({ issues, icon, title, note, panelStyle, revealTarget, onReveal }: IssuePanelProps) {
    return (
        <div className="rounded-lg border p-3" style={panelStyle}>
            <div className="flex items-center gap-2">
                {icon}
                <strong className="text-sm text-[var(--text-primary)]">{title}</strong>
            </div>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">{note}</p>
            <ul className="mt-2.5 space-y-2">
                {issues.map((issue, i) => (
                    <IssueRow
                        key={`${issue.code || 'issue'}-${issue.path || i}`}
                        issue={issue}
                        target={revealTarget(issue)}
                        onReveal={onReveal}
                    />
                ))}
            </ul>
        </div>
    );
}

function IssueRow({ issue, target, onReveal }: IssueRowProps) {
    const { t } = useTranslation();
    // The save-notices panel's own button, same words and the same job
    // (SaveStatusPill) — one key, not two.
    const showMe = t('app_studio.header.show_me', 'Show me');
    return (
        <li className="text-xs">
            <span className="block text-[var(--text-primary)]">{issue.message}</span>
            {issue.hint ? (
                <span className="mt-0.5 block text-[var(--text-tertiary)]">{issue.hint}</span>
            ) : null}
            {target ? (
                <span className="mt-1 flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => onReveal(target)}
                        className="rounded-md bg-white/5 px-2 py-1 font-medium hover:bg-[var(--bg-card-hover)] text-[var(--accent-primary)]"
                    >
                        {showMe}
                    </button>
                    {target.screenName ? (
                        <span className="text-[var(--text-tertiary)]">
                            {t('app_studio.publish.on_screen', 'on “{screen}”', { screen: target.screenName })}
                        </span>
                    ) : null}
                </span>
            ) : null}
        </li>
    );
}
