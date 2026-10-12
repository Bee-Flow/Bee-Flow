import { Medal, Award, CircleCheck, Lock, ArrowRight, Share2, Loader2, Eye } from 'lucide-react';
import React from 'react';
import { Card, Eyebrow, EmojiTile, SecondaryButton, PrimaryButton, shortDate } from './bits';
import { courseSegments, splitCapstone, SEGMENT } from './curriculum';
import SegmentedProgress, { countSegments, repeatSegments } from './SegmentedProgress';
import { LEVELS } from '../../../components/onboarding/courses';
import { getCourse } from '../../../components/onboarding/courses';

/**
 * AchievementsView — artboard 1d, the ONLY place all nine badges show: as
 * rows with a way toward them instead of grey silhouettes. One XP line with
 * the five bee stations, the three counters, the badges table, the
 * certificates panel with what is still missing, and how a certificate
 * works once earned.
 */
export default function AchievementsView({
    t, locale, courses, lessonsOf, completedMap, masteredMap, isLocked, isComplete, lockedReasonFor,
    earnedBadges, certificates, levelInfo, busyCertId, onEarnCert, onViewCert, onOpenCourse, capstoneChecks,
}) {
    const lvl = levelInfo?.level;
    const next = levelInfo?.next;
    const xp = levelInfo?.xp || 0;
    const earnedById = Object.fromEntries((earnedBadges || []).map((b) => [b.badgeId || b.id, b]));
    const { capstone, rest } = splitCapstone(courses);
    const ordered = capstone ? [...rest, capstone] : rest;
    const earnedCount = ordered.filter((c) => earnedById[c.badge?.id]).length;
    const certsEarned = (certificates || []).filter((c) => c.issued).length;
    const lessonsDone = levelInfo?.lessonsDone || 0;

    return (
        <div className="flex flex-col gap-4" style={{ padding: '22px 28px', fontSize: 13, color: 'var(--text-primary)' }} data-testid="achievements-view">
            {/* Level card */}
            <Card className="grid items-center gap-7" style={{ padding: '16px 18px', gridTemplateColumns: 'auto minmax(0,1fr) auto' }}>
                <div className="flex items-center gap-3">
                    <EmojiTile icon="🐝" size={48} />
                    <div>
                        <Eyebrow>{t('learn.achievements.level', 'Level')}</Eyebrow>
                        <div className="text-[18px] font-semibold leading-[22px]">{lvl ? t(`learn.level.${lvl.key}`, lvl.titleFallback) : '—'}</div>
                        <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            {next
                                ? t('learn.xp.to_next', '{xp} XP · {n} to {level}').replace('{xp}', String(xp)).replace('{n}', String(next.min - xp)).replace('{level}', t(`learn.level.${next.key}`, next.titleFallback))
                                : t('learn.xp.max', '{xp} XP · top level!').replace('{xp}', String(xp))}
                        </div>
                    </div>
                </div>
                <div className="flex flex-col gap-2 min-w-0">
                    <LevelLine t={t} xp={xp} current={lvl} />
                    <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('learn.achievements.xp_note', 'XP is derived from what you did — never stored. No leaderboard, no streaks.')}</div>
                </div>
                <div className="flex gap-[18px]">
                    <Counter value={lessonsDone} label={t('learn.state.complete', 'complete')} color="var(--learn-complete-ink)" />
                    <Divider />
                    <Counter value={levelInfo?.mastered || 0} label={t('learn.legend.mastered', 'mastered')} color="var(--learn-mastered-ink)" valueColor="var(--learn-mastered-ink)" />
                    <Divider />
                    <Counter value={<>{earnedCount}<span className="text-[12px] font-medium" style={{ color: 'var(--text-tertiary)' }}>/{ordered.length}</span></>} label={t('learn.achievements.badges', 'badges')} color="var(--text-tertiary)" />
                </div>
            </Card>

            <div className="grid gap-4" style={{ gridTemplateColumns: 'minmax(0,1fr) 400px' }}>
                {/* Badges table */}
                <Card className="overflow-hidden flex flex-col text-[12px]">
                    <div className="flex items-center gap-2" style={{ padding: '12px 14px' }}>
                        <Medal style={{ width: 15, height: 15, color: 'var(--text-secondary)' }} aria-hidden="true" />
                        <span className="font-semibold">{t('learn.achievements.badges_title', 'Badges')}</span>
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            {t('learn.achievements.badges_sub', 'one per course · {a} of {b}').replace('{a}', String(earnedCount)).replace('{b}', String(ordered.length))}
                        </span>
                    </div>
                    <div className="grid gap-3 uppercase font-semibold" style={{ gridTemplateColumns: '32px minmax(0,1fr) 170px 180px', padding: '6px 14px', borderTop: '1px solid var(--border-default)', borderBottom: '1px solid var(--border-default)', fontSize: 10, letterSpacing: '.08em', color: 'var(--text-tertiary)' }}>
                        <span /><span>{t('learn.achievements.col_badge', 'Badge')}</span><span>{t('learn.achievements.col_course', 'Course')}</span><span>{t('learn.achievements.col_status', 'Status')}</span>
                    </div>
                    {ordered.map((course, i) => {
                        const badge = course.badge;
                        if (!badge) return null;
                        const earned = earnedById[badge.id];
                        const locked = isLocked(course);
                        const lessons = lessonsOf(course);
                        const done = lessons.filter((l) => !!completedMap[l.id]).length;
                        const isCap = course.id === capstone?.id;
                        const checks = isCap ? capstoneChecks : null;
                        return (
                            <button key={course.id} type="button" onClick={() => onOpenCourse(course.id)} data-testid="badge-row"
                                className="grid items-center gap-3 text-left transition hover:bg-[var(--bg-secondary)]"
                                style={{ gridTemplateColumns: '32px minmax(0,1fr) 170px 180px', padding: '7px 14px', borderBottom: i === ordered.length - 1 ? 'none' : '1px solid var(--border-default)', color: locked ? 'var(--text-tertiary)' : undefined }}>
                                <div className="grid place-items-center" aria-hidden="true"
                                    style={{ width: 32, height: 32, borderRadius: 8, fontSize: 17, lineHeight: 1,
                                        background: earned ? 'color-mix(in srgb, var(--accent-primary) 18%, transparent)' : 'var(--bg-tertiary)',
                                        boxShadow: earned ? '0 0 0 2px var(--learn-complete)' : 'none',
                                        filter: earned ? 'none' : 'grayscale(1)', opacity: earned ? 1 : 0.7 }}>
                                    {badge.icon}
                                </div>
                                <div className="min-w-0">
                                    <div className="font-medium truncate">{t(badge.titleKey, badge.titleFallback)}</div>
                                    <div className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                                        <span aria-hidden="true">{course.icon}</span> {isCap ? t('learn.achievements.capstone_sub', 'Capstone · proven in your workspace') : t(course.titleKey, course.titleFallback)}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    {isCap && checks
                                        ? <><SegmentedProgress width={60} segments={countSegments(checks.done, checks.total)} /><span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t('learn.achievements.checks_n', '{a}/{b} checks').replace('{a}', String(checks.done)).replace('{b}', String(checks.total))}</span></>
                                        : <><SegmentedProgress width={60} segments={locked ? repeatSegments(lessons.length, SEGMENT.LOCKED) : courseSegments(lessons, completedMap, masteredMap)} /><span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{locked ? t('learn.course.lesson_count', '{n} lessons').replace('{n}', String(lessons.length)) : `${done}/${lessons.length}`}</span></>}
                                </div>
                                <BadgeStatus t={t} locale={locale} earned={earned} locked={locked} lockedReason={lockedReasonFor(course)} remaining={lessons.length - done} started={done > 0} minutes={lessons.reduce((n, l) => n + (l.estMinutes || 0), 0)} />
                            </button>
                        );
                    })}
                </Card>

                <div className="flex flex-col gap-4 min-h-0">
                    {/* Certificates */}
                    <Card className="flex flex-col text-[12px]" style={{ padding: '12px 14px' }}>
                        <div className="flex items-center gap-2 pb-2">
                            <Award style={{ width: 15, height: 15, color: 'var(--text-secondary)' }} aria-hidden="true" />
                            <span className="font-semibold">{t('learn.cert.section_title', 'Certificates')}</span>
                            <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                {t('learn.achievements.certs_sub', '{a} of {b} · eligibility is recomputed on the server').replace('{a}', String(certsEarned)).replace('{b}', String((certificates || []).length))}
                            </span>
                        </div>
                        {(certificates || []).map((cert, i) => (
                            <CertificateRow key={cert.certificateId} t={t} cert={cert} last={i === certificates.length - 1}
                                busy={busyCertId === cert.certificateId} isComplete={isComplete} onEarn={onEarnCert} onView={onViewCert} onOpenCourse={onOpenCourse} />
                        ))}
                        {!(certificates || []).length && (
                            <div className="text-[11px] py-2" style={{ color: 'var(--text-tertiary)' }}>{t('learn.achievements.certs_loading', 'Loading your certificates…')}</div>
                        )}
                    </Card>

                    {/* How a certificate works */}
                    <Card className="flex flex-col gap-2 text-[12px] flex-1" style={{ padding: '12px 14px' }}>
                        <div className="flex items-center gap-2">
                            <Share2 style={{ width: 15, height: 15, color: 'var(--text-secondary)' }} aria-hidden="true" />
                            <span className="font-semibold">{t('learn.achievements.how_title', 'How an earned certificate works')}</span>
                        </div>
                        <div className="flex flex-col gap-1.5 text-[11px] leading-4" style={{ color: 'var(--text-secondary)' }}>
                            <div className="flex gap-2"><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>1</span>{t('learn.achievements.how_1', 'Download as PNG or PDF — the image is rendered on the server.')}</div>
                            <div className="flex gap-2"><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>2</span>{t('learn.achievements.how_2', 'Optional: make it public. Only then does a verification link and a LinkedIn button exist.')}</div>
                            <div className="flex gap-2"><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>3</span><span>{t('learn.achievements.how_3', 'Third parties see only your name, the certificate and the date on {path} — never serial numbers, never your progress.').replace('{path}', '/verify/:token')}</span></div>
                        </div>
                    </Card>
                </div>
            </div>
        </div>
    );
}

