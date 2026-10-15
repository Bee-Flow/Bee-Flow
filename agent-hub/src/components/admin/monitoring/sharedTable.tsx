import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { Empty } from './sharedBase';

/** A row of a sortable table: any usage row, with cells rendered as React nodes. */
export interface TableRow {
    _key?: string | number;
    [key: string]: unknown;
}

export interface TableColumn<T extends TableRow> {
    key: string;
    label: ReactNode;
    width?: string;
    align?: 'left' | 'right' | 'center';
    sortable?: boolean;
    color?: string;
    render?: (row: T, i: number) => ReactNode;
}

export type SortDir = 'desc' | 'asc';


// ── Sortable Table ──────────────────────────────────────────────────────────

interface SortableTableProps<T extends TableRow> {
    columns: TableColumn<T>[];
    data: T[];
    onRowClick?: (row: T) => void;
    emptyText?: ReactNode;
    maxRows?: number;
}

export function SortableTable<T extends TableRow>({ columns, data, onRowClick, emptyText, maxRows = 50 }: SortableTableProps<T>) {
    const { t } = useTranslation();
    const [sortCol, setSortCol] = useState<string | null>(null);
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    const handleSort = (colKey: string) => {
        if (sortCol === colKey) {
            setSortDir(d => d === 'desc' ? 'asc' : 'desc');
        } else {
            setSortCol(colKey);
            setSortDir('desc');
        }
    };

    const sorted = useMemo(() => {
        if (!sortCol) return data;
        return [...data].sort((a, b) => {
            const av = a[sortCol], bv = b[sortCol];
            if (typeof av === 'number' && typeof bv === 'number') {
                return sortDir === 'desc' ? bv - av : av - bv;
            }
            const as = String(av || ''), bs = String(bv || '');
            return sortDir === 'desc' ? bs.localeCompare(as) : as.localeCompare(bs);
        });
    }, [data, sortCol, sortDir]);

    if (data.length === 0) return <Empty text={emptyText ?? t('admin_monitoring.shared_no_data', 'No data')} />;

    const gridCols = columns.map(c => c.width || '1fr').join(' ');

    return (
        <div>
            {/* Header */}
            <div style={{
                display: 'grid', gridTemplateColumns: gridCols,
                gap: '8px', padding: '8px 12px', marginBottom: '2px',
                fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.05em', color: 'var(--text-muted, #666)',
            }}>
                {columns.map(col => (
                    <span
                        key={col.key}
                        onClick={() => col.sortable !== false && handleSort(col.key)}
                        style={{
                            textAlign: col.align || 'left',
                            cursor: col.sortable !== false ? 'pointer' : 'default',
                            userSelect: 'none',
                            display: 'flex', alignItems: 'center', gap: '3px',
                            justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start',
                        }}
                    >
                        {col.label}
                        {sortCol === col.key && (
                            <span style={{ fontSize: '8px', opacity: 0.7 }}>{sortDir === 'desc' ? '▼' : '▲'}</span>
                        )}
                    </span>
                ))}
            </div>
            {/* Rows */}
            {sorted.slice(0, maxRows).map((row, i) => (
                <div
                    key={row._key || i}
                    onClick={() => onRowClick?.(row)}
                    style={{
                        display: 'grid', gridTemplateColumns: gridCols,
                        gap: '8px', padding: '10px 12px', borderRadius: '8px',
                        background: i % 2 === 0 ? 'transparent' : 'var(--bg-tertiary, rgba(255,255,255,0.02))',
                        alignItems: 'center',
                        cursor: onRowClick ? 'pointer' : 'default',
                        transition: 'background 0.12s',
                    }}
                    onMouseEnter={e => { if (onRowClick) e.currentTarget.style.background = 'var(--bg-tertiary, rgba(255,255,255,0.05))'; }}
                    onMouseLeave={e => { if (onRowClick) e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'var(--bg-tertiary, rgba(255,255,255,0.02))'; }}
                >
                    {columns.map(col => (
                        <div key={col.key} style={{ textAlign: col.align || 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {col.render ? col.render(row, i) : (
                                <span style={{ fontSize: '12px', fontWeight: 500, color: col.color || 'var(--text-primary, #fff)' }}>
                                    {(row[col.key] as ReactNode) ?? '—'}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

