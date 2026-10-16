import { createElement, type ReactNode } from 'react';
import type { PageElement, PageElementRenderer, PageRenderContext } from './pageElementTypes';

function renderChildren(element: PageElement, ctx: PageRenderContext): ReactNode {
    const { children } = element;
    if (!children) return null;
    if (Array.isArray(children)) {
        return children.map((child, i) => ctx.renderElement(child, i));
    }
    return children;
}

// ============ LAYOUT ============

export const renderPage: PageElementRenderer = (element, key, ctx) => (
    <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {element.title && (
            <h1 style={{
                fontSize: '1.5rem',
                fontWeight: '700',
                color: 'var(--text-primary)',
                paddingBottom: '0.75rem',
                borderBottom: '2px solid transparent',
                borderImage: 'linear-gradient(90deg, #8b5cf6, #6366f1, transparent) 1',
                margin: 0
            }}>
                {element.title}
            </h1>
        )}
        {renderChildren(element, ctx)}
    </div>
);

export const renderGrid: PageElementRenderer = (element, key, ctx) => (
    <div
        key={key}
        style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${element.columns || 2}, minmax(0, 1fr))`,
            gap: element.gap || 16
        }}
    >
        {renderChildren(element, ctx)}
    </div>
);

export const renderRow: PageElementRenderer = (element, key, ctx) => (
    <div
        key={key}
        style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: element.gap || 16,
            alignItems: element.align || 'stretch',
            justifyContent: element.justify || 'flex-start'
        }}
    >
        {renderChildren(element, ctx)}
    </div>
);

export const renderSection: PageElementRenderer = (element, key, ctx) => (
    <div key={key} style={{ marginBottom: '1.5rem', overflow: 'hidden', maxWidth: '100%' }}>
        {element.title && (
            <h2 style={{
                fontSize: '1.125rem',
                fontWeight: '600',
                marginBottom: '1rem',
                paddingBottom: '0.5rem',
                color: 'var(--text-primary)',
                borderBottom: '1px solid var(--border-subtle)'
            }}>
                {element.title}
            </h2>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflow: 'hidden' }}>{renderChildren(element, ctx)}</div>
    </div>
);

export const renderCard: PageElementRenderer = (element, key, ctx) => (
    <div
        key={key}
        style={{
            background: 'var(--bg-secondary)',
            borderRadius: '1rem',
            padding: '1.25rem',
            border: '1px solid var(--border-default)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
            transition: 'all 0.2s ease',
            position: 'relative',
            overflow: 'hidden',
            minWidth: 0
        }}
        onMouseEnter={(e) => {
            e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.12)';
            e.currentTarget.style.transform = 'translateY(-2px)';
        }}
        onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.06)';
            e.currentTarget.style.transform = 'translateY(0)';
        }}
    >
        {/* Accent gradient line at top */}
        <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '3px',
            background: 'linear-gradient(90deg, #8b5cf6, #6366f1, #3b82f6)'
        }} />
        {element.title && (
            <h3 style={{
                fontSize: '1rem',
                fontWeight: '600',
                color: 'var(--text-primary)',
                marginBottom: '0.75rem'
            }}>
                {element.title}
            </h3>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {renderChildren(element, ctx)}
        </div>
    </div>
);

// ============ CONTENT ============

const HEADING_SIZES: Record<number, { size: string; weight: string }> = {
    1: { size: '1.75rem', weight: '700' },
    2: { size: '1.375rem', weight: '600' },
    3: { size: '1.125rem', weight: '600' },
    4: { size: '1rem', weight: '600' },
    5: { size: '0.875rem', weight: '500' },
    6: { size: '0.75rem', weight: '500' }
};

export const renderHeading: PageElementRenderer = (element, key) => {
    const hStyle = HEADING_SIZES[element.level || 2];
    return createElement(
        `h${element.level || 2}`,
        {
            key,
            style: {
                color: 'var(--text-primary)',
                fontSize: hStyle.size,
                fontWeight: hStyle.weight,
                lineHeight: '1.4'
            }
        },
        element.text
    );
};

export const renderText: PageElementRenderer = (element, key) => (
    <p key={key} style={{
        color: 'var(--text-secondary)',
        fontSize: '0.9rem',
        lineHeight: '1.7',
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
        margin: 0
    }}>
        {element.text || element.content}
    </p>
);

export const renderImage: PageElementRenderer = (element, key) => (
    <img
        key={key}
        src={element.src}
        alt={element.alt || ''}
        style={{
            width: '100%',
            maxWidth: '100%',
            height: element.height || 'auto',
            objectFit: element.fit || 'cover',
            borderRadius: '0.75rem',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            display: 'block'
        }}
    />
);

export const renderList: PageElementRenderer = (element, key, ctx) => {
    const ListTag = element.ordered ? 'ol' : 'ul';
    return (
        <ListTag
            key={key}
            style={{
                color: 'var(--text-secondary)',
                fontSize: '0.9rem',
                paddingLeft: '1.5rem',
                listStyleType: element.ordered ? 'decimal' : 'disc'
            }}
        >
            {(element.items || []).map((item, i) => (
                <li key={i} style={{ marginBottom: '0.5rem' }}>
                    {typeof item === 'object' ? ctx.renderElement(item, i) : (typeof item === 'string' || typeof item === 'number' ? item : null)}
                </li>
            ))}
        </ListTag>
    );
};

export const renderDivider: PageElementRenderer = (_element, key) => (
    <hr
        key={key}
        style={{
            border: 'none',
            borderTop: '1px solid var(--border-subtle)',
            margin: '1.5rem 0'
        }}
    />
);
