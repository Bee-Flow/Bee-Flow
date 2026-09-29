/**
 * CMS builder — model capability profiles.
 *
 * The classification bands and per-profile knobs (promptVariant /
 * temperature / maxIterations / effortSchedule) are model-generic and
 * centralised in automation/builderModelProfiles.js — RE-EXPORTED here
 * (never duplicated) so all three builders stay in lockstep, exactly like
 * appStudio/builderModelProfiles.js does.
 *
 * Unlike App Studio there is NO reduced 'core' tool subset: the CMS tool
 * roster is a closed set of 11, already small enough for Haiku/mini-class
 * models to pick from reliably.
 */

'use strict';

const {
    classifyModel,
    getProfile,
    getProfileForModel,
    effortForIteration,
} = require('../automation/builderModelProfiles');

module.exports = {
    classifyModel,
    getProfile,
    getProfileForModel,
    effortForIteration,
};
