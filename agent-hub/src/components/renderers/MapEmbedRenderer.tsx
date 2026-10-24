import React, { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';

interface MapEmbedRendererProps {
    embedUrl?: string;
    title?: string;
    mapsLink?: string;
    height?: number;
}

/**
 * MapEmbedRenderer — Renders a Google Maps Embed iframe in chat messages.
 * Used when AI tools return an embedUrl (directions or places search).
 */
const MapEmbedRenderer = ({ embedUrl, title, mapsLink, height = 300 }: MapEmbedRendererProps) => {
    const { t } = useTranslation();
    const [loaded, setLoaded] = useState<boolean>(false);
    const isMobile = window.innerWidth < 768;
    const mapHeight = isMobile ? 220 : height;

    if (!embedUrl) return null;

    return (
        <div
            className="map-embed-wrapper [margin:12px_0] [border-radius:12px] [border:1px_solid_var(--border-subtle,#2a2a3e)] [background:var(--bg-tertiary,#1e1e2e)] [overflow:hidden] [position:relative]"
        >
            {/* Title bar */}
            {title && (
                <div
                    className="[display:flex] [align-items:center] [justify-content:space-between] [padding:8px_12px] [background:rgba(255,255,255,0.04)] [border-bottom:1px_solid_var(--border-subtle,rgba(255,255,255,0.06))] [font-size:12px] [font-weight:600] [color:var(--text-secondary,#94a3b8)]"
                >
                    <span className="[display:flex] [align-items:center] [gap:6px]">
                        <span>📍</span>
                        <span>{title}</span>
                    </span>
                    {mapsLink && (
                        <a
                            href={mapsLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="[color:var(--accent-primary,#818cf8)] [text-decoration:none] [font-size:11px] [font-weight:500] [display:flex] [align-items:center] [gap:4px]"
                        >
                            {t('chat.renderers.map_open', 'Open in Maps ↗')}
                        </a>
                    )}
                </div>
            )}

            {/* Loading state */}
            {!loaded && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: `${mapHeight}px`,
                        color: 'var(--text-muted, #64748b)',
                        fontSize: '13px',
                        gap: '8px',
                    }}
                >
                    <div
                        className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin [border-color:var(--accent-primary,#818cf8)]! [border-top-color:transparent]!"
                    />
                    {t('chat.renderers.map_loading', 'Loading map...')}
                </div>
            )}

            {/* Map iframe — use visibility instead of display:none so browser actually loads it */}
            <iframe
                src={embedUrl}
                width="100%"
                height={mapHeight}
                style={{
                    border: 0,
                    display: 'block',
                    visibility: loaded ? 'visible' : 'hidden',
                    height: loaded ? `${mapHeight}px` : '0px',
                    overflow: 'hidden',
                }}
                frameBorder="0"
                allowFullScreen
                referrerPolicy="no-referrer-when-downgrade"
                onLoad={() => setLoaded(true)}
            />
        </div>
    );
};

export default React.memo(MapEmbedRenderer);
