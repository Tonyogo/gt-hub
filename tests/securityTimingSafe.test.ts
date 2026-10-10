import { safeCompareSecret } from '../src/shared/utils/security';

describe('safeCompareSecret', () => {
  it('returns true when expected secret is empty or unset (dev mode)', () => {
    expect(safeCompareSecret('any-key', '')).toBe(true);
    expect(safeCompareSecret('', '')).toBe(true);
    expect(safeCompareSecret(undefined, '')).toBe(true);
    expect(safeCompareSecret(null, '')).toBe(true);
  });

  it('returns true when provided secret exactly matches expected secret', () => {
    expect(safeCompareSecret('my-secret-key-123', 'my-secret-key-123')).toBe(true);
    expect(safeCompareSecret('k', 'k')).toBe(true);
  });

  it('returns false when provided secret does not match', () => {
    expect(safeCompareSecret('wrong-key', 'my-secret-key-123')).toBe(false);
    expect(safeCompareSecret('my-secret-key-124', 'my-secret-key-123')).toBe(false);
  });

  it('returns false when provided secret has different length', () => {
    expect(safeCompareSecret('short', 'much-longer-secret-key')).toBe(false);
    expect(safeCompareSecret('much-longer-secret-key', 'short')).toBe(false);
  });

  it('returns false when provided secret is invalid type', () => {
    expect(safeCompareSecret(undefined, 'my-secret')).toBe(false);
    expect(safeCompareSecret(null, 'my-secret')).toBe(false);
    expect(safeCompareSecret(12345, 'my-secret')).toBe(false);
    expect(safeCompareSecret(['key'], 'my-secret')).toBe(false);
    expect(safeCompareSecret({}, 'my-secret')).toBe(false);
  });

  it('returns false when expected is not a string but non-empty', () => {
    expect(safeCompareSecret('test', null)).toBe(false);
    expect(safeCompareSecret('test', undefined)).toBe(false);
  });
});
