// English GUI defaults — namespace "reset": every key whose part before the first "." is "reset".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    'reset.title': 'Reset your password',
    'reset.forgot_title': 'Forgot your password?',
    'reset.forgot_desc': "Enter your email and we'll send you a link to reset your password.",
    'reset.email': 'Email',
    'reset.send_link': 'Send reset link',
    'reset.check_email': "If an account exists for that email, we've sent a password reset link. Check your inbox.",
    'reset.back_to_signin': 'Back to sign in',
    'reset.choose_new': 'Choose a new password for your account.',
    'reset.new_password': 'New password',
    'reset.confirm_password': 'Confirm new password',
    'reset.set_password': 'Set new password',
    'reset.success': 'Your password has been reset. You can now sign in with your new password.',
    'reset.go_signin': 'Go to sign in',
    'reset.min_length': 'Password must be at least 8 characters',
    'reset.failed': 'Failed to reset password.',
};
