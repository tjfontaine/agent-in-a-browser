import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import express from 'express'
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const port = process.env.PORT || 3001;

// Debug logging helper
const DEBUG = process.env.DEBUG === 'true' || true;
function debug(...args: any[]) {
    if (DEBUG) {
        console.log('[Backend]', new Date().toISOString(), ...args);
    }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize Anthropic client
const anthropic = new Anthropic();

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Anthropic API passthrough handler
 */
async function handleMessages(req: express.Request, res: express.Response) {
    debug('Request:', {
        model: req.body.model,
        messageCount: req.body.messages?.length || 0,
        toolCount: req.body.tools?.length || 0,
        stream: req.body.stream,
    });

    // Debug: log full request body
    debug('Full body:', JSON.stringify(req.body, null, 2));

    // Normalize tool schemas to ensure type: "object" is present
    const normalizedTools = req.body.tools?.map((t: any) => ({
        ...t,
        input_schema: {
            type: 'object',
            ...t.input_schema,
        }
    })) || [];

    debug('Normalized tools:', JSON.stringify(normalizedTools, null, 2));

    try {
        if (req.body.stream) {
            // Streaming response - use raw stream from Anthropic
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const response = await anthropic.messages.create({
                model: req.body.model || 'claude-sonnet-4-5',
                max_tokens: req.body.max_tokens || 4096,
                system: req.body.system,
                tools: normalizedTools,
                messages: req.body.messages,
                stream: true,
            });

            // Pass through the raw SSE events
            for await (const event of response) {
                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
        } else {
            // Non-streaming response
            const response = await anthropic.messages.create({
                model: req.body.model || 'claude-sonnet-4-5',
                max_tokens: req.body.max_tokens || 4096,
                system: req.body.system,
                tools: normalizedTools,
                messages: req.body.messages,
            });

            debug('Response:', {
                stopReason: response.stop_reason,
                contentBlocks: response.content.length,
            });

            res.json(response);
        }
    } catch (error: any) {
        debug('API error:', error.message);
        console.error('API error:', error);
        res.status(error.status || 500).json({
            error: {
                type: error.type || 'api_error',
                message: error.message
            }
        });
    }
}

// Routes - /messages for Vercel AI SDK, /v1/messages for standard Anthropic
app.post('/messages', handleMessages);
app.post('/v1/messages', handleMessages);

app.listen(port, () => {
    console.log(`Backend proxy running on http://localhost:${port}`);
    console.log('Endpoints:');
    console.log(`  POST /messages - Vercel AI SDK compatible`);
    console.log(`  POST /v1/messages - Anthropic API passthrough`);
    console.log(`  GET  /health - Health check`);
    if (DEBUG) console.log('[Backend] Debug logging enabled');
});

