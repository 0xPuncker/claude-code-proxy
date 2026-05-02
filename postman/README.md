# Claude Code Proxy - Postman Collection

Complete API testing collection for the Claude Code Proxy with usage tracking.

## 📋 Collection Overview

This collection provides comprehensive API testing capabilities for:

- **Health & Status Monitoring**: Check proxy health and configuration
- **Usage Analytics**: Query detailed usage statistics and metrics
- **Proxy Operations**: Test all Claude API message operations
- **Model Testing**: Test different Claude models and their mappings
- **Error Scenarios**: Validate error handling and edge cases

## 🚀 Quick Start

### 1. Import Collection

1. Open Postman
2. Click "Import" in the top left
3. Drag and drop `Claude-Code-Proxy-Collection.json` or select "Upload Files"
4. Click "Import" to add the collection

### 2. Import Environment (Optional)

1. Click "Manage Environments" (gear icon in top right)
2. Click "Import"
3. Select `claude-code-proxy-environment.json`
4. This will create a pre-configured environment with all necessary variables

### 3. Configure Environment

**Quick Setup:**

Create a new environment or edit the imported one with these variables:

```json
{
  "baseUrl": "http://127.0.0.1:4181",
  "apiKey": "your-api-key-here"
}
```

**For local development:**
- `baseUrl`: `http://127.0.0.1:4181`
- `apiKey`: Your Anthropic API key (get from https://console.anthropic.com)

**For Docker deployment:**
- `baseUrl`: `http://127.0.0.1:4181` (if using default port mapping)
- `apiKey`: Your Anthropic API key

**For local development:**
- `baseUrl`: `http://127.0.0.1:4181`

**For Docker deployment:**
- `baseUrl`: `http://127.0.0.1:4181` (if port mapped)
- Use your actual deployment URL

### 3. Start Testing

You can now run individual requests or the entire collection!

## 📚 Collection Structure

### Health & Status
- **Health Check**: Verify proxy is running and get configuration info
- **Usage Statistics**: Get comprehensive usage analytics

### Proxy Operations
- **Create Message (Non-Streaming)**: Standard API requests
- **Create Message (Streaming)**: Real-time streaming responses
- **Create Message with System Prompt**: Custom system prompts
- **Create Message with Temperature**: Adjust response creativity
- **Multi-turn Conversation**: Test conversation context handling

### Usage Analytics
- **Last 7 Days Usage**: Recent usage overview
- **Last 30 Days Usage**: Monthly usage statistics
- **Recent 50 Requests**: Latest request details
- **Custom Usage Query**: Flexible time range and limit

### Model Testing
- **Test with Sonnet 4**: Main production model
- **Test with Opus 4**: Premium model (maps to Sonnet)
- **Test with Haiku 4**: Fast model for simple tasks

### Error Scenarios
- **Invalid Model Name**: Model name validation
- **Missing Required Fields**: Input validation
- **Malformed JSON**: Request format validation

## 🔧 Configuration Examples

### Environment Variables

```json
{
  "baseUrl": "http://127.0.0.1:4181",
  "claudeApiKey": "sk-ant-...",
  "timeout": "30000"
}
```

### Pre-request Scripts

Add authentication headers automatically:

```javascript
pm.sendRequest({
  url: pm.environment.get("baseUrl") + "/health",
  method: 'GET',
  header: {
    'Content-Type': 'application/json'
  }
}, function (err, res) {
  // Set up authentication if needed
  if (pm.environment.get("claudeApiKey")) {
    pm.request.headers.add({
      key: 'x-api-key',
      value: pm.environment.get("claudeApiKey")
    });
  }
});
```

### Tests

Add automated tests to verify responses:

```javascript
// Health check test
pm.test("Status is healthy", function () {
  pm.expect(pm.response.json()).to.have.property("status", "healthy");
});

// Usage statistics test
pm.test("Has daily usage data", function () {
  pm.expect(pm.response.json().daily_usage).to.be.an("array");
});

// Response time test
pm.test("Response time is acceptable", function () {
  pm.expect(pm.response.responseTime).to.be.below(5000);
});
```

## 🎯 Common Use Cases

### 1. Test Basic Functionality

1. Run "Health Check" → Should return 200 OK
2. Run "Create Message (Non-Streaming)" → Should return Claude response
3. Run "Usage Statistics" → Should return usage data (if tracking enabled)

### 2. Model Comparison

Run all requests in "Model Testing" folder to compare:
- Response quality across models
- Response time differences
- Model mapping behavior

### 3. Load Testing

Use Postman Runner to:
- Run collection multiple times
- Test concurrent requests
- Monitor proxy performance under load

### 4. Error Testing

Run "Error Scenarios" to verify:
- Proper error messages
- Graceful failure handling
- API validation

## 📊 Monitoring & Analytics

### Usage Tracking

If database tracking is enabled, you can:

1. **Monitor Daily Usage**:
   ```
   GET {{baseUrl}}/usage?days=7
   ```

2. **Check Recent Activity**:
   ```
   GET {{baseUrl}}/usage?limit=50
   ```

3. **Custom Time Ranges**:
   ```
   GET {{baseUrl}}/usage?days=30&limit=200
   ```

### Performance Metrics

The proxy tracks:
- Request duration (ms)
- Token usage (input/output/cache)
- Provider used (zai/anthropic)
- Fallback occurrences
- Error rates

## 🐛 Troubleshooting

### Connection Issues

**Problem**: "Could not get any response"
- **Solution**: Check if proxy is running: `curl http://127.0.0.1:4181/health`

### Authentication Errors

**Problem**: 401 Unauthorized
- **Solution**: Verify API keys in environment configuration

### Tracking Not Working

**Problem**: Empty usage statistics
- **Solution**: Verify database connection and schema initialization

### Model Mapping Issues

**Problem**: Model name not recognized
- **Solution**: Check model fallback configuration in proxy settings

## 🔄 Updates & Maintenance

### Keep Collection Updated

When the proxy API changes:
1. Update relevant requests in the collection
2. Add new endpoints as needed
3. Update example responses
4. Test all changes before sharing

### Version History

- **v1.0.0** (2026-04-16): Initial collection with usage tracking support

## 📖 Additional Resources

- [Claude Code Proxy Documentation](../README.md)
- [Usage Tracking Guide](../docs/USAGE_TRACKING.md)
- [API Reference](../docs/API.md)
- [Prisma Schema](../prisma/schema.prisma)

## 💡 Tips & Best Practices

1. **Use Environments**: Separate configurations for dev/staging/prod
2. **Add Tests**: Automate validation with Postman tests
3. **Monitor Performance**: Track response times and success rates
4. **Version Control**: Keep collection in git with your code
5. **Document Changes**: Update README when modifying collection
6. **Use Pre-request Scripts**: Automate authentication and setup
7. **Test Edge Cases**: Include error scenarios in testing
8. **Mock Responses**: Add example responses for documentation

## 🤝 Contributing

When adding new API endpoints:
1. Create corresponding Postman requests
2. Add proper documentation
3. Include example responses
4. Test thoroughly before committing
5. Update this README

## 📞 Support

For issues or questions:
- GitHub: https://github.com/raulneiva/claude-code-proxy
- Documentation: See `/docs` folder
- Issues: Create GitHub issue with "postman" label
