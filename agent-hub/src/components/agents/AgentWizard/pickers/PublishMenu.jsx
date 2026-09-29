/**
 * PublishMenu — compatibility path. The implementation moved to
 * `components/shared/VisibilityCapsule.jsx` (Track 0.3 of the builder
 * redesign) so every section can mount the same Personal / Organisation /
 * Groups control. Existing imports keep working; new code imports
 * VisibilityCapsule directly.
 */
export {
    default,
    PERSONAL,
    ORG,
    GROUPS,
    audienceModeOf,
    makeGroupNamer,
    joinAudienceNames,
    audienceLabel,
    useAudienceActions,
    GroupChecklist,
} from '../../../shared/VisibilityCapsule';
