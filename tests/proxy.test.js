import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeProxy } from "../dist/index.js";
import { ProviderState } from "../dist/provider-health.js";

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

function startUpstream(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function createFakeResponse() {
  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });

  return {
    headersSent: false,
    statusCode: undefined,
    headers: undefined,
    chunks: [],
    ended,
    writeHead(statusCode, headers) {
      this.headersSent = true;
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      resolveEnded();
    },
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
    assert.equal(proxy.providerHealth.getState("anthropic"), ProviderState.COOLING_DOWN);
    proxy.providerHealth.destroy();
  });

  it("records primary provider quota failures before falling back", async () => {
    const proxy = createProxy();

    proxy.trySubscriptionRequest = async () => undefined;
    proxy.requestProvider = async (provider) => {
      if (provider === "anthropic") {
        return {
          response: jsonResponse(403, {
            error: { message: "quota exceeded for this account" },
          }),
          errorType: "rate_limit",
        };
      }

      return { response: jsonResponse(200, { id: "fallback-ok" }) };
    };

    try {
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
      assert.equal(proxy.providerHealth.getState("anthropic"), ProviderState.COOLING_DOWN);
      assert.equal(proxy.providerHealth.isAvailable("anthropic"), false);
    } finally {
      proxy.providerHealth.destroy();
    }
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

  it("continues to API fallback after Claude subscription fails open", async () => {
    const proxy = createProxy();
    const providersCalled = [];

    proxy.providerHealth.getBestProviderAndModel = () => ({
      provider: "zai",
      model: "claude-sonnet-4-6",
      wasConverted: false,
    });
    proxy.trySubscriptionRequest = async () => undefined;
    proxy.requestProvider = async (provider) => {
      providersCalled.push(provider);

      if (provider === "zai") {
        return { response: jsonResponse(429, { error: { message: "rate limited" } }), errorType: "rate_limit" };
      }

      return { response: jsonResponse(200, { id: "anthropic-ok" }) };
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
    assert.deepEqual(providersCalled, ["zai", "anthropic"]);
  });

  it("does not treat a Claude subscription 530 as recovery", async () => {
    const proxy = createProxy();

    proxy.readClaudeOAuthToken = async () => "oauth-token";
    proxy.httpRequest = async () => jsonResponse(530, { error: "error code: 1016" });

    const response = await proxy.trySubscriptionRequest(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      }),
      { "content-type": "application/json" },
      "/v1/messages",
      "POST",
    );

    assert.equal(response, undefined);
  });

  it("opens a cooldown circuit after Claude subscription limit responses", async () => {
    const proxy = createProxy({
      circuitBreaker: {
        cooldownMs: 1000,
      },
    });
    let upstreamCalls = 0;

    proxy.readClaudeOAuthToken = async () => "oauth-token";
    proxy.httpRequest = async () => {
      upstreamCalls++;
      return jsonResponse(429, { error: { message: "usage limit reached" } });
    };

    const requestBody = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    });

    const first = await proxy.trySubscriptionRequest(
      requestBody,
      { "content-type": "application/json" },
      "/v1/messages",
      "POST",
    );
    const second = await proxy.trySubscriptionRequest(
      requestBody,
      { "content-type": "application/json" },
      "/v1/messages",
      "POST",
    );

    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.equal(upstreamCalls, 1);
    assert.equal(proxy.getClaudeSubscriptionState().state, "cooling_down");

    proxy.providerHealth.destroy();
  });

  it("routes Claude subscription OAuth requests to the Anthropic API host", async () => {
    const proxy = createProxy();
    let capturedUrl = "";
    let capturedHeaders = {};

    proxy.readClaudeOAuthToken = async () => "oauth-token";
    proxy.httpRequest = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return jsonResponse(200, { id: "subscription-ok" });
    };

    const response = await proxy.trySubscriptionRequest(
      JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      }),
      { "content-type": "application/json" },
      "/v1/messages",
      "POST",
    );

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
    assert.equal(capturedHeaders.authorization, "Bearer oauth-token");
    assert.equal(capturedHeaders.host, "api.anthropic.com");
  });

  it("drops unsigned thinking blocks but keeps signed ones for Claude subscription", async () => {
    const proxy = createProxy();
    let capturedBody = "";

    proxy.readClaudeOAuthToken = async () => "oauth-token";
    proxy.httpRequest = async (_url, options) => {
      capturedBody = String(options.body);
      return jsonResponse(200, { id: "subscription-ok" });
    };

    const response = await proxy.trySubscriptionRequest(
      JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              // Unsigned (contaminated, e.g. from a GLM fallback) → dropped
              { type: "thinking", thinking: "contaminated chain" },
              { type: "text", text: "first answer" },
            ],
          },
          {
            role: "assistant",
            content: [
              // Signed (Anthropic-produced) → preserved for reasoning continuity
              { type: "thinking", thinking: "valid chain", signature: "real-sig-abc" },
              { type: "text", text: "second answer" },
            ],
          },
        ],
      }),
      { "content-type": "application/json" },
      "/v1/messages",
      "POST",
    );

    const parsed = JSON.parse(capturedBody);

    assert.equal(response.status, 200);
    assert.deepEqual(parsed.thinking, { type: "enabled", budget_tokens: 1024 });
    // Unsigned thinking removed from the first assistant turn
    assert.deepEqual(parsed.messages[1].content, [{ type: "text", text: "first answer" }]);
    // Signed thinking preserved in the second assistant turn
    assert.deepEqual(parsed.messages[2].content, [
      { type: "thinking", thinking: "valid chain", signature: "real-sig-abc" },
      { type: "text", text: "second answer" },
    ]);
  });

  it("does not send streaming provider errors before trying fallback", async () => {
    const zaiUpstream = await startUpstream((req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    const anthropicUpstream = await startUpstream((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: {\"type\":\"message_stop\"}\n\n");
    });
    let proxy;

    try {
      proxy = createProxy({
        anthropic: {
          baseUrl: anthropicUpstream.baseUrl,
          apiKey: "anthropic-test-key",
        },
        zai: {
          baseUrl: zaiUpstream.baseUrl,
          apiKey: "zai-test-key",
        },
        claudeSubscription: {
          enabled: false,
        },
      });

      proxy.providerHealth.getBestProviderForModel = () => "zai";
      const clientRes = createFakeResponse();

      await proxy.handleStreamingRequest(
        JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 16,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
        { "content-type": "application/json" },
        "/v1/messages",
        "POST",
        clientRes,
      );
      await clientRes.ended;

      assert.equal(clientRes.statusCode, 200);
      assert.equal(Buffer.concat(clientRes.chunks).toString(), "data: {\"type\":\"message_stop\"}\n\n");
    } finally {
      proxy?.providerHealth.destroy();
      await closeServer(zaiUpstream.server);
      await closeServer(anthropicUpstream.server);
    }
  });

  it("falls back to Z.AI when Claude subscription streams an immediate limit error", async () => {
    const subscriptionUpstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'event: error\n' +
        'data: {"type":"error","error":{"type":"rate_limit_error","message":"usage limit reached"}}\n\n'
      );
    });
    const zaiUpstream = await startUpstream((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: {"type":"message_start","message":{"model":"${parsed.model}"}}\n\n`);
      });
    });
    let proxy;

    try {
      proxy = createProxy({
        anthropic: {
          apiKey: "",
        },
        zai: {
          baseUrl: zaiUpstream.baseUrl,
          apiKey: "zai-test-key",
        },
        claudeSubscription: {
          enabled: true,
          baseUrl: subscriptionUpstream.baseUrl,
          credentialsPath: "test-credentials.json",
        },
        circuitBreaker: {
          cooldownMs: 1000,
        },
      });

      proxy.providerHealth.getBestProviderForModel = () => "zai";
      proxy.readClaudeOAuthToken = async () => "oauth-token";
      const clientRes = createFakeResponse();

      await proxy.handleStreamingRequest(
        JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 16,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
        { "content-type": "application/json" },
        "/v1/messages",
        "POST",
        clientRes,
      );
      await clientRes.ended;

      assert.equal(clientRes.statusCode, 200);
      assert.match(Buffer.concat(clientRes.chunks).toString(), /"model":"glm-5\.2"/);
      assert.equal(proxy.getClaudeSubscriptionState().state, "cooling_down");
    } finally {
      proxy?.providerHealth.destroy();
      await closeServer(subscriptionUpstream.server);
      await closeServer(zaiUpstream.server);
    }
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

  it("classifies quota-style provider responses as rate limits", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "quota exceeded for this account" } }));
    });
    const proxy = createProxy({
      anthropic: {
        baseUrl: upstream.baseUrl,
        apiKey: "anthropic-test-key",
      },
    });

    try {
      const result = await proxy.requestProvider(
        "anthropic",
        JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
        }),
        { "content-type": "application/json" },
        "/v1/messages",
        "POST",
      );

      assert.equal(result.response.status, 403);
      assert.equal(result.errorType, "rate_limit");
    } finally {
      proxy.providerHealth.destroy();
      await closeServer(upstream.server);
    }
  });

  it("rewrites openrouter requests to the messages endpoint and remaps models", async () => {
    const proxy = createProxy();
    let capturedUrl = "";
    let capturedBody = "";
    let capturedHeaders = {};

    proxy.httpRequest = async (url, options) => {
      capturedUrl = url;
      capturedBody = String(options.body);
      capturedHeaders = options.headers;
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
      {
        "content-type": "application/json",
        // Claude Code always sends these Anthropic-specific headers; forwarding
        // x-api-key to OpenRouter triggers a guardrail 404.
        "x-api-key": "sk-ant-should-not-leak",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219",
      },
      "/v1/messages?beta=true",
      "POST",
    );

    const parsedBody = JSON.parse(capturedBody);

    assert.equal(capturedUrl, "https://openrouter.ai/api/v1/messages");
    assert.equal(parsedBody.model, "~anthropic/claude-sonnet-latest");
    assert.equal(parsedBody.extra_field, undefined);
    assert.deepEqual(parsedBody.metadata, { source: "test" });

    // Anthropic-specific headers must NOT reach OpenRouter (cause guardrail 404).
    assert.equal(capturedHeaders["x-api-key"], undefined);
    assert.equal(capturedHeaders["anthropic-version"], undefined);
    assert.equal(capturedHeaders["anthropic-beta"], undefined);
    // OpenRouter's own auth + attribution headers are present.
    assert.equal(capturedHeaders.authorization, "Bearer openrouter-test-key");
    assert.equal(capturedHeaders["HTTP-Referer"], "https://claude.ai/code");
  });

  it("normalizes OpenRouter message responses to strict Anthropic shape", async () => {
    const proxy = createProxy();

    proxy.httpRequest = async () => ({
      status: 200,
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
      body: Buffer.from(JSON.stringify({
        id: "gen-test",
        type: "message",
        role: "assistant",
        container: null,
        content: [{ type: "text", text: "OK", citations: [] }],
        model: "anthropic/claude-4.6-sonnet-20260217",
        stop_reason: "end_turn",
        stop_details: null,
        stop_sequence: null,
        usage: {
          input_tokens: 9,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cost: 0.000087,
        },
        provider: "Google",
      })),
    });

    const { response } = await proxy.requestProvider(
      "openrouter",
      JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      }),
      { "content-type": "application/json" },
      "/v1/messages",
      "POST",
    );

    const parsed = JSON.parse(response.body.toString());

    assert.equal(response.headers["transfer-encoding"], undefined);
    assert.equal(response.headers["content-type"], "application/json");
    assert.deepEqual(Object.keys(parsed).sort(), [
      "content",
      "id",
      "model",
      "role",
      "stop_reason",
      "stop_sequence",
      "type",
      "usage",
    ]);
    assert.deepEqual(parsed.content, [{ type: "text", text: "OK" }]);
    assert.deepEqual(parsed.usage, {
      input_tokens: 9,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

describe("Claude subscription OAuth refresh", () => {
  function writeCreds(filePath, { accessToken, refreshToken, expiresAt }) {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        claudeAiOauth: { accessToken, refreshToken, expiresAt },
        mcpOAuth: { keep: "me" }, // unrelated key that must be preserved
      }),
    );
  }

  function tmpCredsPath() {
    return path.join(os.tmpdir(), `cc-proxy-test-creds-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  }

  it("refreshes a near-expiry token and persists rotated credentials", async () => {
    const credPath = tmpCredsPath();
    writeCreds(credPath, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 60_000, // within the 5min skew window → should refresh
    });

    const proxy = createProxy({
      claudeSubscription: { enabled: true, credentialsPath: credPath },
    });

    let refreshCalls = 0;
    let capturedBody;
    proxy.httpRequest = async (url, options) => {
      refreshCalls++;
      assert.match(url, /oauth\/token$/);
      capturedBody = JSON.parse(options.body);
      return jsonResponse(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 28800,
      });
    };

    const token = await proxy.readClaudeOAuthToken();

    assert.equal(token, "new-access");
    assert.equal(refreshCalls, 1);
    assert.equal(capturedBody.grant_type, "refresh_token");
    assert.equal(capturedBody.refresh_token, "old-refresh");

    // Rotated tokens written back; unrelated keys preserved.
    const persisted = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    assert.equal(persisted.claudeAiOauth.accessToken, "new-access");
    assert.equal(persisted.claudeAiOauth.refreshToken, "new-refresh");
    assert.equal(persisted.mcpOAuth.keep, "me");

    fs.unlinkSync(credPath);
    proxy.providerHealth.destroy();
  });

  it("does not refresh a token that is comfortably valid", async () => {
    const credPath = tmpCredsPath();
    writeCreds(credPath, {
      accessToken: "still-good",
      refreshToken: "some-refresh",
      expiresAt: Date.now() + 3_600_000, // 1h out → outside skew, no refresh
    });

    const proxy = createProxy({
      claudeSubscription: { enabled: true, credentialsPath: credPath },
    });

    let refreshCalls = 0;
    proxy.httpRequest = async () => {
      refreshCalls++;
      return jsonResponse(200, { access_token: "unexpected" });
    };

    const token = await proxy.readClaudeOAuthToken();

    assert.equal(token, "still-good");
    assert.equal(refreshCalls, 0);

    fs.unlinkSync(credPath);
    proxy.providerHealth.destroy();
  });

  it("collapses concurrent refreshes into a single token redemption", async () => {
    const credPath = tmpCredsPath();
    writeCreds(credPath, {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1000, // already expired
    });

    const proxy = createProxy({
      claudeSubscription: { enabled: true, credentialsPath: credPath },
    });

    let refreshCalls = 0;
    proxy.httpRequest = async () => {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 25)); // hold the refresh open
      return jsonResponse(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 28800,
      });
    };

    const [a, b, c] = await Promise.all([
      proxy.readClaudeOAuthToken(),
      proxy.readClaudeOAuthToken(),
      proxy.readClaudeOAuthToken(),
    ]);

    assert.equal(a, "new-access");
    assert.equal(b, "new-access");
    assert.equal(c, "new-access");
    assert.equal(refreshCalls, 1); // single-flight: one redemption for all three

    fs.unlinkSync(credPath);
    proxy.providerHealth.destroy();
  });

  it("returns undefined when an expired token cannot be refreshed", async () => {
    const credPath = tmpCredsPath();
    writeCreds(credPath, {
      accessToken: "old-access",
      refreshToken: "bad-refresh",
      expiresAt: Date.now() - 1000, // expired
    });

    const proxy = createProxy({
      claudeSubscription: { enabled: true, credentialsPath: credPath },
    });

    proxy.httpRequest = async () => jsonResponse(400, { error: "invalid_grant" });

    const token = await proxy.readClaudeOAuthToken();
    assert.equal(token, undefined);

    fs.unlinkSync(credPath);
    proxy.providerHealth.destroy();
  });

  it("forceRefresh redeems the refresh token regardless of local expiry (401 recovery)", async () => {
    const credPath = tmpCredsPath();
    writeCreds(credPath, {
      accessToken: "revoked-but-unexpired",
      refreshToken: "old-refresh",
      expiresAt: Date.now() + 3_600_000, // looks valid locally, but server revoked it
    });

    const proxy = createProxy({
      claudeSubscription: { enabled: true, credentialsPath: credPath },
    });

    let refreshCalls = 0;
    proxy.httpRequest = async () => {
      refreshCalls++;
      return jsonResponse(200, {
        access_token: "recovered-access",
        refresh_token: "new-refresh",
        expires_in: 28800,
      });
    };

    const token = await proxy.forceRefreshClaudeOAuthToken();
    assert.equal(token, "recovered-access");
    assert.equal(refreshCalls, 1);

    fs.unlinkSync(credPath);
    proxy.providerHealth.destroy();
  });

  it("prefers a static token and never refreshes", async () => {
    const proxy = createProxy({
      claudeSubscription: { enabled: true, oauthToken: "static-long-lived", credentialsPath: "nonexistent.json" },
    });

    let refreshCalls = 0;
    proxy.httpRequest = async () => {
      refreshCalls++;
      return jsonResponse(200, { access_token: "nope" });
    };

    assert.equal(await proxy.readClaudeOAuthToken(), "static-long-lived");
    assert.equal(await proxy.forceRefreshClaudeOAuthToken(), undefined);
    assert.equal(refreshCalls, 0);

    proxy.providerHealth.destroy();
  });
});

