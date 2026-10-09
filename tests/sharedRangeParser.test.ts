import {
  parseRangeHeader,
  applyRangeHeaders,
  applyUnsatisfiableHeaders,
  RangeParseResult,
} from '../src/shared/utils/rangeParser';

describe('Shared Range Parser Utility Tests', () => {
  const totalSize = 1000;

  test('returns null for missing or invalid range header', () => {
    expect(parseRangeHeader(undefined, totalSize)).toBeNull();
    expect(parseRangeHeader(null, totalSize)).toBeNull();
    expect(parseRangeHeader('', totalSize)).toBeNull();
    expect(parseRangeHeader('invalid', totalSize)).toBeNull();
    expect(parseRangeHeader('bytes=', totalSize)).toBeNull();
    expect(parseRangeHeader('bytes=0-10,20-30', totalSize)).toBeNull();
  });

  test('returns unsatisfiable if totalSize <= 0', () => {
    expect(parseRangeHeader('bytes=0-100', 0)).toEqual({
      status: 'unsatisfiable',
      totalSize: 0,
    });
  });

  test('parses closed range', () => {
    const res = parseRangeHeader('bytes=100-200', totalSize);
    expect(res).toEqual({
      status: 'valid',
      range: {
        start: 100,
        end: 200,
        length: 101,
        totalSize: 1000,
      },
    });
  });

  test('parses open-ended range', () => {
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

  test('parses suffix range', () => {
    const res = parseRangeHeader('bytes=-200', totalSize);
    expect(res).toEqual({
      status: 'valid',
      range: {
        start: 800,
        end: 999,
        length: 200,
        totalSize: 1000,
      },
    });
  });

  test('applies response headers correctly', () => {
    const headers: Record<string, any> = {};
    let statusCode = 0;
    const res: any = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      setHeader: (name: string, value: any) => {
        headers[name] = value;
      },
    };

    applyRangeHeaders(res, { start: 0, end: 499, length: 500, totalSize: 1000 }, 'test file.txt');
    expect(statusCode).toBe(206);
    expect(headers['Accept-Ranges']).toBe('bytes');
    expect(headers['Content-Range']).toBe('bytes 0-499/1000');
    expect(headers['Content-Length']).toBe(500);
    expect(headers['Content-Disposition']).toBe('attachment; filename="test%20file.txt"');

    applyUnsatisfiableHeaders(res, 1000);
    expect(statusCode).toBe(416);
    expect(headers['Content-Range']).toBe('bytes */1000');
  });
});
