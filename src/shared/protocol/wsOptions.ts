/**
 * Shared permessage-deflate compression configuration for terminal WebSocket streams.
 * Balances compression ratio, memory footprint, and low latency for small keystrokes.
 */
export const TERMINAL_WS_DEFLATE_OPTIONS = {
  zlibDeflateOptions: {
    chunkSize: 1024,
    memLevel: 7,
    level: 3, // Fast compression level
  },
  zlibInflateOptions: {
    chunkSize: 10 * 1024,
  },
  threshold: 1024, // Frames under 1024 bytes bypass compression to avoid latency
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
};
