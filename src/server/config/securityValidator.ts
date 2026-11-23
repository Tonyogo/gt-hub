import logger from '../../utils/logger';
import { DEFAULT_ADMIN_SECRET_KEY } from './default';

export interface SecurityValidationOptions {
  nodeEnv?: string;
  secretKey?: string;
  allowInsecure?: boolean;
  exitHandler?: (code: number) => void;
}

export interface SecurityValidationResult {
  valid: boolean;
  warning?: string;
  error?: string;
}

export function validateSecurityConfig(options: SecurityValidationOptions = {}): SecurityValidationResult {
  const nodeEnv = options.nodeEnv !== undefined ? options.nodeEnv : process.env.NODE_ENV;
  const secretKey = (
    options.secretKey !== undefined
      ? options.secretKey
      : (process.env.ADMIN_SECRET_KEY || process.env.GT_KEY || DEFAULT_ADMIN_SECRET_KEY)
  ).trim();
  const allowInsecure = options.allowInsecure !== undefined
    ? options.allowInsecure
    : process.env.GT_ALLOW_INSECURE_NO_AUTH === 'true';
  const exitHandler = options.exitHandler || ((code: number) => process.exit(code));

  const isProduction = nodeEnv === 'production';

  if (isProduction && (!secretKey || secretKey === DEFAULT_ADMIN_SECRET_KEY)) {
    const isDefaultKey = secretKey === DEFAULT_ADMIN_SECRET_KEY;
    if (allowInsecure) {
      const reason = isDefaultKey
        ? `Default GT_KEY ("${DEFAULT_ADMIN_SECRET_KEY}")`
        : 'Running without GT_KEY';
      const warning = `[Security] WARNING: ${reason} in production! Insecure access explicitly enabled via GT_ALLOW_INSECURE_NO_AUTH=true.`;
      logger.warn(warning);
      return { valid: true, warning };
    }

    const error = isDefaultKey
      ? `[Security] FATAL: Default GT_KEY ("${DEFAULT_ADMIN_SECRET_KEY}") is not allowed in production mode. Set a secure GT_KEY in your environment, or set GT_ALLOW_INSECURE_NO_AUTH=true to explicitly allow default key access.`
      : '[Security] FATAL: GT_KEY is required in production mode. Set GT_KEY in your environment, or set GT_ALLOW_INSECURE_NO_AUTH=true to explicitly allow unauthenticated access.';
    logger.error(error);
    exitHandler(1);
    return { valid: false, error };
  }

  return { valid: true };
}
