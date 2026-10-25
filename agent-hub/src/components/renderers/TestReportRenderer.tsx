import { CheckCircle, XCircle, AlertTriangle, Clock, Bug, Shield, Zap, Eye } from 'lucide-react';
import React, { useState } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import type { TestCase, TestReportData } from './TestReportRenderer.types';
import { TranslateParams, useTranslation } from '../../hooks/useTranslation';
import { TestReportRendererSection } from './TestReportRendererSection';

const TestReportRenderer = ({ data }: { data?: TestReportData | null }) => {
    const { t } = useTranslation();
    const [expandedTests, setExpandedTests] = useState(new Set<number>());
    const [filter, setFilter] = useState('all'); // all, passed, failed, warning, skipped

    if (!data) return null;

    const tests = data.tests || [];
    const summary = data.summary || {
        passed: tests.filter((t: TestCase): boolean => t.status === 'passed').length,
        failed: tests.filter((t: TestCase): boolean => t.status === 'failed').length,
        skipped: tests.filter((t: TestCase): boolean => t.status === 'skipped').length,
        warnings: tests.filter((t: TestCase): boolean => t.status === 'warning').length,
    };
    const total = (summary.passed || 0) + (summary.failed || 0) + (summary.skipped || 0) + (summary.warnings || 0);
    const passRate = total > 0 ? Math.round(((summary.passed || 0) / total) * 100) : 0;

    const toggleTest = (index: number) => {
        setExpandedTests(prev => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    const filteredTests = filter === 'all'
        ? tests
        : tests.filter((t: TestCase): boolean => t.status === filter);

    const statusConfig: Record<string, { color: string; bg: string; icon: React.JSX.Element; label: string; }> = {
        passed: { color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)', icon: <CheckCircle className="w-4 h-4" />, label: 'Passed' },
        failed: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)', icon: <XCircle className="w-4 h-4" />, label: 'Failed' },
        warning: { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', icon: <AlertTriangle className="w-4 h-4" />, label: 'Warning' },
        skipped: { color: '#6b7280', bg: 'rgba(107, 114, 128, 0.12)', icon: <Clock className="w-4 h-4" />, label: 'Skipped' },
    };

    const categoryConfig: Record<string, { icon: React.JSX.Element; color: string; }> = {
        functionality: { icon: <Zap className="w-3.5 h-3.5" />, color: '#818cf8' },
        ui: { icon: <Eye className="w-3.5 h-3.5" />, color: '#38bdf8' },
        performance: { icon: <Clock className="w-3.5 h-3.5" />, color: '#fb923c' },
        accessibility: { icon: <Shield className="w-3.5 h-3.5" />, color: '#a78bfa' },
        security: { icon: <Bug className="w-3.5 h-3.5" />, color: '#f472b6' },
    };

    const severityColors: Record<string, string> = {
        critical: '#ef4444',
        major: '#f97316',
        minor: '#eab308',
        cosmetic: '#6b7280',
    };

    return (
        <div style={{
            width: '100%',
            maxWidth: '100%',
            overflow: 'hidden',
            whiteSpace: 'normal',
            fontFamily: 'var(--font-sans)',
            margin: '0.5rem 0',
            borderRadius: '1rem',
            background: 'var(--bg-primary, #0a0a1a)',
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
            boxSizing: 'border-box',
        }}>
            {/* ── Header ── */}
            <div style={{
                padding: '1.5rem 1.5rem 1rem',
                borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                background: passRate >= 80
                    ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, transparent 50%)'
                    : passRate >= 50
                        ? 'linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, transparent 50%)'
                        : 'linear-gradient(135deg, rgba(239, 68, 68, 0.08) 0%, transparent 50%)',
                borderRadius: '1rem 1rem 0 0',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span style={{ fontSize: '1.25rem' }}>🧪</span>
                    <h2 style={{
                        fontSize: '1.25rem',
                        fontWeight: '700',
                        color: 'var(--text-primary, #fff)',
                        margin: 0,
                    }}>
                        {data.title || 'Test Report'}
                    </h2>
                </div>
                <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '1rem',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted, #888)',
                    marginTop: '0.5rem',
                }}>
                    {data.url && <span>🌐 {data.url}</span>}
                    {data.timestamp && <span>📅 {new Date(data.timestamp).toLocaleString()}</span>}
                    {data.duration && <span>⏱ {data.duration}</span>}
                </div>
            </div>

            {/* ── Summary Stats ── */}
            <TestReportRendererSection2 passRate={passRate} t={t} summary={summary} statusConfig={statusConfig} setFilter={setFilter} filter={filter} />

            {/* ── Test Cases ── */}
            <TestReportRendererSection filteredTests={filteredTests} filter={filter} t={t} statusConfig={statusConfig} categoryConfig={categoryConfig} expandedTests={expandedTests} severityColors={severityColors} toggleTest={toggleTest} />

            {/* ── Recommendations ── */}
            {data.recommendations && data.recommendations.length > 0 && (
                <div style={{
                    padding: '1rem 1.5rem',
                    borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                }}>
                    <div style={{
                        fontSize: '0.8rem',
                        fontWeight: '700',
                        color: 'var(--text-primary, #fff)',
                        marginBottom: '0.5rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                    }}>
                        💡 {t('chat.renderers.tests_recommendations', 'Recommendations')}
                    </div>
                    <ul style={{
                        margin: 0,
                        paddingLeft: '1.25rem',
                        fontSize: '0.8rem',
                        color: 'var(--text-secondary, #ccc)',
                        lineHeight: 1.8,
                    }}>
                        {data.recommendations.map((rec, i) => (
                            <li key={i}>{typeof rec === 'string' ? rec : (rec?.description || rec?.action || JSON.stringify(rec))}</li>
                        ))}
                    </ul>
                </div>
            )}

            {/* ── Notes ── */}
            {data.notes && (
                <div style={{
                    padding: '1rem 1.5rem',
                    borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary, #ccc)',
                    lineHeight: 1.6,
                }}>
                    <MarkdownRenderer content={data.notes} />
                </div>
            )}
        </div>
    );
};

export default TestReportRenderer;

function TestReportRendererSection2({ passRate, t, summary, statusConfig, setFilter, filter }: { passRate: number; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; summary: { passed?: number; failed?: number; skipped?: number; warnings?: number; }; statusConfig: Record<string, { color: string; bg: string; icon: React.JSX.Element; label: string; }>; setFilter: React.Dispatch<React.SetStateAction<string>>; filter: string; }) {
    return <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: '0.5rem',
        padding: '1rem 1.5rem',
        borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
    }}>
        {/* Pass rate */}
        <div style={{
            textAlign: 'center',
            padding: '0.75rem 0.5rem',
            borderRadius: '0.75rem',
            background: 'var(--bg-tertiary, rgba(255,255,255,0.03))',
        }}>
            <div style={{
                fontSize: '1.5rem',
                fontWeight: '800',
                color: passRate >= 80 ? '#10b981' : passRate >= 50 ? '#f59e0b' : '#ef4444',
                lineHeight: 1.2,
            }}>
                {passRate}%
            </div>
            <div style={{
                fontSize: '0.65rem',
                color: 'var(--text-muted, #888)',
                marginTop: '0.25rem',
                fontWeight: '600',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
            }}>
                {t('chat.renderers.tests_pass_rate', 'Pass Rate')}
            </div>
        </div>
        {/* Individual counts */}
        {[
            { key: 'passed', val: summary.passed || 0 },
            { key: 'failed', val: summary.failed || 0 },
            { key: 'warning', val: summary.warnings || 0 },
            { key: 'skipped', val: summary.skipped || 0 },
        ].map(({ key, val }) => {
            const sc = statusConfig[key];
            return (
                <button
                    key={key}
                    onClick={() => setFilter(filter === key ? 'all' : key)}
                    style={{
                        textAlign: 'center',
                        padding: '0.75rem 0.5rem',
                        borderRadius: '0.75rem',
                        background: filter === key ? sc.bg : 'var(--bg-tertiary, rgba(255,255,255,0.03))',
                        border: filter === key ? `1px solid ${sc.color}40` : '1px solid transparent',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                    }}
                >
                    <div style={{
                        fontSize: '1.5rem',
                        fontWeight: '800',
                        color: sc.color,
                        lineHeight: 1.2,
                    }}>
                        {val}
                    </div>
                    <div style={{
                        fontSize: '0.65rem',
                        color: 'var(--text-muted, #888)',
                        marginTop: '0.25rem',
                        fontWeight: '600',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                    }}>
                        {sc.label}
                    </div>
                </button>
            );
        })}
    </div>;
}

