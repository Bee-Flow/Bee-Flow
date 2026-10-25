import { Globe, Loader2 } from 'lucide-react';
import { Card, Chip } from './WebpageDataCards';
import type { AudienceModel, PublicAiNotesProps, PublicRowProps } from './WebpageAudiencePanel.types';

/**
 * The public AI bridge, three-valued — the third property of the public surface, and the only one that is a SWITCH.
 *
 * `aiKnown !== true` means NOT READ, not "off": if that counted as off, the screen would claim "no AI runs publicly" about a field that nobody looked at — the same dangerous direction that `public.known` excludes above. Therefore `runs` hangs on `known` and `grounds` on `runs`: every claim here stands on the reading beneath it.
 */
function publicAiState(model: AudienceModel | null | undefined) {
    const known = model?.public?.aiKnown === true;
    const runs = known && model?.public?.aiRuns === true;
    return { known, runs, grounds: runs && model?.public?.aiGroundsOnPage === true };
}

function PublicAiNotes({ t, ai }: PublicAiNotesProps) {
    const warn = { color: 'var(--warning)' };
    return (
        <>
            <li data-testid="public-ai" style={ai.known && !ai.runs ? undefined : warn}>
                {!ai.known
                    ? t('webpages.audience.public_ai_unknown',
                        'Whether outside readers can use the AI on this page could not be read, so nothing is claimed about it here.')
                    : ai.runs
                        ? t('webpages.audience.public_ai_on',
                            'Anyone with the address can chat with the AI on this page, and every answer is charged to your AI budget.')
                        : t('webpages.audience.public_ai_off',
                            'Outside readers cannot use the AI on this page, so a public reader can never spend your AI budget.')}
            </li>
            {ai.grounds && (
                <li data-testid="public-ai-grounded" style={warn}>
                    {t('webpages.audience.public_ai_grounded',
                        'Those answers are grounded on this page\'s knowledge, so its sources can reach outside readers without passing the column choice above.')}
                </li>
            )}
            {ai.runs && (
                <li data-testid="public-ai-change">
                    {t('webpages.audience.public_ai_change',
                        'This switch is not on this screen: ask this page\'s AI chat to turn public AI off.')}
                </li>
            )}
        </>
    );
}

export function PublicRow({ t, model, busy, onOpen, onTurnOff, disabled }: PublicRowProps) {
    const on = !!model?.public?.on;
    // Three-valued, just like `agent.known` in the column beside it: if the share
    // could not be read, "Off" is a claim about exposure that we cannot make good.
    // Then the row says so, and there is nothing to switch — switching an unknown
    // state on or off is worse than waiting.
    const known = model?.public?.known !== false;
    const ai = publicAiState(model);
    return (
        <Card tone={known ? 'default' : 'warning'}>
            <div className="flex items-center gap-2 flex-wrap">
                <Globe size={14} className="[color:var(--kind-web)]" />
                <span className="text-sm font-medium">{t('webpages.visibility.public', 'Public')}</span>
                {!known
                    ? <Chip label={t('webpages.audience.public_unknown', 'Could not be checked')} tone="muted" dashed />
                    : on
                        ? <Chip label={t('webpages.audience.public_on', 'Anyone with the address')} tone="public" />
                        : <Chip label={t('common.off', 'Off')} tone="muted" dashed />}
                <span className="flex-1" />
                {known && on && (
                    <button
                        type="button"
                        data-testid="public-columns"
                        disabled={disabled || busy}
                        onClick={onOpen}
                        className="text-xs underline disabled:opacity-50"
                    >
                        {t('webpages.audience.change_columns', 'Change what goes out')}
                    </button>
                )}
                {known && (
                    <button
                        type="button"
                        data-testid="public-toggle"
                        disabled={disabled || busy}
                        onClick={on ? onTurnOff : onOpen}
                        className="text-xs underline disabled:opacity-50 inline-flex items-center gap-1"
                    >
                        {busy && <Loader2 size={12} className="animate-spin" />}
                        {on
                            ? t('webpages.audience.turn_off', 'Turn off')
                            : t('webpages.audience.turn_on', 'Make public')}
                    </button>
                )}
            </div>
            {!known && (
                <p className="text-sm">
                    {t('webpages.audience.public_unknown_body',
                        'Whether this page is public right now could not be read, so nothing is claimed here and nothing can be changed until it can.')}
                </p>
            )}
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('webpages.audience.public_body',
                    'A public page is a snapshot without scripts, not the live page. It updates when you save, and when a table it shows changes.')}
            </p>
            <ul className="text-[11px] list-disc pl-4 text-[var(--text-secondary)]">
                <li>{t('webpages.audience.public_tables_read_only',
                    'Table blocks are read-only here. Writing back to a table is only possible for Personal, Entire organisation and Groups.')}</li>
                {/* The tail of this sentence ("stays empty") is precisely FALSE as soon as public
                    AI is on: the Agent block indeed does not run there, but the bare chat
                    does answer. That is why the ternary is around the KEY and not around
                    a half sentence. */}
                <li>{ai.runs
                    ? t('webpages.audience.public_agent_never_ai_on',
                        'An agent block never runs on a public share. The plain AI chat below is a different thing, and it does answer outside readers.')
                    : t('webpages.audience.public_agent_never',
                        'An agent block never runs on a public share, so a chat block on this page stays blank for outside readers.')}</li>
                {/* De derde eigenschap: de enige die geld kost, en de enige die
                    een anonieme bezoeker een levend kanaal geeft. */}
                <PublicAiNotes t={t} ai={ai} />
            </ul>
        </Card>
    );
}
