import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeProxy } from "../dist/index.js";

function createProxy(overrides = {}) {
  return new ClaudeCodeProxy({
    port: 0,
    logLevel: "silent",
    anthropic: {
      apiKey: "anthropic-test-key",
    },
    zai: {
      apiKey: "zai-test-key",
    },
    openrouter: {
      apiKey: "openrouter-test-key",
    },
    claudeSubscription: {
      enabled: true,
      credentialsPath: "test-credentials.json",
    },
    ...overrides,
  });
}

function jsonResponse(status, body = {}) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

describe("Claude Code Proxy fallback chain", () => {
  it("stops at the Claude subscription when it succeeds", async () => {
    const proxy = createProxy();
    const providersCalled = [];

    proxy.providerHealth.getBestProvider = () => "anthropic";
    proxy.requestProvider = async (provider) => {
      providersCalled.push(provider);
      return { response: jsonResponse(429, { error: { message: "rate limited" } }), errorType: "rate_limit" };
    };
    proxy.trySubscriptionRequest = async () => jsonResponse(200, { id: "subscription-ok" });

    const response = await proxy.proxyRequest(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      }),
      { "content-type": "application/json" },
      "/v1/messages",
      "POST",
    );

    assert.equal(response.status, 200);
    assert.deepEqual(providersCalled, ["anthropic"]);
  });

  it("falls through anthropic and zai before using openrouter", async () => {
    const proxy = createProxy();
    const providersCalled = [];

    proxy.providerHealth.getBestProvider = () => "anthropic";
    proxy.trySubscriptionRequest = async () => undefined;
    proxy.requestProvider = async (provider) => {
      providersCalled.push(provider);

      if (provider === "anthropic") {
        return { response: jsonResponse(503, { error: { message: "unavailable" } }), errorType: "other" };
      }
      if (provider === "zai") {
        return { response: jsonResponse(429, { error: { message: "rate limited" } }), errorType: "rate_limit" };
      }

      return { response: jsonResponse(200, { id: "openrouter-ok" }) };
    };

    const response = await proxy.proxyRequest(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      }),
      { "content-type": "application/json" },
      "/v1/messages",
      "POST",
    );

    assert.equal(response.status, 200);
    assert.deepEqual(providersCalled, ["anthropic", "zai", "openrouter"]);
  });

  it("orders fallback providers by priority and skips providers without keys", () => {
    const proxy = createProxy({
      openrouter: {
        apiKey: "",
      },
    });

    const fallbackProviders = proxy.getFallbackProviders("anthropic");

    assert.deepEqual(fallbackProviders, ["zai"]);
  });
});

describe("Claude Code Proxy provider request normalization", () => {
  it("uses the Anthropic-compatible Z.AI path", async () => {
    const proxy = createProxy();
    let capturedUrl = "";

    proxy.httpRequest = async (url, options) => {
      capturedUrl = url;
      return {
        status: 200,
        headers: options.headers,
        body: Buffer.from("{}"),
      };
    };

    await proxy.requestProvider(
      "zai",
      JSON.stringify({
        model: "glm-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      }),
      { "content-type": "application/json" },
      "/v1/messages?beta=true",
      "POST",
    );

    assert.equal(capturedUrl, "https://api.z.ai/api/anthropic/v1/messages");
  });

  it("rewrites openrouter requests to the messages endpoint and remaps models", async () => {
    const proxy = createProxy();
    let capturedUrl = "";
    let capturedBody = "";

    proxy.httpRequest = async (url, options) => {
      capturedUrl = url;
      capturedBody = String(options.body);
      return {
        status: 200,
        headers: options.headers,
        body: Buffer.from("{}"),
      };
    };

    await proxy.requestProvider(
      "openrouter",
      JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
        metadata: { source: "test" },
        extra_field: "should-be-stripped",
      }),
      { "content-type": "application/json" },
      "/v1/messages?beta=true",
      "POST",
    );

    const parsedBody = JSON.parse(capturedBody);

    assert.equal(capturedUrl, "https://openrouter.ai/api/v1/messages");
    assert.equal(parsedBody.model, "anthropic/claude-sonnet-4.6");
    assert.equal(parsedBody.extra_field, undefined);
    assert.deepEqual(parsedBody.metadata, { source: "test" });
  });
});