describe("Tool-use ID sanitization (cross-provider contamination)", () => {
  function cleanedMessages(proxy, messages, provider) {
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 64,
      messages,
    });
    return JSON.parse(proxy.cleanBody(body, provider)).messages;
  }

  it("rewrites a non-conforming server_tool_use id and its tool_result reference for subscription", () => {
    const proxy = createProxy();
    const messages = [
      { role: "user", content: [{ type: "text", text: "search the web" }] },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "call_abc123", name: "web_search", input: { query: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "web_search_tool_result", tool_use_id: "call_abc123", content: [] },
        ],
      },
    ];

    const out = cleanedMessages(proxy, messages, "subscription");
    const newId = out[1].content[0].id;

    assert.match(newId, /^srvtoolu_[a-zA-Z0-9_]+$/);
    // The reference must be remapped to the SAME new id, or Anthropic 400s on pairing.
    assert.equal(out[2].content[0].tool_use_id, newId);

    proxy.providerHealth.destroy();
  });

  it("rewrites a non-conforming tool_use id (client tool) and its result reference", () => {
    const proxy = createProxy();
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "glm-77", name: "do_thing", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "glm-77", content: "ok" }],
      },
    ];

    const out = cleanedMessages(proxy, messages, "anthropic");
    const newId = out[0].content[0].id;

    assert.match(newId, /^toolu_[a-zA-Z0-9_]+$/);
    assert.equal(out[1].content[0].tool_use_id, newId);

    proxy.providerHealth.destroy();
  });

  it("leaves already-conforming ids untouched", () => {
    const proxy = createProxy();
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_keepme", name: "web_search", input: {} },
          { type: "tool_use", id: "toolu_keepme2", name: "do", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_keepme", content: [] },
          { type: "tool_result", tool_use_id: "toolu_keepme2", content: "ok" },
        ],
      },
    ];

    const out = cleanedMessages(proxy, messages, "subscription");
    assert.equal(out[0].content[0].id, "srvtoolu_keepme");
    assert.equal(out[0].content[1].id, "toolu_keepme2");
    assert.equal(out[1].content[0].tool_use_id, "srvtoolu_keepme");
    assert.equal(out[1].content[1].tool_use_id, "toolu_keepme2");

    proxy.providerHealth.destroy();
  });

  it("does NOT sanitize ids for non-Anthropic providers (zai passes through)", () => {
    const proxy = createProxy();
    const messages = [
      {
        role: "assistant",
        content: [{ type: "server_tool_use", id: "call_abc123", name: "web_search", input: {} }],
      },
    ];

    const out = cleanedMessages(proxy, messages, "zai");
    assert.equal(out[0].content[0].id, "call_abc123");

    proxy.providerHealth.destroy();
  });

  it("keeps two distinct non-conforming ids distinct after rewrite", () => {
    const proxy = createProxy();
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a/b", name: "t", input: {} },
          { type: "tool_use", id: "a_b", name: "t", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a/b", content: "1" },
          { type: "tool_result", tool_use_id: "a_b", content: "2" },
        ],
      },
    ];

    const out = cleanedMessages(proxy, messages, "subscription");
    const id1 = out[0].content[0].id;
    const id2 = out[0].content[1].id;

    assert.notEqual(id1, id2); // "a/b" and "a_b" must not collapse to one id
    assert.equal(out[1].content[0].tool_use_id, id1);
    assert.equal(out[1].content[1].tool_use_id, id2);

    proxy.providerHealth.destroy();
  });
});

