import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ClaudeCodeProxy } from '../dist/index.js';

describe('Context Window Management', () => {
  let proxy;

  beforeEach(() => {
    process.env.CONTEXT_WINDOW_ENABLED = 'true';
    process.env.CONTEXT_WINDOW_LIMIT = '200000';
    process.env.CONTEXT_WINDOW_TRUNCATION_THRESHOLD = '0.8';
  });

  it('should estimate tokens from text using character-based heuristic', () => {
    proxy = new ClaudeCodeProxy();
    const estimateTokens = proxy.estimateTokens.bind(proxy);

    assert.strictEqual(estimateTokens(''), 0);
    assert.strictEqual(estimateTokens('test'), 1);
    assert.strictEqual(estimateTokens('a'.repeat(100)), 25);
    assert.strictEqual(estimateTokens('a'.repeat(1000)), 250);
  });

  it('should calculate message tokens correctly', () => {
    proxy = new ClaudeCodeProxy();
    const calculateMessageTokens = proxy.calculateMessageTokens.bind(proxy);

    assert.strictEqual(calculateMessageTokens([]), 0);

    const messages = [{ role: 'user', content: 'This is a test message' }];
    const tokens = calculateMessageTokens(messages);
    assert.ok(tokens > 0);
    assert.ok(tokens < 100);
  });

  it('should truncate messages when exceeding context window limit', () => {
    proxy = new ClaudeCodeProxy();
    const truncateMessagesToFit = proxy.truncateMessagesToFit.bind(proxy);

    // Each message ~370 chars = ~93 tokens
    const messageContent = 'This is a longer message that contains more text to increase token count. '.repeat(5);
    const messages = [];
    for (let i = 0; i < 100; i++) {
      messages.push({ role: 'user', content: messageContent });
    }

    const requestBody = JSON.stringify({
      model: 'claude-opus-4-6',
      messages,
      max_tokens: 4096
    });

    // 100 messages × 93 tokens = 9300 tokens
    // With limit 10000 and threshold 0.8, max allowed is 8000 tokens
    // 9300 > 8000, so truncation SHOULD occur
    const truncated = truncateMessagesToFit(requestBody, 10000, 0.8);
    const truncatedBody = JSON.parse(truncated);
    assert.ok(truncatedBody.messages.length < 100);
    assert.ok(truncatedBody.messages.length > 0);
    assert.strictEqual(truncatedBody.model, 'claude-opus-4-6');

    // With limit 15000 and threshold 0.8, max allowed is 12000 tokens
    // 9300 < 12000, so truncation should NOT occur
    const notTruncated = truncateMessagesToFit(requestBody, 15000, 0.8);
    const notTruncatedBody = JSON.parse(notTruncated);
    assert.strictEqual(notTruncatedBody.messages.length, 100);
  });

  it('should preserve system message during truncation', () => {
    proxy = new ClaudeCodeProxy();
    const truncateMessagesToFit = proxy.truncateMessagesToFit.bind(proxy);

    const messageContent = 'This is a message with enough content to trigger truncation when combined. '.repeat(3);
    const messages = [];
    for (let i = 0; i < 50; i++) {
      messages.push({ role: 'user', content: messageContent });
    }

    const requestBody = JSON.stringify({
      model: 'claude-opus-4-6',
      system: 'You are a helpful assistant with specific instructions.',
      messages,
      max_tokens: 4096
    });

    // 50 messages × 29 tokens each = ~1450 tokens, plus system message (~13 tokens)
    // With limit 4000 and threshold 0.5, max allowed is 2000 tokens
    // So truncation SHOULD occur
    const truncated = truncateMessagesToFit(requestBody, 4000, 0.5);
    const truncatedBody = JSON.parse(truncated);

    assert.strictEqual(truncatedBody.system, 'You are a helpful assistant with specific instructions.');
    assert.ok(truncatedBody.messages.length < 50);
  });

  it('should keep most recent messages when truncating', () => {
    proxy = new ClaudeCodeProxy();
    const truncateMessagesToFit = proxy.truncateMessagesToFit.bind(proxy);

    const messages = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: 'user',
        content: `Message index ${i} with additional text to increase token count. `.repeat(4)
      });
    }

    const requestBody = JSON.stringify({
      model: 'claude-opus-4-6',
      messages,
      max_tokens: 4096
    });

    // 50 messages × ~29 tokens each = ~1450 tokens
    // With limit 5000 and threshold 0.5, max allowed is 2500 tokens
    // With limit 5000 and threshold 0.2, max allowed is 1000 tokens - truncation SHOULD occur
    const truncated = truncateMessagesToFit(requestBody, 5000, 0.2);
    const truncatedBody = JSON.parse(truncated);

    assert.ok(truncatedBody.messages.length > 0);
    assert.ok(truncatedBody.messages.length < 50);

    // Verify last message is preserved (most recent)
    const lastOriginal = messages[messages.length - 1];
    const lastTruncated = truncatedBody.messages[truncatedBody.messages.length - 1];
    assert.deepStrictEqual(lastTruncated, lastOriginal);
  });

  it('should not truncate when within context window limit', () => {
    proxy = new ClaudeCodeProxy();
    const truncateMessagesToFit = proxy.truncateMessagesToFit.bind(proxy);

    const messages = [
      { role: 'user', content: 'Short message' },
      { role: 'assistant', content: 'Short response' }
    ];

    const requestBody = JSON.stringify({
      model: 'claude-opus-4-6',
      messages,
      max_tokens: 4096
    });

    const truncated = truncateMessagesToFit(requestBody, 200000, 0.8);
    const truncatedBody = JSON.parse(truncated);

    assert.strictEqual(truncatedBody.messages.length, 2);
  });

  it('should handle context window being disabled via config', () => {
    proxy = new ClaudeCodeProxy({ contextWindow: { enabled: false } });

    const config = proxy.config;
    assert.strictEqual(config.contextWindow?.enabled, false);
  });

  it('should use default context window values', () => {
    proxy = new ClaudeCodeProxy();

    const config = proxy.config;
    assert.strictEqual(config.contextWindow?.limit, 200000);
    assert.strictEqual(config.contextWindow?.truncationThreshold, 0.8);
  });

  it('should apply truncation via maybeTruncateForContextWindow with custom config', () => {
    proxy = new ClaudeCodeProxy({
      contextWindow: { enabled: true, limit: 8000, truncationThreshold: 0.8 }
    });

    const messages = [];
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: 'user',
        content: 'Large message content here to fill up the context window. '.repeat(5)
      });
    }

    const requestBody = JSON.stringify({
      model: 'claude-opus-4-6',
      messages,
      max_tokens: 4096
    });

    const maybeTruncate = proxy.maybeTruncateForContextWindow.bind(proxy);
    const result = maybeTruncate(requestBody);
    const resultBody = JSON.parse(result);

    // With limit 8000 and threshold 0.8, max is 6400 tokens
    // 100 messages × ~73 tokens each = ~7300 tokens, so truncation should occur
    assert.ok(resultBody.messages.length < 100);
  });

  it('should return original body when context window is disabled', () => {
    proxy = new ClaudeCodeProxy({ contextWindow: { enabled: false } });
    const maybeTruncate = proxy.maybeTruncateForContextWindow.bind(proxy);

    const messages = [];
    for (let i = 0; i < 100; i++) {
      messages.push({ role: 'user', content: 'x'.repeat(200) });
    }

    const requestBody = JSON.stringify({
      model: 'claude-opus-4-6',
      messages,
      max_tokens: 4096
    });

    const result = maybeTruncate(requestBody);
    const resultBody = JSON.parse(result);

    assert.strictEqual(resultBody.messages.length, 100);
  });

  it('should not truncate when enabled but under threshold', () => {
    proxy = new ClaudeCodeProxy({
      contextWindow: { enabled: true, limit: 50000, truncationThreshold: 0.8 }
    });

    const messages = [
      { role: 'user', content: 'Short message' },
      { role: 'assistant', content: 'Short response' }
    ];

    const requestBody = JSON.stringify({
      model: 'claude-opus-4-6',
      messages,
      max_tokens: 4096
    });

    const maybeTruncate = proxy.maybeTruncateForContextWindow.bind(proxy);
    const result = maybeTruncate(requestBody);
    const resultBody = JSON.parse(result);

    assert.strictEqual(resultBody.messages.length, 2);
  });
});
