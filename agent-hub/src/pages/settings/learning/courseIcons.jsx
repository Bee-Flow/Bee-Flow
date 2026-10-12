import {
    Bot, BookOpen, Boxes, Compass, Crown, Gauge, GraduationCap, Handshake, History,
    KeyRound, LayoutGrid, MessageSquareText, Mic, SearchCheck, Shield, ShieldCheck,
    SlidersHorizontal, Sparkles, Table2, Users, Workflow,
} from 'lucide-react';

/**
 * A lucide glyph per course — the Learning Center's round-3 replacement for
 * the catalog's emoji.
 *
 * Emoji lost on two counts once the screen became a table. They render in the
 * platform's own colours, so a row of them fights every other signal the page
 * uses colour for (gold = mastered, green = complete, accent = current); and
 * their shapes are unrelated to each other, so a column of them scans as
 * decoration rather than as a set.
 *
 * Where a course teaches a feature, the glyph is THE PRODUCT'S OWN glyph for
 * that feature, read off components/admin/Studio/studioApps.jsx — so the row
 * that teaches Datatables wears the icon the learner will look for in the rail
 * ten minutes later. That is the whole point of the change, and the reason
 * this is a mapping rather than a decorative choice per course.
 *
 * The emoji stay in the catalog. They are still what the badge wears on the
 * Achievements screen, where colour and personality are the content.
 */
const BY_COURSE = Object.freeze({
    // ── Everyday work ────────────────────────────────────────────────────
    'course-foundations': Compass,
    'course-prompting': MessageSquareText,
    'course-privacy-everyday': ShieldCheck,
    'course-power': SlidersHorizontal,
    'course-cowork': Handshake,
    'course-research': SearchCheck,
    'course-meeting-notes': Mic,          // studioApps: meetingNotes

    // ── Building ─────────────────────────────────────────────────────────
    'course-build-agent': Bot,            // studioApps: agents
    'course-agent-knowledge': BookOpen,   // studioApps: knowledge
    'course-skills-automation': Sparkles, // studioApps: skills
    'course-automations-mastery': Workflow,
    'course-automations-production': History,// studioApps: runs
    'course-data-and-forms': Table2,      // studioApps: datatables
    'course-apps': LayoutGrid,            // studioApps: apps
    'course-playbooks-solutions': Boxes,  // studioApps: solutions

    // ── Running the workspace ────────────────────────────────────────────
    'course-admin-essentials': Users,
    'course-admin-privacy-shield': Shield,
    'course-admin-trust': KeyRound,
    'course-admin-operations': Gauge,

    // ── Capstone ─────────────────────────────────────────────────────────
    'course-hive-master': Crown,
});

/**
 * The glyph for a course. Org-authored courses are not in the map and get the
 * graduation cap — deliberately the Learning Center's own mark, so an org
 * course reads as "a course" rather than borrowing a feature's identity.
 */
export function courseIcon(courseId) {
    return BY_COURSE[courseId] || GraduationCap;
}

export const COURSE_ICONS = BY_COURSE;

/**
 * The glyph as a component.
 *
 * `const Icon = courseIcon(id)` inside a render body is a stable reference —
 * the map is frozen — but it reads to both a linter and a reviewer as a
 * component conjured per render, so the lookup is done in here instead.
 */
export default function CourseIcon({ courseId, size = 16, style, className, ...rest }) {
    // A property read, not a call: the glyphs are module-level constants in a
    // frozen map, so the reference is stable across renders and React keeps the
    // element's identity. (Written as a lookup rather than through courseIcon()
    // so that is legible to the linter as well as to a reader.)
    const Glyph = BY_COURSE[courseId] || GraduationCap;
    return <Glyph className={className} style={{ width: size, height: size, flexShrink: 0, ...style }} aria-hidden="true" {...rest} />;
}
