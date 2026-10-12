import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * Two miniature slides — the cover and a content slide with bullets and a
 * table — drawn from a RESOLVED deck theme (the server's
 * deckThemeOptions.resolveDeckTheme output). Every colour, typeface and
 * style choice comes from that object; nothing is decided here, so what the
 * preview shows is what the .pptx and the PDF deck will show.
 *
 * Inline styles on purpose: the preview is a picture of a document, not part
 * of the app's own theme, and must not pick up the dark-mode tokens.
 */

const RATIO = 9 / 16;

function Slide({ theme, children, background, style, side = 'content' }) {
    const tpl = theme.template && theme.template[side];
    const overlays = tpl && Array.isArray(tpl.overlays) ? tpl.overlays : [];
    return (
        <div
            style={{
                position: 'relative', width: '100%', paddingTop: `${RATIO * 100}%`, borderRadius: 6, overflow: 'hidden',
                background: background || theme.background, boxShadow: '0 1px 3px rgba(0,0,0,.25)', fontFamily: theme.fontStack,
                ...(tpl && tpl.image ? { backgroundImage: `url(${tpl.image})`, backgroundSize: '100% 100%' } : {}),
                ...style,
            }}
            data-template={tpl ? 'yes' : undefined}
        >
            {overlays.map((o, i) => <img key={i} src={o.image} alt="" style={{ position: 'absolute', left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, height: `${o.h * 100}%`, objectFit: 'contain' }} />)}
            <div style={{ position: 'absolute', inset: 0 }}>{children}</div>
        </div>
    );
}

function Logo({ theme, style }) {
    if (!theme.logoDataUrl) return null;
    return <img src={theme.logoDataUrl} alt="" style={{ objectFit: 'contain', ...style }} />;
}

function Footer({ theme, onDark = false }) {
    const color = onDark ? theme.onAccent : theme.muted;
    const showLogo = theme.logoPlacement === 'footer';
    return (
        <>
            <div style={{ position: 'absolute', left: '4%', bottom: '6%', display: 'flex', alignItems: 'center', gap: '2%', fontSize: '0.36em', color, maxWidth: '80%', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                {showLogo && <Logo theme={theme} style={{ height: '1.6em', width: 'auto' }} />}
                <span>{theme.footerText || theme.brandName || ''}</span>
            </div>
            {theme.slideNumbers && <div style={{ position: 'absolute', right: '4%', bottom: '6%', fontSize: '0.36em', color }}>2</div>}
        </>
    );
}

export function CoverSlide({ theme, title = 'Quarterly review', subtitle = 'Board meeting · Q3' }) {
    const tpl = !!theme.template;
    const accent = !tpl && theme.coverStyle === 'accent';
    const split = !tpl && theme.coverStyle === 'split';
    const light = !tpl && theme.coverStyle === 'light';
    const titleColor = tpl ? theme.text : (accent ? theme.onAccent : theme.accentOnSlide);
    const subColor = accent ? theme.onAccent : theme.text;
    const showLogo = theme.logoPlacement !== 'none';
    return (
        <Slide theme={theme} side="cover" background={accent ? theme.accent : theme.background}>
            {split && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '36%', background: theme.accent }} />}
            {light && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '5%', background: theme.accent }} />}
            {showLogo && split && <Logo theme={theme} style={{ position: 'absolute', left: '6%', top: '40%', width: '24%', height: '18%' }} />}
            {showLogo && light && <Logo theme={theme} style={{ position: 'absolute', left: '6%', top: '9%', width: '22%', height: '16%' }} />}
            {showLogo && accent && <Logo theme={theme} style={{ position: 'absolute', left: '6%', bottom: '9%', width: '14%', height: '10%' }} />}
            <div style={{ position: 'absolute', left: split ? '42%' : '6%', right: '6%', top: light ? '38%' : '30%' }}>
                <div style={{ fontFamily: theme.titleFontStack, fontWeight: 700, fontSize: '1.05em', lineHeight: 1.15, color: titleColor }}>{title}</div>
                <div style={{ marginTop: '0.35em', fontSize: '0.5em', color: subColor, opacity: accent ? 0.9 : 1 }}>{subtitle}</div>
            </div>
        </Slide>
    );
}

/** Four bars in the theme's chart palette — the colours a chart on a slide will use. */
function MiniChart({ theme }) {
    const colours = Array.isArray(theme.chartColors) && theme.chartColors.length ? theme.chartColors : [theme.accent];
    const bars = [0.55, 0.85, 0.7, 1];
    return (
        <div data-testid="deck-preview-chart" style={{ display: 'flex', alignItems: 'flex-end', gap: '3%', height: '22%', marginTop: '6%', paddingLeft: '4%', borderBottom: `1px solid ${theme.tableLine}` }}>
            {bars.map((h, i) => <div key={i} style={{ flex: 1, height: `${h * 100}%`, background: colours[i % colours.length], borderRadius: '2px 2px 0 0' }} />)}
        </div>
    );
}

