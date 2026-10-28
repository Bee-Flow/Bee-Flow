import { AlertTriangle, Info } from 'lucide-react';
import { COUNTED_SECTIONS, countPhrase } from './solutionCounts';
import { useTranslation } from '@/hooks/useTranslation';
import type { SourceClaimProps, ContentsStepProps } from './installWizardSteps.types';
import { selectCls, selectStyle } from './AccessStep';

function SourceClaim({ source }: SourceClaimProps) {
    const { t } = useTranslation();
    const name = source?.orgName;
    if (!name) return null;
    return (
        <p className="flex items-start gap-2 px-3 py-2 rounded-lg text-[12px] bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
            data-testid="install-source-claim">
            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>
                {source.version
                    ? t('solutions.install_source_claim_version',
                        'This file says it was published by "{name}", version {version}.',
                        { name, version: source.version })
                    : t('solutions.install_source_claim',
                        'This file says it was published by "{name}".', { name })}
                {' '}
                {t('solutions.install_source_unverified',
                    'That is what the file says about itself — anyone who can edit the file can change it. Check with whoever sent it.')}
            </span>
        </p>
    );
}

export function ContentsStep({ read, name, onName }: ContentsStepProps) {
    const { t } = useTranslation();
    const kinds = COUNTED_SECTIONS.map(entry => entry.section).filter(section => read.counts[section] > 0);

    return (
        <div className="space-y-4">
            <SourceClaim source={read.source} />
            <label className="block">
                <span className="block text-xs mb-1 text-[var(--text-secondary)]">
                    {t('solutions.install_name', 'Name for this Solution')}
                </span>
                <input
                    value={name}
                    onChange={(e) => onName(e.target.value)}
                    aria-label={t('solutions.install_name', 'Name for this Solution')}
                    className={selectCls}
                    style={selectStyle}
                />
            </label>

            <div>
                <h3 className="text-sm font-medium mb-2 text-[var(--text-primary)]">
                    {t('solutions.install_contains', 'What it brings')}
                </h3>
                {kinds.length === 0 ? (
                    <p className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)]">
                        {t('solutions.install_nothing_in_it', 'This Blueprint carries nothing at all.')}
                    </p>
                ) : (
                    <ul className="flex flex-wrap gap-1.5" data-testid="install-contents">
                        {kinds.map(kind => (
                            <li key={kind} className="px-2.5 py-1 rounded-lg text-xs bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                                {countPhrase(t, kind, read.counts[kind])}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* The exporter's own honesty, forwarded. It is the most valuable
                thing on the export screen and worth exactly as much here. */}
            {read.notCarried.length > 0 && (
                <div>
                    <h3 className="text-sm font-medium mb-2 text-[var(--text-primary)]">
                        {t('projects.blueprint_left_behind', 'What this Blueprint does not carry')}
                    </h3>
                    <ul className="space-y-1" data-testid="install-not-carried">
                        {read.notCarried.map((w, i) => (
                            <li key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" />
                                {w}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
