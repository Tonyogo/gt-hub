export interface ParsedCurlRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  insecure: boolean;
}

export function isCurlCommandText(input: string): boolean {
  if (!input) return false;
  return /^curl(?:\.exe)?\s+/i.test(input.trim());
}

function toBase64(str: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf-8').toString('base64');
  }
  if (typeof btoa !== 'undefined') {
    return btoa(unescape(encodeURIComponent(str)));
  }
  return '';
}

function tokenizeArgs(raw: string): string[] {
  const tokens: string[] = [];
  let currentToken = '';
  let hasToken = false;
  let i = 0;
  const n = raw.length;

  while (i < n) {
    const ch = raw[i];

    // Handle line continuations: \ or ^ followed by optional spaces and newline outside quotes
    if (ch === '\\' || ch === '^') {
      let k = i + 1;
      while (k < n && (raw[k] === ' ' || raw[k] === '\t')) {
        k++;
      }
      if (k < n && (raw[k] === '\r' || raw[k] === '\n')) {
        if (k < n && raw[k] === '\r') k++;
        if (k < n && raw[k] === '\n') k++;
        i = k;
        continue;
      }
    }

    // ANSI-C quoting: $'...'
    if (ch === '$' && i + 1 < n && raw[i + 1] === "'") {
      hasToken = true;
      i += 2; // skip $'
      while (i < n) {
        if (raw[i] === "'") {
          i++; // skip ending '
          break;
        }
        if (raw[i] === '\\' && i + 1 < n) {
          const next = raw[i + 1];
          if (next === 'n') { currentToken += '\n'; i += 2; }
          else if (next === 'r') { currentToken += '\r'; i += 2; }
          else if (next === 't') { currentToken += '\t'; i += 2; }
          else if (next === 'b') { currentToken += '\b'; i += 2; }
          else if (next === 'f') { currentToken += '\f'; i += 2; }
          else if (next === 'v') { currentToken += '\v'; i += 2; }
          else if (next === 'a') { currentToken += '\x07'; i += 2; }
          else if (next === '\\') { currentToken += '\\'; i += 2; }
          else if (next === "'") { currentToken += "'"; i += 2; }
          else if (next === '"') { currentToken += '"'; i += 2; }
          else if (next === 'x' && i + 3 <= n) {
            const hex = raw.slice(i + 2, i + 4);
            if (/^[0-9a-fA-F]{1,2}$/.test(hex)) {
              currentToken += String.fromCharCode(parseInt(hex, 16));
              i += 2 + hex.length;
            } else {
              currentToken += next;
              i += 2;
            }
          } else if (next === 'u' && i + 5 < n) {
            const hex = raw.slice(i + 2, i + 6);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              currentToken += String.fromCharCode(parseInt(hex, 16));
              i += 6;
            } else {
              currentToken += next;
              i += 2;
            }
          } else {
            currentToken += next;
            i += 2;
          }
        } else {
          currentToken += raw[i];
          i++;
        }
      }
      continue;
    }

    // Single quotes: '...'
    if (ch === "'") {
      hasToken = true;
      i++; // skip '
      while (i < n && raw[i] !== "'") {
        currentToken += raw[i];
        i++;
      }
      if (i < n && raw[i] === "'") {
        i++; // skip closing '
      }
      continue;
    }

    // Double quotes: "..."
    if (ch === '"') {
      hasToken = true;
      i++; // skip "
      while (i < n) {
        if (raw[i] === '"') {
          i++; // skip closing "
          break;
        }
        // Line continuation inside double quotes
        if (raw[i] === '\\' && i + 1 < n && (raw[i + 1] === '\r' || raw[i + 1] === '\n')) {
          i++;
          if (i < n && raw[i] === '\r') i++;
          if (i < n && raw[i] === '\n') i++;
          continue;
        }
        // Escapes inside double quotes
        if (raw[i] === '\\' && i + 1 < n) {
          const next = raw[i + 1];
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            currentToken += next;
            i += 2;
          } else {
            currentToken += '\\' + next;
            i += 2;
          }
        } else {
          currentToken += raw[i];
          i++;
        }
      }
      continue;
    }

    // Whitespace outside quotes
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(currentToken);
        currentToken = '';
        hasToken = false;
      }
      i++;
      continue;
    }

    // Escaped character outside quotes: \c
    if (ch === '\\' && i + 1 < n) {
      hasToken = true;
      currentToken += raw[i + 1];
      i += 2;
      continue;
    }

    // Regular character
    hasToken = true;
    currentToken += ch;
    i++;
  }

  if (hasToken) {
    tokens.push(currentToken);
  }

  return tokens;
}

