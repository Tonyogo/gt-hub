import logger from '../../utils/logger';

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
  const secretKey = (options.secretKey !== undefined ? options.secretKey : (process.env.GT_KEY || '')).trim();
  const allowInsecure = options.allowInsecure !== undefined
    ? options.allowInsecure
    : process.env.GT_ALLOW_INSECURE_NO_AUTH === 'true';
  const exitHandler = options.exitHandler || ((code: number) => process.exit(code));

  const isProduction = nodeEnv === 'production';

  if (isProduction && !secretKey) {
    if (allowInsecure) {
      const warning = '[Security] WARNING: Running in production without GT_KEY! Insecure access explicitly enabled via GT_ALLOW_INSECURE_NO_AUTH=true.';
      logger.warn(warning);
      return { valid: true, warning };
    }

    const error = '[Security] FATAL: GT_KEY is required in production mode. Set GT_KEY in your environment, or set GT_ALLOW_INSECURE_NO_AUTH=true to explicitly allow unauthenticated access.';
    logger.error(error);
    exitHandler(1);
    return { valid: false, error };
  }

  return { valid: true };
}
