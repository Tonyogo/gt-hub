/**
 * Safely encodes a UTF-8 string to Base64 in both browser and Node.js environments.
 */
export function encodeScriptToBase64(content: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(content, 'utf-8').toString('base64');
  }
  // Browser standard UTF-8 Base64 conversion
  return window.btoa(unescape(encodeURIComponent(content)));
}

/**
 * Generates an isolated single-line execution command for the terminal PTY.
 * Avoids stdin piping so that interactive prompts (sudo, read -p) continue to work properly.
 */
export function generateScriptExecutionCommand(content: string, interpreter?: string): string {
  const base64Str = encodeScriptToBase64(content);
  const normalizedInterp = (interpreter || 'bash').trim().toLowerCase();

  if (normalizedInterp === 'python' || normalizedInterp === 'python3') {
    return `python3 -c "$(echo '${base64Str}' | base64 -d)"`;
  }

  if (normalizedInterp === 'node' || normalizedInterp === 'nodejs') {
    return `node -e "$(echo '${base64Str}' | base64 -d)"`;
  }

  return `bash -c "$(echo '${base64Str}' | base64 -d)"`;
}
