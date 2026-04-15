# Contributing to Claude Code Proxy

Thank you for your interest in contributing to Claude Code Proxy! This document provides guidelines and instructions for contributing.

## Development Setup

1. **Fork and clone the repository**:
   ```bash
   git clone https://github.com/your-username/claude-code-proxy.git
   cd claude-code-proxy
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the project**:
   ```bash
   npm run build
   ```

## Development Workflow

### Making Changes

1. Create a new branch for your feature or bugfix:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bugfix-name
   ```

2. Make your changes and ensure they follow the existing code style.

3. Build and test your changes:
   ```bash
   npm run build
   npm test
   ```

### Code Style

- Use TypeScript for all new code
- Follow the existing code structure and naming conventions
- Add comments for complex logic
- Update the README if you're adding new features

### Testing

- Add tests for new functionality
- Ensure all tests pass before submitting a pull request
- Test your changes manually if applicable

### Commit Messages

Use clear, descriptive commit messages:

```
feat: add support for custom model mapping
fix: resolve streaming response parsing issue
docs: update API documentation
test: add unit tests for request cleaning
```

## Submitting Changes

1. **Push your changes**:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create a Pull Request**:
   - Go to the repository on GitHub
   - Click "New Pull Request"
   - Provide a clear description of your changes
   - Reference any related issues

3. **Respond to feedback**:
   - Address any review comments
   - Make requested changes
   - Keep the conversation constructive

## Project Structure

```
claude-code-proxy/
├── src/                 # Source code
│   ├── index.ts        # Main proxy server
│   └── types.ts        # TypeScript type definitions
├── examples/           # Usage examples
├── tests/             # Test files
├── docs/              # Documentation
├── dist/              # Compiled output (generated)
└── package.json       # Project configuration
```

## Getting Help

If you need help:

- Check existing issues and pull requests
- Read the documentation
- Ask questions in an issue

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
