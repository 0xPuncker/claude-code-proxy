#!/usr/bin/env node
/**
 * Programmatic usage example for Claude Code Proxy
 *
 * This example demonstrates how to use the proxy as a library
 * in your own Node.js applications.
 */

import { ClaudeCodeProxy } from '../src/index.js';

// Create a custom proxy configuration
const proxy = new ClaudeCodeProxy({
  port: 4182, // Use a different port
  logLevel: 'debug', // Enable debug logging
  zai: {
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKey: process.env.ZAI_API_KEY || '',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },
  modelFallbackMap: {
    'custom-model-1': 'claude-sonnet-4-20250514',
    'custom-model-2': 'claude-haiku-4-5-20251001',
  },
  fallbackOnCodes: [429, 503, 502],
});

// Start the proxy server
proxy.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down proxy server...');
  proxy.stop();
  process.exit(0);
});

console.log('✅ Proxy server started on http://localhost:4182');
console.log('Press Ctrl+C to stop the server');

// Keep the process running
process.stdin.resume();
