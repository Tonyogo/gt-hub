import { isCurlCommandText, parseCurlCommand } from '../frontend/src/utils/curlParser';

describe('curlParser utility', () => {
  it('identifies valid curl command strings via isCurlCommandText', () => {
    expect(isCurlCommandText('curl https://api.example.com/v1')).toBe(true);
    expect(isCurlCommandText('  curl -X POST http://127.0.0.1:8080/login ')).toBe(true);
    expect(isCurlCommandText('curl.exe "http://localhost:3000"')).toBe(true);
    expect(isCurlCommandText('http://127.0.0.1:3000/api')).toBe(false);
    expect(isCurlCommandText('')).toBe(false);
  });

  it('parses Chrome DevTools multiline bash curl with ANSI-C $ quoting, headers, body, and --insecure', () => {
    const cmd = `curl 'https://127.0.0.1:8443/api/v1/tasks' \\
  -H 'Accept: application/json' \\
  -H $'Content-Type: application/json; charset=UTF-8' \\
  -H 'Authorization: Bearer secret-token' \\
  --data-raw $'{"name":"demo","count":3}' \\
  --compressed \\
  --insecure`;

    const parsed = parseCurlCommand(cmd);
    expect(parsed).not.toBeNull();
    expect(parsed!.method).toBe('POST');
    expect(parsed!.url).toBe('https://127.0.0.1:8443/api/v1/tasks');
    expect(parsed!.insecure).toBe(true);
    expect(parsed!.headers['Accept']).toBe('application/json');
    expect(parsed!.headers['Content-Type']).toBe('application/json; charset=UTF-8');
    expect(parsed!.headers['Authorization']).toBe('Bearer secret-token');
    expect(JSON.parse(parsed!.body)).toEqual({ name: 'demo', count: 3 });
  });

  it('parses explicit -X/--request, -I/--head, -u Basic auth, -b cookie, -A user-agent, and --json', () => {
    const putCmd = `curl -X PUT --url "http://localhost:3000/items/42" -u admin:123456 -A "CustomAgent/1.0" -b "sid=abc" -d "status=active" -k`;
    const parsedPut = parseCurlCommand(putCmd);
    expect(parsedPut).not.toBeNull();
    expect(parsedPut!.method).toBe('PUT');
    expect(parsedPut!.url).toBe('http://localhost:3000/items/42');
    expect(parsedPut!.insecure).toBe(true);
    expect(parsedPut!.headers['User-Agent']).toBe('CustomAgent/1.0');
    expect(parsedPut!.headers['Cookie']).toBe('sid=abc');
    expect(parsedPut!.headers['Authorization']).toBe(`Basic ${Buffer.from('admin:123456').toString('base64')}`);
    expect(parsedPut!.body).toBe('status=active');

    const headCmd = `curl -I https://example.com/health`;
    const parsedHead = parseCurlCommand(headCmd);
    expect(parsedHead?.method).toBe('HEAD');
    expect(parsedHead?.url).toBe('https://example.com/health');

    const jsonCmd = `curl --json '{"hello":"world"}' http://localhost:4000/webhook`;
    const parsedJson = parseCurlCommand(jsonCmd);
    expect(parsedJson?.method).toBe('POST');
    expect(parsedJson?.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(parsedJson!.body)).toEqual({ hello: 'world' });
  });

  it('handles Windows CMD ^ line continuations and returns null on non-curl or URL-less input', () => {
    const winCmd = `curl "http://127.0.0.1:8000/api" ^\r\n  -H "X-Test: 1"`;
    const parsed = parseCurlCommand(winCmd);
    expect(parsed).not.toBeNull();
    expect(parsed!.url).toBe('http://127.0.0.1:8000/api');
    expect(parsed!.headers['X-Test']).toBe('1');

    expect(parseCurlCommand('not a curl command')).toBeNull();
    expect(parseCurlCommand('curl -X POST')).toBeNull();
  });

  it('joins multiple -d flags with & and supports -G to keep GET method', () => {
    const multiCmd = `curl http://localhost:8080/submit -d "foo=1" -d "bar=2"`;
    const parsedMulti = parseCurlCommand(multiCmd);
    expect(parsedMulti).not.toBeNull();
    expect(parsedMulti!.method).toBe('POST');
    expect(parsedMulti!.body).toBe('foo=1&bar=2');

    const getCmd = `curl -G http://localhost:8080/query -d "q=search"`;
    const parsedGet = parseCurlCommand(getCmd);
    expect(parsedGet).not.toBeNull();
    expect(parsedGet!.method).toBe('GET');
  });

  it('prepends http:// if scheme is missing', () => {
    const parsed = parseCurlCommand('curl localhost:5000/ping');
    expect(parsed).not.toBeNull();
    expect(parsed!.url).toBe('http://localhost:5000/ping');
  });

  it('pretty-prints json body when valid json', () => {
    const parsed = parseCurlCommand('curl -d \'{"a":1,"b":[2,3]}\' http://localhost:3000');
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2));
  });
});
