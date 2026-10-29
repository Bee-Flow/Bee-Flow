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
        <div className="[width:100%] [max-width:100%] [overflow:hidden] [white-space:normal] [font-family:var(--font-sans)] [margin:0.5rem_0] [border-radius:1rem] [background:var(--bg-primary,_#0a0a1a)] [border:1px_solid_var(--border-subtle,_rgba(255,255,255,0.08))] [box-sizing:border-box]">
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
                <div className="[display:flex] [align-items:center] [gap:0.5rem] [margin-bottom:0.25rem]">
                    <span className="[font-size:1.25rem]">🧪</span>
                    <h2 className="[font-size:1.25rem] [font-weight:700] [color:var(--text-primary,_#fff)] [margin:0]">
                        {data.title || 'Test Report'}
                    </h2>
                </div>
                <div className="[display:flex] [flex-wrap:wrap] [gap:1rem] [font-size:0.75rem] [color:var(--text-muted,_#888)] [margin-top:0.5rem]">
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
                <div className="[padding:1rem_1.5rem] [border-top:1px_solid_var(--border-subtle,_rgba(255,255,255,0.08))]">
                    <div className="[font-size:0.8rem] [font-weight:700] [color:var(--text-primary,_#fff)] [margin-bottom:0.5rem] [display:flex] [align-items:center] [gap:0.4rem]">
                        💡 {t('chat.renderers.tests_recommendations', 'Recommendations')}
                    </div>
                    <ul className="[margin:0] [padding-left:1.25rem] [font-size:0.8rem] [color:var(--text-secondary,_#ccc)] [line-height:1.8]">
                        {data.recommendations.map((rec, i) => (
                            <li key={i}>{typeof rec === 'string' ? rec : (rec?.description || rec?.action || JSON.stringify(rec))}</li>
                        ))}
                    </ul>
                </div>
            )}

            {/* ── Notes ── */}
            {data.notes && (
                <div className="[padding:1rem_1.5rem] [border-top:1px_solid_var(--border-subtle,_rgba(255,255,255,0.08))] [font-size:0.8rem] [color:var(--text-secondary,_#ccc)] [line-height:1.6]">
                    <MarkdownRenderer content={data.notes} />
                </div>
            )}
        </div>
    );
};

export default TestReportRenderer;

function TestReportRendererSection2({ passRate, t, summary, statusConfig, setFilter, filter }: { passRate: number; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; summary: { passed?: number; failed?: number; skipped?: number; warnings?: number; }; statusConfig: Record<string, { color: string; bg: string; icon: React.JSX.Element; label: string; }>; setFilter: React.Dispatch<React.SetStateAction<string>>; filter: string; }) {
    return <div className="[display:grid] [grid-template-columns:repeat(5,_1fr)] [gap:0.5rem] [padding:1rem_1.5rem] [border-bottom:1px_solid_var(--border-subtle,_rgba(255,255,255,0.08))]">
        {/* Pass rate */}
        <div className="[text-align:center] [padding:0.75rem_0.5rem] [border-radius:0.75rem] [background:var(--bg-tertiary,_rgba(255,255,255,0.03))]">
            <div style={{
                fontSize: '1.5rem',
                fontWeight: '800',
                color: passRate >= 80 ? '#10b981' : passRate >= 50 ? '#f59e0b' : '#ef4444',
                lineHeight: 1.2,
            }}>
                {passRate}%
            </div>
            <div className="[font-size:0.65rem] [color:var(--text-muted,_#888)] [margin-top:0.25rem] [font-weight:600] [text-transform:uppercase] [letter-spacing:0.5px]">
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
                    <div className="[font-size:0.65rem] [color:var(--text-muted,_#888)] [margin-top:0.25rem] [font-weight:600] [text-transform:uppercase] [letter-spacing:0.5px]">
                        {sc.label}
                    </div>
                </button>
            );
        })}
    </div>;
}

