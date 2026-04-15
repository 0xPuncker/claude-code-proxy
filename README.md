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
git clone https://github.com/0xPuncker/claude-code-proxy.git
cd claude-code-proxy

# Install dependencies
npm install

# Build the project
npm run build

# Start the server
npm start
```

## Quick Start

### Using npm

```bash
# Clone the repository
git clone https://github.com/0xPuncker/claude-code-proxy.git
cd claude-code-proxy

# Install dependencies and build
npm install
npm run build

# Set your API keys
export ZAI_API_KEY="your-zai-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"

# Start the proxy (defaults to port 4181)
npm start

# Or use a custom port
PROXY_PORT=8080 npm start
```

### Using Docker

```bash
# Clone the repository
git clone https://github.com/0xPuncker/claude-code-proxy.git
cd claude-code-proxy

# Create environment file from example
cp .env.docker.example .env

# Edit .env and add your API keys
# nano .env or code .env

# Build and run with Docker Compose
make docker-build
make docker-run

# Or using docker-compose directly
docker-compose up -d

# View logs
make docker-logs

# Stop the container
make docker-stop
```

#### Docker Commands

```bash
# Build the Docker image
docker-compose build

# Start the container
docker-compose up -d

# View logs
docker-compose logs -f claude-code-proxy

# Stop the container
docker-compose down

# Restart the container
docker-compose restart

# Remove containers and images
make docker-clean
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

# Using Makefile
make build          # Build TypeScript
make dev            # Run in development mode
make test           # Run tests
make docker-build   # Build Docker image
make docker-run     # Run Docker container
make docker-stop    # Stop Docker containers
make help           # Show all available commands
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
