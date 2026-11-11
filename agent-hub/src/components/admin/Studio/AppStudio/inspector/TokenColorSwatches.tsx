import { Check } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { TOKEN_PREFIX, tokenNameOf } from './colourTokens';
import type { ColourToken } from './colourTokens';

/**
 * The colour tokens of an app (design.tokens, package LK16) as a choice in the colour control:
 * one swatch per token, committing `token:<name>`. A spacing token is not a colour and is left
 * out. A stored `token:<name>` that names no colour token says so instead of showing nothing.
 */

interface Props {
    tokens: ColourToken[];
    value: string | null;
    onChange: (value: string) => void;
    disabled?: boolean;
}

export default function TokenColorSwatches({ tokens, value, onChange, disabled = false }: Props) {
    const { t } = useTranslation();
    const current = tokenNameOf(value);
    const unknown = current !== null && !tokens.some((tk) => tk.name === current);
    return (
        <div className="flex flex-col gap-2">
            <div role="radiogroup" aria-label={t('studio_apps_w3d.color.token_aria', 'Colour token')} className="flex items-center gap-2 flex-wrap">
                {tokens.map((tk) => {
                    const active = current === tk.name;
                    return (
                        <button
                            key={tk.name}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            aria-label={tk.name}
                            title={`${tk.name} ${tk.hex}`}
                            disabled={disabled}
                            onClick={() => onChange(`${TOKEN_PREFIX}${tk.name}`)}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed ${active ? 'border-[var(--text-primary)]' : 'border-[var(--border-default)]'}`}
                        >
                            <span aria-hidden="true" className="relative inline-flex w-4 h-4">
                                <svg viewBox="0 0 16 16" className="w-4 h-4"><circle cx="8" cy="8" r="7.5" fill={tk.hex} stroke="var(--border-default)" /></svg>
                                {active && <Check className="absolute inset-0 m-auto w-3 h-3 text-white drop-shadow" />}
                            </span>
                            {tk.name}
                        </button>
                    );
                })}
            </div>
            {tokens.length === 0 && !unknown ? (
                <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_w3d.color.no_tokens', 'This app has no colour tokens yet. Add them under Theme, Tokens.')}</p>
            ) : null}
            {unknown ? (
                <p className="text-xs text-[var(--warning-ink)]">{t('studio_apps_w3d.color.token_unknown', 'Token "{name}" is not a colour token of this app, so it paints nothing.', { name: current })}</p>
            ) : null}
        </div>
    );
}
