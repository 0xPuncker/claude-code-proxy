#!/usr/bin/env node
/**
 * Basic usage example for Claude Code Proxy
 *
 * This example demonstrates how to use the proxy server
 * to make requests to the Claude API with automatic failover.
 */

// Make sure the proxy server is running first
// Run: npm start or node dist/index.js

async function basicExample() {
  console.log('Claude Code Proxy - Basic Usage Example\n');

  try {
    const response = await fetch('http://localhost:4181/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || 'your-api-key-here',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', // Will be mapped to claude-sonnet-4-20250514
        messages: [
          {
            role: 'user',
            content: 'Hello! Can you explain what you do in one sentence?'
          }
        ],
        max_tokens: 100,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log('Response:', data.content[0].text);
    console.log('\n✅ Example completed successfully!');
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Run the example
basicExample();
