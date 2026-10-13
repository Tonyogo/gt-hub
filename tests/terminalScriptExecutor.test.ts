import {
  encodeScriptToBase64,
  generateScriptExecutionCommand,
} from '../frontend/src/utils/terminalScriptExecutor';

describe('terminalScriptExecutor', () => {
  it('correctly encodes multi-byte UTF-8 strings into Base64', () => {
    const text = 'echo "你好，世界！🚀"';
    const b64 = encodeScriptToBase64(text);
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    expect(decoded).toBe(text);
  });

  it('correctly handles special characters, quotes, and backticks', () => {
    const text = 'VAR="test"\necho `$VAR`\necho \'single\'\necho "double"';
    const b64 = encodeScriptToBase64(text);
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    expect(decoded).toBe(text);
  });

  it('generates bash-c evaluation command by default', () => {
    const script = 'echo "hello"';
    const cmd = generateScriptExecutionCommand(script);
    expect(cmd).toMatch(/^bash -c "\$\(echo '[A-Za-z0-9+/=]+' \| base64 -d\)"$/);
  });

  it('generates python3 -c command when interpreter is python3', () => {
    const script = 'print("hello")';
    const cmd = generateScriptExecutionCommand(script, 'python3');
    expect(cmd).toMatch(/^python3 -c "\$\(echo '[A-Za-z0-9+/=]+' \| base64 -d\)"$/);
  });

  it('generates node -e command when interpreter is node', () => {
    const script = 'console.log("hello")';
    const cmd = generateScriptExecutionCommand(script, 'node');
    expect(cmd).toMatch(/^node -e "\$\(echo '[A-Za-z0-9+/=]+' \| base64 -d\)"$/);
  });
});
