import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const port = process.env.PORT || 3001;

// Simple auth token - in production, use proper auth
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token';

// In-memory session storage
const sessions: Map<string, Anthropic.MessageParam[]> = new Map();

app.use(cors());
app.use(express.json());

// Simple auth middleware
app.use('/api', (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token !== AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// Initialize Anthropic client
const anthropic = new Anthropic();

// Tool definition for shell
const TOOLS: Anthropic.Tool[] = [
    {
        name: 'shell',
        description: 'Execute a shell command in an ephemeral sandbox. Has basic Unix tools: cat, echo, ls, mkdir, rm, pwd, etc. The filesystem is ephemeral and starts empty.',
        input_schema: {
            type: 'object' as const,
            properties: {
                command: {
                    type: 'string',
                    description: 'The shell command to execute',
                },
            },
            required: ['command'],
        },
    },
];

// Streaming messages endpoint
app.post('/api/messages', async (req, res) => {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
        return res.status(400).json({ error: 'sessionId and message are required' });
    }

    // Get or create session
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, []);
    }
    const messages = sessions.get(sessionId)!;

    // Add user message
    messages.push({ role: 'user', content: message });

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const stream = anthropic.messages.stream({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            system: `You are an AI assistant with access to a shell environment. You can execute commands to help the user. The shell runs in a sandboxed browser environment with an ephemeral filesystem. Be concise and helpful.`,
            tools: TOOLS,
            messages,
        });

        let assistantContent: Anthropic.ContentBlock[] = [];

        stream.on('text', (text) => {
            res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
        });

        stream.on('contentBlock', (block) => {
            assistantContent.push(block);
            if (block.type === 'tool_use') {
                res.write(`data: ${JSON.stringify({ type: 'tool_use', id: block.id, name: block.name, input: block.input })}\n\n`);
            }
        });

        stream.on('message', (message) => {
            // Save assistant message to session
            messages.push({ role: 'assistant', content: assistantContent });

            res.write(`data: ${JSON.stringify({ type: 'message_end', stop_reason: message.stop_reason })}\n\n`);

            if (message.stop_reason !== 'tool_use') {
                res.write('data: [DONE]\n\n');
                res.end();
            }
        });

        stream.on('error', (error) => {
            console.error('Stream error:', error);
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        });
    } catch (error: any) {
        console.error('API error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();
    }
});

// Continue conversation with tool results
app.post('/api/messages/continue', async (req, res) => {
    const { sessionId, toolResults } = req.body;

    if (!sessionId || !toolResults) {
        return res.status(400).json({ error: 'sessionId and toolResults are required' });
    }

    const messages = sessions.get(sessionId);
    if (!messages) {
        return res.status(404).json({ error: 'Session not found' });
    }

    // Add tool results
    messages.push({
        role: 'user',
        content: toolResults.map((r: { tool_use_id: string; output: string }) => ({
            type: 'tool_result' as const,
            tool_use_id: r.tool_use_id,
            content: r.output,
        })),
    });

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        const stream = anthropic.messages.stream({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            system: `You are an AI assistant with access to a shell environment. You can execute commands to help the user. The shell runs in a sandboxed browser environment with an ephemeral filesystem. Be concise and helpful.`,
            tools: TOOLS,
            messages,
        });

        let assistantContent: Anthropic.ContentBlock[] = [];

        stream.on('text', (text) => {
            res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
        });

        stream.on('contentBlock', (block) => {
            assistantContent.push(block);
            if (block.type === 'tool_use') {
                res.write(`data: ${JSON.stringify({ type: 'tool_use', id: block.id, name: block.name, input: block.input })}\n\n`);
            }
        });

        stream.on('message', (message) => {
            messages.push({ role: 'assistant', content: assistantContent });
            res.write(`data: ${JSON.stringify({ type: 'message_end', stop_reason: message.stop_reason })}\n\n`);

            if (message.stop_reason !== 'tool_use') {
                res.write('data: [DONE]\n\n');
                res.end();
            }
        });

        stream.on('error', (error) => {
            console.error('Stream error:', error);
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        });
    } catch (error: any) {
        console.error('API error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();
    }
});

app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
});