describe("cleanBody field passthrough (preserve coding-critical settings)", () => {
  function clean(proxy, body, provider) {
    return JSON.parse(proxy.cleanBody(JSON.stringify(body), provider));
  }

  const codingBody = {
    model: "claude-opus-4-8",
    max_tokens: 64000,
    messages: [{ role: "user", content: "refactor this" }],
    output_config: { effort: "xhigh", task_budget: { type: "tokens", total: 128000 } },
    context_management: { edits: [{ type: "compact_20260112" }] },
  };

  for (const provider of ["subscription", "anthropic"]) {
    it(`preserves output_config and context_management for ${provider}`, () => {
      const proxy = createProxy();
      const out = clean(proxy, codingBody, provider);

      assert.deepEqual(out.output_config, {
        effort: "xhigh",
        task_budget: { type: "tokens", total: 128000 },
      });
      assert.deepEqual(out.context_management, { edits: [{ type: "compact_20260112" }] });
      assert.equal(out.model, "claude-opus-4-8");

      proxy.providerHealth.destroy();
    });
  }

  for (const provider of ["zai", "openrouter"]) {
    it(`still strips unknown top-level fields for ${provider}`, () => {
      const proxy = createProxy();
      const out = clean(proxy, codingBody, provider);

      // Z.AI / OpenRouter need the narrow translated shape.
      assert.equal(out.output_config, undefined);
      assert.equal(out.context_management, undefined);
      // Allowed fields survive.
      assert.equal(out.max_tokens, 64000);

      proxy.providerHealth.destroy();
    });
  }
});

