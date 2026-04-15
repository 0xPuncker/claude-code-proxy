# Claude Code Proxy

🚀 **Intelligent API proxy for Anthropic Claude with automatic failover and model mapping**

## Features

- **Automatic Failover**: Primary Z.AI API with seamless fallback to Anthropic API
- **Model Mapping**: Automatically maps unsupported model names to compatible alternatives
- **Streaming Support**: Full support for streaming responses
- **Request Cleaning**: Sanitizes requests to ensure Anthropic API compatibility
- **TypeScript**: Written in TypeScript for type safety and better development experience
- **Structured Logging**: Color-coded, level-based logging for debugging
- **Configuration**: Flexible configuration via environment variables or config object

## Installation

```bash
# Clone the repository
git clone https://github.com/raulneiva/claude-code-proxy.git
cd claude-code-proxy

# Install dependencies
npm install

# Build the project
npm run build

# Start the server
npm start
```

## Quick Start

```bash
# Set your API keys
export ZAI_API_KEY="your-zai-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"

# Start the proxy (defaults to port 4181)
npm start

# Or use a custom port
PROXY_PORT=8080 npm start
```

## Usage

### Basic Example

```javascript
// Use the proxy with any Claude API client
const response = await fetch('http://localhost:4181/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'your-anthropic-api-key',
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'Hello, Claude!' }],
    max_tokens: 1024,
  }),
});
```

### Configuration Options

```typescript
import { ClaudeCodeProxy } from './src/index.js';

const proxy = new ClaudeCodeProxy({
  port: 4181,
  zai: {
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKey: process.env.ZAI_API_KEY || '',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },
  modelFallbackMap: {
    'claude-sonnet-4-6': 'claude-sonnet-4-20250514',
    'claude-opus-4-6': 'claude-sonnet-4-20250514',
  },
  fallbackOnCodes: [429, 503, 502],
  logLevel: 'info', // 'debug' | 'info' | 'warn' | 'error' | 'silent'
});

proxy.start();
```

### Environment Variables

- `PROXY_PORT`: Port for the proxy server (default: `4181`)
- `ZAI_API_KEY`: API key for Z.AI service
- `ANTHROPIC_API_KEY`: API key for Anthropic Claude API

### Model Mapping

The proxy automatically maps newer model names to their compatible equivalents:

```javascript
{
  "glm-5": "claude-sonnet-4-20250514",
  "glm-4.7": "claude-sonnet-4-20250514",
  "glm-4.6": "claude-sonnet-4-20250514",
  "glm-4.5": "claude-sonnet-4-20250514",
  "glm-4.5-air": "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6": "claude-sonnet-4-20250514",
  "claude-opus-4-6": "claude-sonnet-4-20250514",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001"
}
```

## API Reference

### `ClaudeCodeProxy`

Main proxy server class.

#### Constructor

```typescript
new ClaudeCodeProxy(config?: Partial<ProxyConfig>)
```

#### Methods

- `start()`: Start the proxy server
- `stop()`: Stop the proxy server

### `ProxyConfig` Interface

```typescript
interface ProxyConfig {
  port: number;
  zai: {
    baseUrl: string;
    apiKey: string;
  };
  anthropic: {
    baseUrl: string;
    apiKey: string;
  };
  modelFallbackMap: Record<string, string>;
  fallbackOnCodes: number[];
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}
```

## How It Works

1. **Request Interception**: The proxy receives requests destined for the Anthropic API
2. **Primary Attempt**: Forwards requests to Z.AI API first
3. **Smart Fallback**: If Z.AI returns specific error codes (429, 503, 502), automatically falls back to Anthropic
4. **Request Cleaning**: Ensures all requests are Anthropic-compatible
5. **Model Mapping**: Maps unsupported model names to compatible alternatives
6. **Response Proxying**: Returns the response to the client transparently

## Logging

The proxy provides structured, color-coded logging:

```
[12:34:56] [INFO] → Z.AI POST /v1/messages
[12:34:57] [OK] ← Z.AI 200
[12:34:58] [INFO]   model remap: claude-sonnet-4-6 → claude-sonnet-4-20250514
```

Log levels:
- **DEBUG**: Detailed information for debugging
- **INFO**: General informational messages
- **WARN**: Warning messages for fallbacks
- **ERROR**: Error messages
- **SILENT**: Disable all logging

## Development

```bash
# Install dependencies
npm install

# Run in development mode with watch
npm run dev

# Run tests
npm test

# Run linter
npm run lint

# Format code
npm run format
```

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│   Client    │────▶│   Proxy     │────▶│  Z.AI API    │
└─────────────┘     └─────────────┘     └──────────────┘
                          │                    │
                          │ fallback           │ error
                          ▼                    │
                    ┌─────────────┐           │
                    │  Request    │           │
                    │  Cleaning   │           │
                    └─────────────┘           │
                          │                    │
                          ▼                    │
                    ┌─────────────┐           │
                    │  Model      │           │
                    │  Mapping    │           │
                    └─────────────┘           │
                          │                    │
                          ▼                    ▼
                    ┌──────────────────────────────┐
                    │    Anthropic API             │
                    └──────────────────────────────┘
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions, please use the [GitHub issue tracker](https://github.com/raulneiva/claude-code-proxy/issues).

## Acknowledgments

- Built for the Anthropic Claude ecosystem
- Inspired by the need for reliable API failover in production environments