export function parseCurlCommand(raw: string): ParsedCurlRequest | null {
  if (!raw || !isCurlCommandText(raw)) {
    return null;
  }

  const tokens = tokenizeArgs(raw.trim());
  if (tokens.length === 0) {
    return null;
  }

  const firstToken = tokens[0];
  if (!/^curl(?:\.exe)?$/i.test(firstToken)) {
    return null;
  }

  let explicitMethod: string | null = null;
  let hasGetFlag = false;
  let hasHeadFlag = false;
  let explicitUrl: string | null = null;
  let positionalUrl: string | null = null;
  const headers: Record<string, string> = {};
  const dataChunks: string[] = [];
  let insecure = false;

  const addHeader = (headerStr: string) => {
    const colonIndex = headerStr.indexOf(':');
    if (colonIndex !== -1) {
      const key = headerStr.slice(0, colonIndex).trim();
      const val = headerStr.slice(colonIndex + 1).trim();
      if (key) {
        headers[key] = val;
      }
    }
  };

  let i = 1;
  const count = tokens.length;

  while (i < count) {
    const token = tokens[i];

    // Method -X, --request
    if (token === '-X' || token === '--request') {
      if (i + 1 < count) {
        explicitMethod = tokens[++i].toUpperCase();
      }
      i++;
      continue;
    }
    if (token.startsWith('-X') && token.length > 2) {
      explicitMethod = token.slice(2).toUpperCase();
      i++;
      continue;
    }
    if (token.startsWith('--request=')) {
      explicitMethod = token.slice('--request='.length).toUpperCase();
      i++;
      continue;
    }

    // HEAD -I, --head
    if (token === '-I' || token === '--head') {
      hasHeadFlag = true;
      i++;
      continue;
    }

    // GET -G, --get
    if (token === '-G' || token === '--get') {
      hasGetFlag = true;
      i++;
      continue;
    }

    // Insecure -k, --insecure
    if (token === '-k' || token === '--insecure') {
      insecure = true;
      i++;
      continue;
    }

    // Headers -H, --header
    if (token === '-H' || token === '--header') {
      if (i + 1 < count) {
        addHeader(tokens[++i]);
      }
      i++;
      continue;
    }
    if (token.startsWith('-H') && token.length > 2) {
      addHeader(token.slice(2));
      i++;
      continue;
    }
    if (token.startsWith('--header=')) {
      addHeader(token.slice('--header='.length));
      i++;
      continue;
    }

    // User-Agent -A, --user-agent
    if (token === '-A' || token === '--user-agent') {
      if (i + 1 < count) {
        headers['User-Agent'] = tokens[++i];
      }
      i++;
      continue;
    }
    if (token.startsWith('-A') && token.length > 2) {
      headers['User-Agent'] = token.slice(2);
      i++;
      continue;
    }
    if (token.startsWith('--user-agent=')) {
      headers['User-Agent'] = token.slice('--user-agent='.length);
      i++;
      continue;
    }

    // Referer -e, --referer
    if (token === '-e' || token === '--referer') {
      if (i + 1 < count) {
        headers['Referer'] = tokens[++i];
      }
      i++;
      continue;
    }
    if (token.startsWith('-e') && token.length > 2) {
      headers['Referer'] = token.slice(2);
      i++;
      continue;
    }
    if (token.startsWith('--referer=')) {
      headers['Referer'] = token.slice('--referer='.length);
      i++;
      continue;
    }

    // Cookie -b, --cookie
    if (token === '-b' || token === '--cookie') {
      if (i + 1 < count) {
        headers['Cookie'] = tokens[++i];
      }
      i++;
      continue;
    }
    if (token.startsWith('-b') && token.length > 2) {
      headers['Cookie'] = token.slice(2);
      i++;
      continue;
    }
    if (token.startsWith('--cookie=')) {
      headers['Cookie'] = token.slice('--cookie='.length);
      i++;
      continue;
    }

    // Basic Auth -u, --user
    if (token === '-u' || token === '--user') {
      if (i + 1 < count) {
        headers['Authorization'] = `Basic ${toBase64(tokens[++i])}`;
      }
      i++;
      continue;
    }
    if (token.startsWith('-u') && token.length > 2) {
      headers['Authorization'] = `Basic ${toBase64(token.slice(2))}`;
      i++;
      continue;
    }
    if (token.startsWith('--user=')) {
      headers['Authorization'] = `Basic ${toBase64(token.slice('--user='.length))}`;
      i++;
      continue;
    }

    // Data / Body flags
    if (
      token === '-d' ||
      token === '--data' ||
      token === '--data-raw' ||
      token === '--data-ascii' ||
      token === '--data-binary' ||
      token === '--data-urlencode'
    ) {
      if (i + 1 < count) {
        dataChunks.push(tokens[++i]);
      }
      i++;
      continue;
    }
    if (token.startsWith('-d') && token.length > 2) {
      dataChunks.push(token.slice(2));
      i++;
      continue;
    }
    if (
      token.startsWith('--data=') ||
      token.startsWith('--data-raw=') ||
      token.startsWith('--data-ascii=') ||
      token.startsWith('--data-binary=') ||
      token.startsWith('--data-urlencode=')
    ) {
      const eqIdx = token.indexOf('=');
      dataChunks.push(token.slice(eqIdx + 1));
      i++;
      continue;
    }

    // --json
    if (token === '--json') {
      if (i + 1 < count) {
        dataChunks.push(tokens[++i]);
      }
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      if (!headers['Accept']) headers['Accept'] = 'application/json';
      i++;
      continue;
    }
    if (token.startsWith('--json=')) {
      dataChunks.push(token.slice('--json='.length));
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      if (!headers['Accept']) headers['Accept'] = 'application/json';
      i++;
      continue;
    }

    // Target URL flag --url
    if (token === '--url') {
      if (i + 1 < count) {
        explicitUrl = tokens[++i];
      }
      i++;
      continue;
    }
    if (token.startsWith('--url=')) {
      explicitUrl = token.slice('--url='.length);
      i++;
      continue;
    }

    // No-arg flags to ignore
    if (
      token === '-s' ||
      token === '-S' ||
      token === '-v' ||
      token === '-i' ||
      token === '-L' ||
      token === '--location' ||
      token === '--compressed' ||
      token === '--globoff' ||
      token === '--silent' ||
      token === '--show-error' ||
      token === '--verbose'
    ) {
      i++;
      continue;
    }

    // 1-arg flags to skip (consume argument)
    if (
      token === '-o' ||
      token === '--output' ||
      token === '-w' ||
      token === '--write-out' ||
      token === '-m' ||
      token === '--max-time' ||
      token === '--connect-timeout' ||
      token === '-x' ||
      token === '--proxy' ||
      token === '--cacert' ||
      token === '--cert' ||
      token === '--key' ||
      token === '-c' ||
      token === '--cookie-jar' ||
      token === '--resolve'
    ) {
      i += 2;
      continue;
    }

    // Combined short flags that don't take arguments, e.g. -sk, -vI
    if (token.startsWith('-') && !token.startsWith('--') && token.length > 2 && !token.includes('=')) {
      if (token.includes('k')) insecure = true;
      if (token.includes('I')) hasHeadFlag = true;
      if (token.includes('G')) hasGetFlag = true;
      i++;
      continue;
    }

    // Positional argument (possible URL)
    if (!token.startsWith('-')) {
      if (!positionalUrl) {
        positionalUrl = token;
      }
      i++;
      continue;
    }

    // Other flags
    i++;
  }

  let targetUrl = explicitUrl || positionalUrl;
  if (!targetUrl) {
    return null;
  }
  targetUrl = targetUrl.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = `http://${targetUrl}`;
  }

  let method: string;
  if (explicitMethod) {
    method = explicitMethod;
  } else if (hasHeadFlag) {
    method = 'HEAD';
  } else if (dataChunks.length > 0 && !hasGetFlag) {
    method = 'POST';
  } else {
    method = 'GET';
  }

  let body = dataChunks.join('&');
  if (body) {
    try {
      const parsed = JSON.parse(body);
      body = JSON.stringify(parsed, null, 2);
    } catch {
      // Keep as-is
    }
  }

  return {
    method,
    url: targetUrl,
    headers,
    body,
    insecure,
  };
}
