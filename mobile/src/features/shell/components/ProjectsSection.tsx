/**
 * The drawer's Projects section — the web Sidebar's ProjectsSection: a
 * collapsible PROJECTS heading, each project you own or are a member of (its
 * own icon — the stored emoji or Lucide name, 📁 when it has none — on a small
 * tile tinted in its colour, and "Shared" when it is someone else's), and
 * "All projects". At most DRAWER_LIST_CAP of them above "All projects": the
 * drawer's header is not windowed.
 *
 * Mounted only where the projects licence and switch allow and Simple Mode is
 * off; it renders nothing without a project (the web's "New project" entry
 * needs a create flow the phone does not have yet — the list screen is one
 * tap away through "All projects" in the map and search).
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useProjects } from '@/features/projects';
import { AppIcon, Badge, NavRow, SectionLabel, tint } from '@/shared/ui';

import { useDrawerActions } from '../hooks/drawerActions';
import { DRAWER_LIST_CAP } from '../model/nav';

const HEX = /^#[0-9a-fA-F]{6}$/;
/** The web's default project colour. */
const DEFAULT_COLOR = '#6366f1';

/** The web's 20px tile: the project's colour at 12.5% (`color + '20'`), its icon inside. */
function ProjectTile({ icon, color }: { icon: string | null | undefined; color: string | null | undefined }) {
    const styles = useThemedStyles(makeStyles);
    const hue = color && HEX.test(color) ? color : DEFAULT_COLOR;
    const fill = { backgroundColor: tint(hue, 12.5) };
    return (
        <View style={[styles.tile, fill]}>
            <AppIcon name={icon || '📁'} fallback="Folder" size={12} color={hue} />
        </View>
    );
}

export function ProjectsSection() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const { push } = useDrawerActions();
    const projects = useProjects({ staleTime: 60_000 }).data ?? [];
    const [expanded, setExpanded] = useState(true);
    if (projects.length === 0) return null;
    return (
        <View style={styles.section}>
            <SectionLabel
                label={t('sidebar.projects', 'Projects')}
                expanded={expanded}
                onPress={() => setExpanded((open) => !open)}
                testID="drawer-projects"
            />
            {expanded ? (
                <View style={styles.rows}>
                    {projects.slice(0, DRAWER_LIST_CAP).map((project) => (
                        <NavRow
                            key={project.id}
                            label={project.name}
                            leading={<ProjectTile icon={project.icon} color={project.color} />}
                            trailing={
                                project.permission && project.permission !== 'owner' ? (
                                    <Badge label={t('mobile.nav.shared', 'Shared')} tone="info" />
                                ) : undefined
                            }
                            onPress={() => push(`/projects/${encodeURIComponent(project.id)}`)}
                            testID={`drawer-project-${project.id}`}
                        />
                    ))}
                    <NavRow
                        label={t('sidebar.all_projects', 'All projects')}
                        icon="FolderOpen"
                        onPress={() => push('/projects')}
                    />
                </View>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    section: { marginTop: theme.spacing[2] } satisfies ViewStyle,
    rows: { gap: theme.spacing[0.5] } satisfies ViewStyle,
    // Tailwind's w-5 h-5 rounded: 20dp, a 4px corner that follows the roundness dial.
    tile: {
        width: 20,
        height: 20,
        borderRadius: Math.round(theme.radii.sm / 2),
        alignItems: 'center',
        justifyContent: 'center',
    } satisfies ViewStyle,
});
