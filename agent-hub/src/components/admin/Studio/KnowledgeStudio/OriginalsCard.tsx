import type { KnowledgeBase } from './knowledgeApi';
import type { TranslateFn } from '@/hooks/useTranslation';

interface OriginalsCardProps {
    t: TranslateFn;
    kb: KnowledgeBase | null;
    canManage: boolean;
    saving: boolean;
    onChange: (keepOriginals: boolean) => void;
}

/**
 * "Keep original files": whether the knowledge base stores the file each
 * document was read from, next to the text it extracted.
 *
 * Off by default and NOT retroactive: the help line says so, because a person
 * who switches it on and then finds old documents without a download button
 * would otherwise conclude it is broken.
 *
 * When privacy redaction is on for the base the switch is locked off and says
 * why. An original holds the very personal data the redaction replaced, so
 * keeping it would defeat the redaction; the server refuses it, and the card
 * explains instead of letting the toggle fail on click.
 */
export default function OriginalsCard({ t, kb, canManage, saving, onChange }: OriginalsCardProps) {
    const blocked = (kb?.originals_blocked_reason ?? kb?.originalsBlockedReason) === 'privacy_redaction';
    const on = !blocked && !!(kb?.keep_originals ?? kb?.keepOriginals);
    const disabled = !canManage || blocked || saving;
    return (
        <section className="flex flex-col gap-1.5" data-testid="kb-originals">
            <label className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                <input
                    type="checkbox"
                    role="switch"
                    checked={on}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.checked)}
                    data-testid="kb-originals-toggle"
                />
                {t('knowledge.originals.title', 'Keep original files')}
            </label>
            <p className="text-[11px] text-[var(--text-tertiary)]">
                {t('knowledge.originals.hint', 'Needed for downloading a document as it was uploaded and for agents that fill in forms. Documents that are already in this knowledge base are not backfilled; only new and refreshed ones are kept.')}
            </p>
            {blocked && (
                <p className="text-[11px] [color:var(--warning-ink,var(--warning))]" data-testid="kb-originals-blocked">
                    {t('knowledge.originals.blocked_privacy', 'Privacy redaction is on for this knowledge base, so originals are not kept: they would still contain the personal data that is replaced in the text.')}
                </p>
            )}
        </section>
    );
}
