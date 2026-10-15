import type { ChartDatum, PageAccordionItem, PageElement, PageElementRenderer, PageTableColumn } from './pageElementTypes';

// ============ INTERACTIVE ============

const BUTTON_COLORS: Record<string, { bg: string; hover: string }> = {
    primary: { bg: 'linear-gradient(135deg, #8b5cf6, #6366f1)', hover: '#7c3aed' },
    secondary: { bg: 'var(--bg-tertiary)', hover: 'var(--bg-secondary)' },
    success: { bg: 'linear-gradient(135deg, #10b981, #059669)', hover: '#059669' },
    danger: { bg: 'linear-gradient(135deg, #ef4444, #dc2626)', hover: '#dc2626' },
    warning: { bg: 'linear-gradient(135deg, #f59e0b, #d97706)', hover: '#d97706' }
};

export const renderButton: PageElementRenderer = (element, key, ctx) => {
    const btnStyle = (element.variant && BUTTON_COLORS[element.variant]) || BUTTON_COLORS.primary;
    return (
        <button
            key={key}
            onClick={() => ctx.onButtonClick(element)}
            style={{
                background: btnStyle.bg,
                color: element.variant === 'secondary' ? 'var(--text-primary)' : 'white',
                padding: '0.625rem 1.25rem',
                borderRadius: '0.625rem',
                fontWeight: '500',
                fontSize: '0.875rem',
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.transform = 'translateY(-1px)'; }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.transform = 'translateY(0)'; }}
        >
            {element.text || element.label}
        </button>
    );
};

