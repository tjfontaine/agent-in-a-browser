# @tjfontaine/web-agent-core

Embeddable AI agent for web applications. Provides a TypeScript API for interacting with AI models (Anthropic, OpenAI, Gemini) from any web page or Node.js application.

## Installation

```bash
npm install @tjfontaine/web-agent-core
```

## Usage

### Streaming Mode

```typescript
import { WebAgent } from '@tjfontaine/web-agent-core';

const agent = new WebAgent({
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

await agent.initialize();

for await (const event of agent.send('Analyze this data...')) {
  if (event.type === 'chunk') {
    process.stdout.write(event.text);
  } else if (event.type === 'tool-call') {
    console.log(`🔧 ${event.toolName}`);
  }
}

agent.destroy();
```

### One-shot Mode

```typescript
const response = await agent.prompt('Summarize the results');
console.log(response);
```

### Conversation History

```typescript
// Get history
const history = agent.getHistory();
console.log(history);

// Clear history
agent.clearHistory();
```

### Cancellation

```typescript
// Cancel ongoing stream
agent.cancel();
```

## API

### `new WebAgent(config: AgentConfig)`

Create a new agent instance.

- `config.provider` - AI provider ('anthropic', 'openai', 'gemini')
- `config.model` - Model name
- `config.apiKey` - API key
- `config.baseUrl` - Optional custom base URL
- `config.preamble` - Optional system prompt
- `config.mcpServers` - Optional array of MCP servers: `[{url, name?}]`

### `agent.initialize(): Promise<void>`

Initialize the WASM module. Must be called before sending messages.

### `agent.send(message: string): AsyncGenerator<AgentEvent>`

Send a message and stream events.

### `agent.prompt(message: string): Promise<string>`

Send a message and wait for the complete response.

### `agent.getHistory(): Message[]`

Get conversation history.

### `agent.clearHistory(): void`

Clear conversation history.

### `agent.cancel(): void`

Cancel the current stream.

### `agent.destroy(): void`

Destroy the agent and release resources.

## License

MIT