export function ContentSlide({ theme, title = 'Overview of invoices' }) {
    const { t } = useTranslation();
    const band = theme.titleStyle === 'band' && !theme.template;
    const cornerLogo = theme.logoPlacement === 'corner';
    const cell = (text, i, header = false) => {
        const base = { padding: '0.12em 0.3em', fontSize: '0.36em', textAlign: i ? 'right' : 'left', whiteSpace: 'nowrap' };
        if (theme.tableStyle === 'banded') {
            return header
                ? { ...base, background: theme.tableHeaderFill, color: theme.tableHeaderText, fontWeight: 700, border: `1px solid ${theme.tableLine}` }
                : { ...base, color: theme.text, border: `1px solid ${theme.tableLine}` };
        }
        if (theme.tableStyle === 'lines') {
            return header
                ? { ...base, color: theme.accentOnSlide, fontWeight: 700, borderBottom: `2px solid ${theme.accentOnSlide}` }
                : { ...base, color: theme.text, borderBottom: `1px solid ${theme.tableLine}` };
        }
        return header ? { ...base, color: theme.accentOnSlide, fontWeight: 700 } : { ...base, color: theme.text };
    };
    const rows = [['Noordlicht Energie', 'INV-1000', '€ 1.554'], ['Eemshaven Logistiek', '2026-113', '€ 2.795']];
    return (
        <Slide theme={theme}>
            <div style={{
                position: 'absolute', left: 0, right: 0, top: 0, height: band ? '15%' : '18%', background: band ? theme.bandColor : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: band ? '0 4%' : `3.5% 5% 0 ${theme.titleInset ? `${Math.max(5, theme.titleInset * 100 + 2).toFixed(1)}%` : '5%'}`,
            }}>
                <div style={{ fontFamily: theme.titleFontStack, fontWeight: 700, fontSize: band ? '0.62em' : '0.7em', color: theme.titleColor }}>
                    {title}
                    {theme.titleStyle === 'rule' && <div style={{ width: '18%', height: 2, background: theme.accentOnSlide, marginTop: '0.25em', minWidth: 24 }} />}
                </div>
                {theme.brandOnSlides && theme.brandName && !cornerLogo && (
                    <div style={{ fontSize: '0.3em', letterSpacing: '0.15em', color: band ? theme.titleColor : theme.muted, opacity: 0.85 }}>{theme.brandName}</div>
                )}
            </div>
            {cornerLogo && <Logo theme={theme} style={{ position: 'absolute', right: '4%', top: band ? '17%' : '4%', width: '12%', height: '8%' }} />}
            <div style={{ position: 'absolute', left: '5%', right: '5%', top: band ? '22%' : '26%', bottom: '18%', display: 'grid', gridTemplateColumns: '1fr 1.25fr', gap: '5%' }}>
                <div style={{ minWidth: 0 }}>
                    <ul style={{ margin: 0, paddingLeft: '1em', color: theme.text, fontSize: '0.42em', lineHeight: 1.5 }}>
                        <li>{t('documents.deck.sample_revenue', 'Revenue up 12%')}</li>
                        <li>{t('documents.deck.sample_margin', 'Margin stable')}</li>
                    </ul>
                    <MiniChart theme={theme} />
                </div>
                <table style={{ borderCollapse: 'collapse', width: '100%', alignSelf: 'start' }}>
                    <thead><tr>{['Supplier', 'Invoice', 'Total'].map((h, i) => <th key={h} style={cell(h, i, true)}>{h}</th>)}</tr></thead>
                    <tbody>
                        {rows.map((r, ri) => (
                            <tr key={ri}>{r.map((c, i) => <td key={i} style={{ ...cell(c, i), ...(theme.tableStyle === 'banded' && ri % 2 === 1 ? { background: theme.tableBand } : {}) }}>{c}</td>)}</tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Footer theme={theme} />
        </Slide>
    );
}

/**
 * @param {{ theme: object|null, loading?: boolean }} props  a resolved deck theme; null renders placeholders
 */
export default function DeckPreview({ theme, loading = false }) {
    if (!theme) {
        return (
            <div className="grid grid-cols-2 gap-3" data-testid="deck-preview-empty">
                {[0, 1].map((i) => <div key={i} className="rounded-md" style={{ paddingTop: `${RATIO * 100}%`, background: 'var(--bg-tertiary)' }} />)}
            </div>
        );
    }
    return (
        <div className="grid grid-cols-2 gap-3" style={{ fontSize: 'clamp(9px, 1.6vw, 15px)', opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }} data-testid="deck-preview">
            <CoverSlide theme={theme} />
            <ContentSlide theme={theme} />
        </div>
    );
}
