package expo.modules.beeflowargon2

import android.util.Base64
import com.lambdapioneer.argon2kt.Argon2Kt
import com.lambdapioneer.argon2kt.Argon2Mode
import com.lambdapioneer.argon2kt.Argon2Version
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Argon2id, natively.
 *
 * The JavaScript side (src/crypto/opaque/ksf.ts) treats this as an optional
 * accelerator: it verifies the result against an RFC 9106 test vector on first
 * use and falls back to the pure-JS implementation if the module is absent or
 * disagrees. That means a build where this fails to load is slow, not broken —
 * and a build where it is subtly WRONG cannot silently derive the wrong key,
 * which is the failure that would matter.
 *
 * Arguments cross the bridge as standard base64 rather than as typed arrays.
 * The payloads are tiny (a 64-byte OPRF output and a 16-byte salt), so the
 * encoding costs nothing measurable, and it removes any question about how a
 * given Expo Modules version marshals a ByteArray.
 *
 * `AsyncFunction`, not `Function`: at 64 MiB this takes tens of milliseconds
 * and allocates 64 MiB, and neither belongs on the JS thread.
 */
class BeeFlowArgon2Module : Module() {
    override fun definition() = ModuleDefinition {
        Name("BeeFlowArgon2")

        AsyncFunction("argon2id") {
            passwordBase64: String,
            saltBase64: String,
            iterations: Int,
            memoryKiB: Int,
            parallelism: Int,
            outputLength: Int,
            ->
            val password = Base64.decode(passwordBase64, Base64.NO_WRAP)
            val salt = Base64.decode(saltBase64, Base64.NO_WRAP)

            val result = Argon2Kt().hash(
                mode = Argon2Mode.ARGON2_ID,
                password = password,
                salt = salt,
                tCostInIterations = iterations,
                mCostInKibibyte = memoryKiB,
                parallelism = parallelism,
                hashLengthInBytes = outputLength,
                // 0x13. The only version OPAQUE implementations use; naming it
                // explicitly means a library default change cannot alter the
                // derived key underneath us.
                version = Argon2Version.V13,
            )

            Base64.encodeToString(result.rawHashAsByteArray(), Base64.NO_WRAP)
        }
    }
}
