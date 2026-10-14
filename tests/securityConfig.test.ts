import { validateSecurityConfig } from '../src/server/config/securityValidator';

describe('validateSecurityConfig', () => {
  it('fails in production mode when secretKey is empty and allowInsecure is not set', () => {
    let exitCode: number | null = null;
    const res = validateSecurityConfig({
      nodeEnv: 'production',
      secretKey: '',
      allowInsecure: false,
      exitHandler: (code: number) => { exitCode = code; },
    });

    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/GT_KEY is required in production/i);
    expect(exitCode).toBe(1);
  });

  it('allows empty secretKey in production if allowInsecure is true and emits warning', () => {
    let exitCode: number | null = null;
    const res = validateSecurityConfig({
      nodeEnv: 'production',
      secretKey: '',
      allowInsecure: true,
      exitHandler: (code: number) => { exitCode = code; },
    });

    expect(res.valid).toBe(true);
    expect(res.warning).toMatch(/GT_ALLOW_INSECURE_NO_AUTH/i);
    expect(exitCode).toBeNull();
  });

  it('passes in production mode when secretKey is provided', () => {
    let exitCode: number | null = null;
    const res = validateSecurityConfig({
      nodeEnv: 'production',
      secretKey: 'strong-secret-key',
      allowInsecure: false,
      exitHandler: (code: number) => { exitCode = code; },
    });

    expect(res.valid).toBe(true);
    expect(exitCode).toBeNull();
  });

  it('passes in development/test mode even when secretKey is empty', () => {
    let exitCode: number | null = null;
    const res = validateSecurityConfig({
      nodeEnv: 'development',
      secretKey: '',
      allowInsecure: false,
      exitHandler: (code: number) => { exitCode = code; },
    });

    expect(res.valid).toBe(true);
    expect(exitCode).toBeNull();
  });
});
