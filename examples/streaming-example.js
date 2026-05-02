#!/usr/bin/env node
/**
 * Streaming example for Claude Code Proxy
 *
 * This example demonstrates how to use streaming responses
 * through the proxy server.
 */

async function streamingExample() {
  console.log('Claude Code Proxy - Streaming Example\n');

  try {
    const response = await fetch('http://127.0.0.1:4181/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || 'your-api-key-here',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: 'Count from 1 to 5, with a brief explanation for each number.'
          }
        ],
        max_tokens: 200,
        stream: true, // Enable streaming
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    console.log('Streaming response:\n');

    // Read the stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log('\n\n✅ Stream completed!');
            return;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              process.stdout.write(parsed.delta.text);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  }
}

// Run the example
streamingExample();
