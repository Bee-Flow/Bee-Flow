import { Workflow } from 'lucide-react';
import { kindColorVar } from '@/components/shared/kindColors';
import { PRIMARY_ACTION_STYLE } from '@/components/shared/StudioSectionHeader';
import useRelativeTime from '@/hooks/useRelativeTime';
import type { SignpostProps } from './AddSourcePanel.types';

/**
 * The automation card's panel. An explanation and a door, not a form.
 *
 * Why a whole panel rather than a tooltip: the relationship is genuinely
 * backwards from every other card here, and a person who has just been told
 * "you cannot add this one" needs to know what to do INSTEAD, in the same
 * breath. Two sentences and a link is the shortest thing that does that.
 *
 * The link goes to the automations builder rather than deep-linking a
 * pre-configured step: which automation should write here is the interesting
 * decision, and pre-answering it with a new empty automation would be a guess
 * most of the time — the usual case is an automation that already exists.
 */
export default function AutomationSignpost({ t, kbName = '', onNavigate = null, sources = [] }: SignpostProps) {
    // The same relative-time hook the Sources list itself uses, so the two
    // never disagree about when a source last ran.
    const rel = useRelativeTime();
    const automationSources = (Array.isArray(sources) ? sources : []).filter(s => s.kind === 'automation');
    return (
        <div className="space-y-2.5" data-testid="kb-signpost-automation">
            <p className="text-[var(--text-secondary)]">
                {t('knowledge.automation_signpost.what',
                    'An automation adds itself here. Give any automation the “To knowledge base” step, point that step at {name}, and it appears in this list the moment the automation is saved.',
                    { name: kbName || t('knowledge.automation_signpost.this_base', 'this knowledge base') })}
            </p>
            <p className="text-[var(--text-tertiary)]">
                {t('knowledge.automation_signpost.why',
                    'Whatever it writes becomes an answer your agents give, with a citation — so send it finished text, not working notes.')}
            </p>
            {automationSources.length > 0 && (
                /**
                 * The other half of what this card is for: which automations are
                 * ALREADY feeding this base, and when each last did. Without it
                 * the card explains a mechanism while staying silent about the
                 * instances of it sitting in the list right below.
                 */
                <div className="rounded-[10px] overflow-hidden [border:1px_solid_var(--border-default)]">
                    {automationSources.map((src, i) => (
                        <div
                            key={src.id}
                            data-testid="kb-signpost-automation-source"
                            className="flex items-center gap-2 px-2.5 py-2"
                            style={i ? { borderTop: '1px solid var(--border-default)' } : undefined}
                        >
                            <Workflow className="w-3.5 h-3.5 shrink-0" style={{ color: kindColorVar('automation') }} aria-hidden="true" />
                            <span className="truncate text-[var(--text-primary)]">{src.name}</span>
                            <span className="ml-auto shrink-0 text-[var(--text-tertiary)]">
                                {t('knowledge.automation_signpost.feeds', 'passes data through')}
                                {' · '}
                                {rel(src.lastRefreshAt)
                                    ? t('knowledge.automation_signpost.last_run', 'last run {when}', { when: rel(src.lastRefreshAt) })
                                    : t('knowledge.automation_signpost.no_run_yet', 'no run yet')}
                            </span>
                        </div>
                    ))}
                </div>
            )}
            <a
                href="/app/studio/automations"
                data-testid="kb-signpost-automation-link"
                onClick={(e) => {
                    // In-SPA when it can be: a raw href full-reloads the app and
                    // loses the reader's place in the studio. The href stays for
                    // middle-click and for "open in new tab".
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || !onNavigate) return;
                    e.preventDefault();
                    onNavigate('studio/automations');
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
            >
                {t('knowledge.automation_signpost.go', 'Open Automations')}
            </a>
        </div>
    );
}

