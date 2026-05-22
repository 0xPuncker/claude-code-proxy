import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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

  it("strips historical thinking blocks before Claude subscription retry", async () => {
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
              { type: "thinking", thinking: "private chain", signature: "bad-signature" },
              { type: "text", text: "visible answer" },
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
    assert.deepEqual(parsed.messages[1].content, [{ type: "text", text: "visible answer" }]);
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
      assert.match(Buffer.concat(clientRes.chunks).toString(), /"model":"glm-4\.7"/);
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
    assert.equal(parsedBody.model, "~anthropic/claude-sonnet-latest");
    assert.equal(parsedBody.extra_field, undefined);
    assert.deepEqual(parsedBody.metadata, { source: "test" });
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
