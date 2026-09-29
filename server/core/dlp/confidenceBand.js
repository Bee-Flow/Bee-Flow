// @typecheck
/**
 * Confidence → category band for the interactive DLP preview.
 *
 * A raw score ("0.87") means nothing to an end user and the direction is
 * counter-intuitive — the same reasoning `PiiSensitivityPicker` already
 * applies to the org's detection threshold (Low/Balanced/High sensitivity
 * instead of a percentage). This mirrors that: the client renders category +
 * band (color/intensity), never the number.
 *
 * Bands are anchored to the org's own `piiDetectionConfidenceThreshold`
 * rather than a fixed cutoff, so "high confidence" means the same thing here
 * that it means in the sensitivity picker — and so categories with very
 * different per-category floors in the guard (e.g. Person ~0.40 vs.
 * MedicalCondition ~0.65) aren't all judged against one arbitrary bar.
 */

const DEFAULT_PII_CONFIDENCE_THRESHOLD = 0.7;

/**
 * @param {number|null|undefined} confidence  Raw score from the guard, or
 *   absent for custom terms / manually-added spans (which carry no score).
 * @param {{piiDetectionConfidenceThreshold?: number}|null} orgShieldConfig
 * @returns {'high'|'medium'|'low'|null}
 */
function bandForConfidence(confidence, orgShieldConfig) {
    if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
    const anchor = typeof orgShieldConfig?.piiDetectionConfidenceThreshold === 'number'
        ? orgShieldConfig.piiDetectionConfidenceThreshold
        : DEFAULT_PII_CONFIDENCE_THRESHOLD;
    if (confidence >= anchor + 0.15) return 'high';
    if (confidence >= anchor) return 'medium';
    return 'low';
}

module.exports = { bandForConfidence, DEFAULT_PII_CONFIDENCE_THRESHOLD };
