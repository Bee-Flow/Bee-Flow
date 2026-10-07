/**
 * The parts of a record's page below its facts: the actions its status
 * allows, its related items (a risk's treatments, an audit's findings, a
 * framework's items — each with its own actions), and its history (a DSR's
 * timeline, a subject's earlier attestations).
 */

import React, { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTranslation } from "@/core/i18n";
import { useThemedStyles, type Theme } from "@/core/theme/ThemeProvider";
import {
    ActionMenu,
    Badge,
    Group,
    Icon,
    ListRow,
    NoteRow,
    SettingRow,
    tonePair,
    type Tone,
} from "@/shared/ui";

import { useRaw } from "../hooks/queries";
import type { ActionRunner } from "../hooks/useActionRunner";
import { formatValue, labelText } from "../model/fields";
import type {
    ActionSpec,
    Formatter,
    HistoryItem,
    Rec,
    RecordTone,
    RecordType,
} from "../model/types";

const MAX_HISTORY = 20;

const visible = (actions: readonly ActionSpec[] | undefined, rec: Rec) =>
    (actions ?? []).filter((a) => !a.when || a.when(rec));

export function ActionsGroup({
    type,
    rec,
    runner,
}: {
    type: RecordType;
    rec: Rec;
    runner: ActionRunner;
}) {
    const t = useTranslation();
    const actions = visible(type.actions, rec);
    if (!actions.length) return null;
    return (
        <Group title={t("common.actions", "Actions")}>
            {actions.map((a) => {
                const reason = a.disabledReason?.(rec);
                if (reason) {
                    return (
                        <ListRow
                            key={a.id}
                            testID={`action-${a.id}`}
                            title={labelText(a.label, t)}
                            subtitle={labelText(reason, t)}
                            leading={
                                a.icon ? (
                                    <Icon name={a.icon} size={18} />
                                ) : undefined
                            }
                            disabled
                            onPress={() => undefined}
                            chevron={false}
                        />
                    );
                }
                return (
                    <SettingRow
                        key={a.id}
                        testID={`action-${a.id}`}
                        label={labelText(a.label, t)}
                        icon={
                            a.icon ? (
                                <Icon name={a.icon} size={18} />
                            ) : undefined
                        }
                        destructive={a.danger}
                        disabled={runner.busy !== null}
                        onPress={() => void runner.run(a, rec)}
                    />
                );
            })}
        </Group>
    );
}

export function RelatedGroup({
    type,
    rec,
    fmt,
    runner,
}: {
    type: RecordType;
    rec: Rec;
    fmt: Formatter;
    runner: ActionRunner;
}) {
    const [open, setOpen] = useState<Rec | null>(null);
    const related = type.related;
    if (!related) return null;
    const raw = rec[related.key];
    const items = Array.isArray(raw) ? (raw as Rec[]) : [];
    const menu = open ? visible(related.actions, open) : [];
    return (
        <Group title={labelText(related.title, fmt.t)}>
            {items.length === 0 ? (
                <NoteRow>{labelText(related.empty, fmt.t)}</NoteRow>
            ) : null}
            {items.map((item, i) => {
                const meta = related.subtitleOf
                    ? related.subtitleOf(item, fmt, rec)
                    : related.fields
                          .map((f) => formatValue(f, item[f.key], fmt))
                          .filter(Boolean)
                          .join(" · ");
                const status = related.status?.(item, rec);
                return (
                    <ListRow
                        key={typeof item.id === "string" ? item.id : String(i)}
                        testID={`related-${i}`}
                        title={related.titleOf(item, fmt)}
                        subtitle={meta || undefined}
                        trailing={
                            status ? (
                                <Badge
                                    label={labelText(status.label, fmt.t)}
                                    tone={status.tone ?? "neutral"}
                                />
                            ) : undefined
                        }
                        chevron={Boolean(related.actions?.length)}
                        onPress={
                            related.actions?.length
                                ? () => setOpen(item)
                                : undefined
                        }
                    />
                );
            })}
            <ActionMenu
                visible={open !== null}
                onClose={() => setOpen(null)}
                title={open ? related.titleOf(open, fmt) : undefined}
                items={menu.map((a) => ({
                    id: a.id,
                    label: labelText(a.label, fmt.t),
                    icon: a.icon,
                    destructive: a.danger,
                    onPress: () => {
                        const item = open;
                        setOpen(null);
                        if (item) void runner.run(a, item);
                    },
                }))}
            />
        </Group>
    );
}

export function HistoryGroup({
    type,
    rec,
    fmt,
}: {
    type: RecordType;
    rec: Rec;
    fmt: Formatter;
}) {
    const history = type.history;
    const query = useRaw(history ? history.path(rec) : null, Boolean(history));
    if (!history) return null;
    const items =
        query.data === undefined ? null : history.select(query.data, fmt);
    let body: React.ReactNode;
    if (items === null)
        body = (
            <NoteRow>
                {query.isError
                    ? fmt.t(
                          "compliance.custom_history_failed",
                          "The history could not be read.",
                      )
                    : fmt.t("compliance.mob_loading", "Loading…")}
            </NoteRow>
        );
    else if (items.length === 0)
        body = (
            <NoteRow>
                {fmt.t(
                    "compliance.custom_history_empty",
                    "Nothing recorded yet.",
                )}
            </NoteRow>
        );
    else
        body = items
            .slice(0, MAX_HISTORY)
            .map((item) => <HistoryRow key={item.id} item={item} />);
    return <Group title={labelText(history.title, fmt.t)}>{body}</Group>;
}

function HistoryRow({ item }: { item: HistoryItem }) {
    const styles = useThemedStyles(makeStyles);
    const dot = item.tone ? (
        <View
            testID={`history-tone-${item.tone}`}
            style={[styles.dot, styles[item.tone]]}
        />
    ) : undefined;
    return (
        <ListRow
            title={item.title}
            subtitle={item.meta ?? undefined}
            leading={dot}
        />
    );
}

const makeStyles = (theme: Theme) => {
    const fill = (tone: RecordTone) => ({
        backgroundColor: tonePair(theme.colors, tone as Tone).raw,
    });
    return StyleSheet.create({
        dot: { width: 8, height: 8, borderRadius: 4 },
        success: fill("success"),
        warning: fill("warning"),
        error: fill("error"),
        info: fill("info"),
        neutral: fill("neutral"),
    });
};
