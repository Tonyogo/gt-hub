import { parseRangeHeader, RangeParseResult } from '../src/terminal/utils/rangeParser';

describe('Range Parser Utility Tests', () => {
  const totalSize = 1000; // 1000 bytes (0-999)

  test('returns null when range header is not present', () => {
    expect(parseRangeHeader(undefined, totalSize)).toBeNull();
    expect(parseRangeHeader('', totalSize)).toBeNull();
  });

  test('returns null when range header format is invalid', () => {
    expect(parseRangeHeader('items=0-10', totalSize)).toBeNull();
    expect(parseRangeHeader('bytes=', totalSize)).toBeNull();
    expect(parseRangeHeader('bytes=abc-def', totalSize)).toBeNull();
  });

  test('correctly parses closed range bytes=0-499', () => {
    const res = parseRangeHeader('bytes=0-499', totalSize);
    expect(res).toEqual({
      status: 'valid',
      range: {
        start: 0,
        end: 499,
        length: 500,
        totalSize: 1000,
      },
    });
  });

  test('correctly parses open-ended range bytes=500-', () => {
    const res = parseRangeHeader('bytes=500-', totalSize);
    expect(res).toEqual({
      status: 'valid',
      range: {
        start: 500,
        end: 999,
        length: 500,
        totalSize: 1000,
      },
    });
  });

  test('correctly parses suffix range bytes=-300 (last 300 bytes)', () => {
    const res = parseRangeHeader('bytes=-300', totalSize);
    expect(res).toEqual({
      status: 'valid',
      range: {
        start: 700,
        end: 999,
        length: 300,
        totalSize: 1000,
      },
    });
  });

  test('clamps suffix range when requested length exceeds totalSize', () => {
    const res = parseRangeHeader('bytes=-1500', totalSize);
    expect(res).toEqual({
      status: 'valid',
      range: {
        start: 0,
        end: 999,
        length: 1000,
        totalSize: 1000,
      },
    });
  });

  test('clamps end byte when requested end exceeds totalSize - 1', () => {
    const res = parseRangeHeader('bytes=200-2500', totalSize);
    expect(res).toEqual({
      status: 'valid',
      range: {
        start: 200,
        end: 999,
        length: 800,
        totalSize: 1000,
      },
    });
  });

  test('returns unsatisfiable when start byte >= totalSize', () => {
    const res = parseRangeHeader('bytes=1000-', totalSize);
    expect(res).toEqual({
      status: 'unsatisfiable',
      totalSize: 1000,
    });
  });

  test('returns unsatisfiable when start > end', () => {
    const res = parseRangeHeader('bytes=600-500', totalSize);
    expect(res).toEqual({
      status: 'unsatisfiable',
      totalSize: 1000,
    });
  });

  test('returns unsatisfiable when totalSize is 0', () => {
    const res = parseRangeHeader('bytes=0-10', 0);
    expect(res).toEqual({
      status: 'unsatisfiable',
      totalSize: 0,
    });
  });
});
