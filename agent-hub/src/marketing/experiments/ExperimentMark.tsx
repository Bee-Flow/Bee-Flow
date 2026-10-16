import { useEffect } from 'react';
import { startGoalTracking, trackView } from './track';

/** Renders nothing; reports that this view of the block took part in an experiment. */
export default function ExperimentMark({ experiment, variant }: { experiment: string; variant: string }) {
    useEffect(() => {
        trackView(experiment, variant);
        return startGoalTracking();
    }, [experiment, variant]);
    return null;
}
