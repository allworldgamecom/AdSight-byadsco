export interface SecurityConfig {
  approvalPin: string;
  pinRequired: boolean;
}

function readEnvVar(
  env: NodeJS.ProcessEnv,
  key: string,
): string {
  return env[key]?.trim() ?? "";
}

/**
 * Resolve and validate security-sensitive runtime configuration.
 *
 * Production is fail-closed: OAuth approval PIN and JWT secret must both be
 * configured before the HTTP transport can start.
 */
export function resolveSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
): SecurityConfig {
  const isProduction = env.NODE_ENV === "production";
  const approvalPin = readEnvVar(env, "OAUTH_APPROVAL_PIN");
  const oauthSecret = readEnvVar(env, "OAUTH_SECRET");

  if (isProduction && !approvalPin) {
    throw new Error(
      "OAUTH_APPROVAL_PIN environment variable is required in production",
    );
  }

  if (isProduction && approvalPin.length < 4) {
    throw new Error("OAUTH_APPROVAL_PIN must be at least 4 characters in production");
  }

  if (isProduction && !oauthSecret) {
    throw new Error("OAUTH_SECRET environment variable is required in production");
  }

  return {
    approvalPin,
    pinRequired: isProduction || approvalPin.length > 0,
  };
}
