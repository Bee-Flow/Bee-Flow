// @typecheck
/**
 * Login, Session & Setup Routes
 *
 * Handles: /my-permissions, /setup-status, /setup, /admin-login,
 * /settings, /user, /logout
 */

const express = require('express');
const router = express.Router();

const signupCaptcha = require('./signupCaptcha');

signupCaptcha.announce();

// Split by flow into auth/login/ modules. The mounting order below IS the
// original route registration order — route and middleware order are semantics.
router.use(require('./login/myPermissionsRoutes'));
router.use(require('./login/setupRoutes'));
router.use(require('./login/passwordLoginRoutes'));
router.use(require('./login/mfaLoginRoutes'));
// The security-key second factor, beside the code one it shares mfaPending with.
router.use(require('./securityKeys').loginRouter);
router.use(require('./login/passwordResetRoutes'));
router.use(require('./login/emailVerificationRoutes'));
router.use(require('./login/instanceSettingsRoutes'));
router.use(require('./login/currentUserRoutes'));
router.use(require('./login/ssoEncryptionRoutes'));
router.use(require('./login/profileRoutes'));
router.use(require('./login/signupIntakeRoutes'));
router.use(require('./login/signupPolicyRoutes'));
router.use(require('./login/signupRoutes'));
router.use(require('./login/inviteRoutes'));

module.exports = router;