export const renderTabs: PageElementRenderer = (element, key, ctx) => {
    const tabs = element.tabs || [];
    return (
        <div key={key}>
            <div style={{
                display: 'flex',
                gap: '0.5rem',
                marginBottom: '1rem',
                borderBottom: '2px solid var(--border-subtle)',
                paddingBottom: '0.5rem'
            }}>
                {tabs.map((tab, i) => (
                    <button
                        key={i}
                        style={{
                            padding: '0.5rem 1rem',
                            fontSize: '0.875rem',
                            fontWeight: '500',
                            color: i === 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                            background: i === 0 ? 'var(--bg-tertiary)' : 'transparent',
                            border: 'none',
                            borderRadius: '0.5rem',
                            cursor: 'pointer'
                        }}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div>{tabs[0]?.children && tabs[0].children.map((c, j) => ctx.renderElement(c, j))}</div>
        </div>
    );
};

export const renderAccordion: PageElementRenderer = (element, key, ctx) => (
    <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {(element.items || []).map((rawItem, i) => {
            const item = accordionItem(rawItem);
            return (
                <details
                    key={i}
                    style={{
                        background: 'var(--bg-tertiary)',
                        borderRadius: '0.75rem',
                        overflow: 'hidden'
                    }}
                >
                    <summary style={{
                        padding: '0.875rem 1rem',
                        cursor: 'pointer',
                        fontWeight: '500',
                        color: 'var(--text-primary)'
                    }}>
                        {item.title}
                    </summary>
                    <div style={{
                        padding: '0 1rem 1rem',
                        fontSize: '0.9rem',
                        color: 'var(--text-secondary)'
                    }}>
                        {item.content || (item.children && item.children.map((c, j) => ctx.renderElement(c, j)))}
                    </div>
                </details>
            );
        })}
    </div>
);

/** An accordion entry; like a property read on null, a missing entry throws. */
function accordionItem(value: unknown): PageAccordionItem {
    if (value == null) throw new TypeError(`Cannot read properties of ${value} (reading 'title')`);
    return typeof value === 'object' ? value : {};
}

// ============ DATA ============

/** The header cells of a table; a non-array `columns` throws, as calling `.map` on it would. */
function tableColumns(columns: PageElement['columns']): PageTableColumn[] {
    const cols = columns || [];
    if (!Array.isArray(cols)) throw new TypeError('table columns is not an array');
    return cols;
}

export const renderTable: PageElementRenderer = (element, key) => (
    <div key={key} style={{
        overflowX: 'auto',
        borderRadius: '0.75rem',
        border: '1px solid var(--border-default)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.05)'
    }}>
        <table style={{ width: '100%', fontSize: '0.875rem', borderCollapse: 'collapse' }}>
            <thead className="bg-[var(--bg-tertiary)]">
                <tr>
                    {tableColumns(element.columns).map((col, i) => (
                        <th key={i} style={{
                            padding: '0.875rem 1rem',
                            textAlign: 'left',
                            fontWeight: '600',
                            color: 'var(--text-primary)'
                        }}>
                            {typeof col === 'object' ? col.label : col}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {(element.rows || []).map((row, i) => (
                    <tr key={i} style={{
                        borderTop: '1px solid var(--border-subtle)',
                        transition: 'background 0.15s'
                    }}>
                        {(Array.isArray(row) ? row : Object.values(row)).map((cell, j) => (
                            <td key={j} style={{
                                padding: '0.875rem 1rem',
                                color: 'var(--text-secondary)'
                            }}>
                                {cell}
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

const STAT_COLORS: Record<string, { bg: string; color: string }> = {
    blue: { bg: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6' },
    green: { bg: 'rgba(16, 185, 129, 0.1)', color: '#10b981' },
    red: { bg: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' },
    yellow: { bg: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b' },
    purple: { bg: 'rgba(139, 92, 246, 0.1)', color: '#8b5cf6' },
    default: { bg: 'var(--bg-secondary)', color: 'var(--text-primary)' }
};

export const renderStat: PageElementRenderer = (element, key) => {
    const sColor = (element.color && STAT_COLORS[element.color]) || STAT_COLORS.default;
    return (
        <div
            key={key}
            style={{
                background: sColor.bg,
                borderRadius: '1rem',
                padding: '1.25rem',
                textAlign: 'center',
                border: '1px solid var(--border-default)'
            }}
        >
            <div style={{
                fontSize: '2rem',
                fontWeight: '700',
                color: sColor.color,
                marginBottom: '0.25rem'
            }}>
                {element.value}
            </div>
            <div style={{
                fontSize: '0.875rem',
                color: 'var(--text-muted)'
            }}>
                {element.label}
            </div>
            {element.change && (
                <div style={{
                    fontSize: '0.75rem',
                    marginTop: '0.5rem',
                    color: element.change > 0 ? '#10b981' : '#ef4444'
                }}>
                    {element.change > 0 ? '↑' : '↓'} {Math.abs(element.change)}%
                </div>
            )}
        </div>
    );
};

const BADGE_COLORS: Record<string, { bg: string; color: string }> = {
    success: { bg: 'rgba(16, 185, 129, 0.15)', color: '#10b981' },
    warning: { bg: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' },
    error: { bg: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' },
    info: { bg: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' },
    default: { bg: 'var(--bg-tertiary)', color: 'var(--text-muted)' }
};

export const renderBadge: PageElementRenderer = (element, key) => {
    const bStyle = (element.variant && BADGE_COLORS[element.variant]) || BADGE_COLORS.default;
    return (
        <span
            key={key}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.25rem 0.75rem',
                borderRadius: '9999px',
                fontSize: '0.75rem',
                fontWeight: '500',
                background: bStyle.bg,
                color: bStyle.color
            }}
        >
            {element.text}
        </span>
    );
};

/** A chart bar; like a property read on null, a missing one throws. */
function chartDatum(value: unknown): Partial<ChartDatum> {
    if (value == null) throw new TypeError(`Cannot read properties of ${value} (reading 'value')`);
    return typeof value === 'object' ? value : {};
}

export const renderChart: PageElementRenderer = (element, key) => {
    const raw = element.data || [];
    if (!Array.isArray(raw)) throw new TypeError('chart data is not an array');
    const data = raw.map((v: unknown) => chartDatum(v));
    const maxValue = Math.max(...data.map(d => Number(d.value)));
    return (
        <div key={key}>
            {element.title && (
                <div style={{
                    fontSize: '0.9rem',
                    fontWeight: '600',
                    color: 'var(--text-primary)',
                    marginBottom: '1rem'
                }}>
                    {element.title}
                </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {data.map((item, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <div style={{
                            width: '5rem',
                            fontSize: '0.8rem',
                            color: 'var(--text-muted)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                        }}>
                            {item.label}
                        </div>
                        <div style={{
                            flex: 1,
                            height: '1.5rem',
                            borderRadius: '9999px',
                            background: 'var(--bg-tertiary)',
                            overflow: 'hidden'
                        }}>
                            <div
                                style={{
                                    height: '100%',
                                    borderRadius: '9999px',
                                    width: `${(Number(item.value) / maxValue) * 100}%`,
                                    background: item.color || 'linear-gradient(90deg, #8b5cf6, #6366f1)',
                                    transition: 'width 0.5s ease'
                                }}
                            />
                        </div>
                        <div style={{
                            width: '3rem',
                            fontSize: '0.8rem',
                            textAlign: 'right',
                            color: 'var(--text-secondary)',
                            fontWeight: '500'
                        }}>
                            {item.value}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