/** The five bee stations on one line; the current one glows, the fill runs to the learner's XP. */
function LevelLine({ t, xp, current }) {
    return (
        <div className="grid" style={{ gridTemplateColumns: `repeat(${LEVELS.length - 1}, minmax(0,1fr)) auto` }} role="img" aria-label={t('learn.achievements.level_line', 'Progress through the levels')}>
            {LEVELS.map((lv, i) => {
                const reached = xp >= lv.min;
                const isCurrent = current?.key === lv.key;
                const nextMin = LEVELS[i + 1]?.min;
                const fillPct = nextMin == null ? 0 : Math.max(0, Math.min(1, (xp - lv.min) / (nextMin - lv.min)));
                const last = i === LEVELS.length - 1;
                return (
                    <div key={lv.key} className="flex flex-col gap-1.5 min-w-0">
                        <div className="flex items-center" style={{ height: 10 }}>
                            <span className="rounded-full flex-shrink-0" style={{ width: 10, height: 10, background: reached ? 'var(--accent-primary)' : 'var(--bg-tertiary)', boxShadow: isCurrent ? '0 0 0 3px color-mix(in srgb, var(--accent-primary) 25%, transparent)' : 'none' }} />
                            {!last && (
                                <span className="flex-1 flex overflow-hidden" style={{ height: 4, background: 'var(--bg-tertiary)' }}>
                                    <span style={{ width: `${Math.round(fillPct * 100)}%`, height: '100%', background: 'var(--accent-primary)' }} />
                                </span>
                            )}
                        </div>
                        <div className="text-[11px] leading-[14px]" style={{ color: isCurrent ? 'var(--text-primary)' : 'var(--text-tertiary)', fontWeight: isCurrent ? 600 : 400 }}>
                            {t(`learn.level.${lv.key}`, lv.titleFallback)}<br />
                            <span className="text-[10px] font-normal" style={{ color: 'var(--text-tertiary)' }}>
                                {t('learn.achievements.xp_value', '{xp} XP', { xp: lv.min.toLocaleString() })}{isCurrent && <> · {t('learn.achievements.you', 'you: {xp}').replace('{xp}', String(xp))}</>}
                            </span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function Counter({ value, label, color, valueColor }) {
    return (
        <div className="flex flex-col gap-[2px] items-end">
            <span className="text-[20px] font-semibold leading-6" style={{ color: valueColor }}>{value}</span>
            <span className="uppercase font-semibold" style={{ fontSize: 10, letterSpacing: '.08em', color }}>{label}</span>
        </div>
    );
}
function Divider() { return <div style={{ width: 1, background: 'var(--border-default)' }} />; }

function BadgeStatus({ t, locale, earned, locked, lockedReason, remaining, started, minutes }) {
    if (earned) {
        return (
            <span className="inline-flex items-center gap-1 font-medium" style={{ color: 'var(--learn-complete-ink)' }}>
                <CircleCheck style={{ width: 13, height: 13 }} aria-hidden="true" />
                {t('learn.achievements.earned_on', 'Earned {date}').replace('{date}', shortDate(earned.earnedAt, locale))}
            </span>
        );
    }
    if (locked) {
        return <span className="inline-flex items-center gap-1"><Lock style={{ width: 12, height: 12 }} aria-hidden="true" />{lockedReason}</span>;
    }
    if (started) {
        return <span style={{ color: 'var(--text-secondary)' }}>{t('learn.achievements.remaining', '{n} lessons to go').replace('{n}', String(remaining))}</span>;
    }
    return <span style={{ color: 'var(--text-secondary)' }}>{t('learn.achievements.not_started', 'Not started · {min} min').replace('{min}', String(Math.round(minutes)))}</span>;
}

function CertificateRow({ t, cert, last, busy, isComplete, onEarn, onView, onOpenCourse }) {
    const { done = 0, total = 0 } = cert.progress || {};
    const earned = cert.issued;
    // What is still missing: the courses of the certificate's track that are not complete.
    const missing = (cert.courseIds || []).map(getCourse).filter((c) => c && !isComplete(c));
    return (
        <div className="grid items-center gap-3" style={{ gridTemplateColumns: '32px minmax(0,1fr) auto', padding: last ? '10px 0 4px' : '10px 0', borderTop: '1px solid var(--border-default)' }} data-testid="certificate-row">
            <div className="grid place-items-center" aria-hidden="true" style={{ width: 32, height: 32, borderRadius: 8, background: earned ? 'color-mix(in srgb, var(--accent-primary) 18%, transparent)' : 'var(--bg-tertiary)', color: earned ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}>
                <Award style={{ width: 15, height: 15 }} />
            </div>
            <div className="min-w-0 flex flex-col gap-[5px]">
                <div className="font-medium truncate">{cert.title}</div>
                <div className="flex items-center gap-2">
                    <SegmentedProgress width={60} segments={earned ? repeatSegments(total || 1, SEGMENT.COMPLETE) : countSegments(done, total)} />
                    <span className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                        {earned
                            ? (cert.isPublic ? t('learn.cert.public', 'Public · shareable on LinkedIn') : t('learn.cert.earned', 'Earned — view, download or share'))
                            : cert.certificateId === 'cert-practitioner'
                                ? t('learn.achievements.cert_any', 'any {n} courses · {a} of {b}').replace('{n}', String(total)).replace('{a}', String(done)).replace('{b}', String(total))
                                : <>{t('learn.achievements.cert_progress', '{a} of {b} courses').replace('{a}', String(done)).replace('{b}', String(total))}{missing.length > 0 && <> · {t('learn.achievements.cert_missing', 'still: {courses}').replace('{courses}', missing.map((c) => `${c.icon} ${t(c.titleKey, c.titleFallback)}`).join(', '))}</>}</>}
                    </span>
                </div>
            </div>
            {earned ? (
                <SecondaryButton small onClick={() => onView(cert)}><Eye style={{ width: 12, height: 12 }} aria-hidden="true" />{t('learn.cert.view', 'View certificate')}</SecondaryButton>
            ) : cert.eligible ? (
                <PrimaryButton small onClick={() => onEarn(cert)} disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} /> : <Award style={{ width: 12, height: 12 }} aria-hidden="true" />}
                    {t('learn.cert.get', 'Get certified')}
                </PrimaryButton>
            ) : missing.length > 0 ? (
                <SecondaryButton small onClick={() => onOpenCourse(missing[0].id)}>{t('learn.achievements.cert_continue', 'Continue')}<ArrowRight style={{ width: 12, height: 12 }} aria-hidden="true" /></SecondaryButton>
            ) : (
                <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>{t('learn.achievements.cert_every_course', 'every course counts')}</span>
            )}
        </div>
    );
}
