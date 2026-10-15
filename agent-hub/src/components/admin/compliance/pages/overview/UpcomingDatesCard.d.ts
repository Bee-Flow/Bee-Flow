// Types for the Overview's upcoming-dates card (UpcomingDatesCard.jsx).
import type { ReactElement } from 'react';

export interface UpcomingDatesCardProps {
    milestones: unknown[] | null;
    failed?: boolean;
    onOpenCalendar?: () => void;
    now?: number | Date;
    limit?: number;
    testId?: string;
}

export default function UpcomingDatesCard(props: UpcomingDatesCardProps): ReactElement;
