import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const port = process.env.PORT || 3001;

// Simple auth token - in production, use proper auth
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token';

// Debug logging helper
const DEBUG = process.env.DEBUG === 'true' || true; // Enable by default for now
function debug(...args: any[]) {
    if (DEBUG) {
        console.log('[SDK]', new Date().toISOString(), ...args);
    }
}

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

// Pure proxy endpoint - frontend provides everything
app.post('/api/messages', async (req, res) => {
    const { messages, tools, system } = req.body;

    if (!messages) {
        return res.status(400).json({ error: 'messages required' });
    }

    debug('Request received:', {
        messageCount: messages.length,
        toolCount: tools?.length || 0,
        systemPromptLength: system?.length || 0,
    });
    debug('Messages:', JSON.stringify(messages.slice(-2), null, 2)); // Last 2 messages

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        debug('Starting stream...');
        const stream = anthropic.messages.stream({
            model: 'claude-3-5-haiku-latest',
            max_tokens: 4096,
            system: system || 'You are a helpful assistant.',
            tools: tools || [],
            messages,
        });

        stream.on('text', (text) => {
            debug('Text chunk:', text.length, 'chars');
            res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
        });

        stream.on('contentBlock', (block) => {
            if (block.type === 'tool_use') {
                debug('Tool use:', block.name, JSON.stringify(block.input).slice(0, 100));
                res.write(`data: ${JSON.stringify({ type: 'tool_use', id: block.id, name: block.name, input: block.input })}\n\n`);
            }
        });

        stream.on('message', (message) => {
            debug('Message complete:', message.stop_reason, message.content.length, 'blocks');
            res.write(`data: ${JSON.stringify({
                type: 'message_end',
                stop_reason: message.stop_reason,
                content: message.content
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        });

        stream.on('error', (error) => {
            debug('Stream error:', error.message);
            console.error('Stream error:', error);
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        });
    } catch (error: any) {
        debug('API error:', error.message);
        console.error('API error:', error);
        res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        res.end();
    }
});

app.listen(port, () => {
    console.log(`Backend proxy running on http://localhost:${port}`);
    if (DEBUG) console.log('[SDK] Debug logging enabled');
});
