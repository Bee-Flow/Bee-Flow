import { stepDragProps } from '../stepDrag';
import { IntegrationLogo } from './jsComponents';
import useTranslation from '../../../../../hooks/useTranslation';
import { FAMILY_TEXT, FAMILY_TILE } from './ribbonCategories';
import type { StepPayload } from './ribbonCategories';
import type { FitCard, FrequentItem } from './fitsAfter';
import type { RibbonAnchor } from './ribbonAnchor';
import { typeGroupOf } from '../nodeTypeColors';

type AddFn = (payload: StepPayload) => void;

const CAPTION = 'text-[10px] tracking-[.06em] uppercase font-semibold text-[var(--text-tertiary)]';

function FitCardButton({ card, onAdd }: { card: FitCard; onAdd: AddFn }) {
    const { t } = useTranslation();
    const Icon = card.Icon;
    return (
        <button
            type="button"
            onClick={() => onAdd(card.payload)}
            disabled={!!card.disabled}
            title={card.disabled ? card.disabledReason : undefined}
            {...(card.disabled ? null : stepDragProps(card.payload))}
            className="w-[136px] shrink-0 flex flex-col gap-1.5 p-2.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-left hover:bg-[var(--bg-secondary)] transition disabled:opacity-50 select-none cursor-grab active:cursor-grabbing"
        >
            <span className={`w-7 h-7 rounded-lg grid place-items-center ${FAMILY_TILE[card.family] || FAMILY_TILE.data}`}>
                <Icon size={14} />
            </span>
            <span className="font-semibold text-[var(--text-primary)] leading-4">{t(card.titleKey, card.title)}</span>
            <span className="text-[var(--text-tertiary)] leading-[15px]">{t(card.whyKey, card.why)}</span>
        </button>
    );
}

function FrequentRow({ item, onAdd }: { item: FrequentItem; onAdd: AddFn }) {
    const Icon = item.Icon;
    const family = typeGroupOf(item.payload?.kind) as string;
    return (
        <button
            type="button"
            onClick={() => onAdd(item.payload)}
            disabled={!!item.disabled}
            title={item.disabled ? item.disabledReason : item.secondary}
            {...(item.disabled ? null : stepDragProps(item.payload))}
            className="min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition disabled:opacity-50 select-none cursor-grab active:cursor-grabbing"
        >
            <span className={`shrink-0 ${FAMILY_TEXT[family] || 'text-[var(--text-secondary)]'}`}>
                {Icon ? <Icon size={14} /> : <IntegrationLogo integrationId={item.integrationId} tool={item.tool} size={14} />}
            </span>
            <span className="truncate">{item.label}</span>
        </button>
    );
}

/**
 * The Suggested tab (design 5a): with a step picked, four cards that fit
 * after what it hands on; always, the steps used most here.
 */
export default function SuggestedPanel({ anchor, cards, frequent, onAdd }: {
    anchor: RibbonAnchor | null;
    cards: FitCard[];
    frequent: FrequentItem[];
    onAdd: AddFn;
}) {
    const { t } = useTranslation();
    const showFits = !!anchor?.explicit && cards.length > 0;
    return (
        <div className="flex items-stretch gap-3" data-testid="ribbon-suggested">
            {showFits && (
                <>
                    <div className="flex flex-col gap-1.5 min-w-0" data-testid="ribbon-fits-after">
                        <div className={CAPTION}>{t('automations.ribbon.fits_after', 'Fits after “{step}”', { step: anchor?.label || '' })}</div>
                        <div className="flex gap-1.5">
                            {cards.map(card => <FitCardButton key={card.id} card={card} onAdd={onAdd} />)}
                        </div>
                    </div>
                    <div className="w-px bg-[var(--border-default)] shrink-0" aria-hidden="true" />
                </>
            )}
            <div className="flex flex-col gap-1.5 flex-1 min-w-0" data-testid="ribbon-frequent">
                <div className={CAPTION}>
                    {showFits
                        ? t('automations.ribbon.frequently_used', 'Frequently used')
                        : t('automations.ribbon.frequently_used_org', 'Frequently used in your organisation')}
                </div>
                {frequent.length > 0 ? (
                    <div className="grid grid-cols-4 gap-x-2 gap-y-1">
                        {frequent.map(item => <FrequentRow key={`${item.payload?.kind}:${item.key}:${item.label}`} item={item} onAdd={onAdd} />)}
                    </div>
                ) : (
                    <div className="text-[12px] text-[var(--text-tertiary)] py-1">
                        {t('automations.ribbon.frequent_empty', 'Nothing yet. The steps you and your colleagues add most will show up here.')}
                    </div>
                )}
            </div>
        </div>
    );
}
