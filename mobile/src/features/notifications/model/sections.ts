/**
 * The inbox's sections: today, this week, older — in that order, and only the
 * ones that have something in them. The order within a section is the
 * server's (newest first).
 */

import { BUCKET_LABELS, bucketFor, type TimeBucket } from './format';
import type { AppNotification } from './types';

const BUCKET_ORDER: TimeBucket[] = ['today', 'this_week', 'older'];

export interface NotificationSection {
    key: TimeBucket;
    title: string;
    data: AppNotification[];
}

export function sectionsByAge(notifications: readonly AppNotification[]): NotificationSection[] {
    const buckets = new Map<TimeBucket, AppNotification[]>();
    for (const item of notifications) {
        const bucket = bucketFor(item.created_at);
        const list = buckets.get(bucket);
        if (list) list.push(item);
        else buckets.set(bucket, [item]);
    }
    return BUCKET_ORDER.filter((bucket) => (buckets.get(bucket)?.length ?? 0) > 0).map((bucket) => ({
        key: bucket,
        title: BUCKET_LABELS[bucket],
        data: buckets.get(bucket) ?? [],
    }));
}