describe("OpenRouter model mapping (no Opus→Sonnet downgrade)", () => {
  it("maps Opus models to an Opus OpenRouter target", () => {
    const proxy = createProxy();
    for (const m of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus"]) {
      assert.equal(proxy.mapModel(m, "openrouter"), "~anthropic/claude-opus-latest", `model ${m}`);
    }
    proxy.providerHealth.destroy();
  });

  it("keeps Sonnet mapped to Sonnet", () => {
    const proxy = createProxy();
    assert.equal(proxy.mapModel("claude-sonnet-4-6", "openrouter"), "~anthropic/claude-sonnet-latest");
    proxy.providerHealth.destroy();
  });
});

describe("STRIP_SUBSCRIPTION_THINKING modes", () => {
  function subscriptionMessages(proxy, messages) {
    const body = JSON.stringify({ model: "claude-opus-4-8", max_tokens: 64, messages });
    return JSON.parse(proxy.cleanBody(body, "subscription")).messages;
  }

  const mixed = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "unsigned", },
        { type: "thinking", thinking: "signed", signature: "sig" },
        { type: "redacted_thinking", data: "abc" },
        { type: "text", text: "answer" },
      ],
    },
  ];

  it("default (unsigned) drops unsigned thinking, keeps signed + redacted", () => {
    delete process.env.STRIP_SUBSCRIPTION_THINKING;
    const proxy = createProxy();
    const out = subscriptionMessages(proxy, mixed);
    const types = out[0].content.map((b) => b.type);
    assert.deepEqual(types, ["thinking", "redacted_thinking", "text"]);
    assert.equal(out[0].content[0].signature, "sig");
    proxy.providerHealth.destroy();
  });

  it("mode=all strips every thinking and redacted_thinking block", () => {
    process.env.STRIP_SUBSCRIPTION_THINKING = "all";
    const proxy = createProxy();
    const out = subscriptionMessages(proxy, mixed);
    assert.deepEqual(out[0].content.map((b) => b.type), ["text"]);
    delete process.env.STRIP_SUBSCRIPTION_THINKING;
    proxy.providerHealth.destroy();
  });

  it("mode=none keeps all blocks", () => {
    process.env.STRIP_SUBSCRIPTION_THINKING = "none";
    const proxy = createProxy();
    const out = subscriptionMessages(proxy, mixed);
    assert.deepEqual(out[0].content.map((b) => b.type), [
      "thinking",
      "thinking",
      "redacted_thinking",
      "text",
    ]);
    delete process.env.STRIP_SUBSCRIPTION_THINKING;
    proxy.providerHealth.destroy();
  });
});
