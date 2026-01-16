/**
 * HuggingFace Transformers.js Transport Handler
 * 
 * Intercepts HTTP requests to `http://webllm.local/v1/*` and routes them
 * to the local transformers.js text-generation pipeline with an 
 * OpenAI-compatible API wrapper including prompt-based tool calling.
 */

import type { TransportResponse } from './wasi-http-impl.js';

// Types for text-generation pipeline
type TextStreamer = {
    put(tokens: unknown): void;
    end(): void;
};

type Pipeline = (
    text: string | string[],
    options?: {
        max_new_tokens?: number;
        do_sample?: boolean;
        temperature?: number;
        return_full_text?: boolean;
        streamer?: TextStreamer;
    }
) => Promise<Array<{ generated_text: string }>>;

type TextGenerationPipeline = Pipeline & {
    tokenizer?: {
        apply_chat_template?(
            messages: ChatMessage[],
            options?: { tokenize?: boolean; add_generation_prompt?: boolean }
        ): string;
    };
};

interface ChatMessage {
    role: string;
    content: string;
}

interface ToolDefinition {
    type: string;
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

interface ChatCompletionRequest {
    model?: string;
    messages: ChatMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    tools?: ToolDefinition[];
    tool_choice?: unknown;
}

interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

interface ChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string | null;
            tool_calls?: ToolCall[];
        };
        finish_reason: string;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

interface ChatCompletionChunk {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
            }>;
        };
        finish_reason: string | null;
    }>;
}

// Module state
let generator: TextGenerationPipeline | null = null;
let loadedModel: string | null = null;
let isLoading = false;

// Progress callback
export type HFProgressCallback = (info: { status: string; progress?: number; file?: string }) => void;
let progressCallback: HFProgressCallback | null = null;

export function setHFProgressCallback(cb: HFProgressCallback | null): void {
    progressCallback = cb;
}

// Re-export as isWebLLMUrl for compatibility
export function isWebLLMUrl(url: string): boolean {
    return url.startsWith('http://webllm.local/') || url.startsWith('https://webllm.local/');
}

export async function unloadHF(): Promise<void> {
    generator = null;
    loadedModel = null;
}

/**
 * Get or create text-generation pipeline
 */
async function getOrCreatePipeline(modelId: string): Promise<TextGenerationPipeline> {
    if (generator && loadedModel === modelId) {
        return generator;
    }

    if (isLoading) {
        throw new Error('Model is currently loading');
    }

    if (generator && loadedModel !== modelId) {
        await unloadHF();
    }

    isLoading = true;
    try {
        const transformers = await import('@huggingface/transformers');
        console.log(`[HF] Loading model: ${modelId}`);

        // CRITICAL: Disable ONNX multi-threading to avoid "Aborted()" bug on Apple Silicon
        // This must be set BEFORE loading the model
        // https://github.com/huggingface/transformers.js/issues/503
        try {
            const env = (transformers as unknown as { env: { backends: { onnx: { wasm: { numThreads: number; proxy: boolean } } } } }).env;
            if (env) {
                env.backends = env.backends || {} as { onnx: { wasm: { numThreads: number; proxy: boolean } } };
                env.backends.onnx = env.backends.onnx || {} as { wasm: { numThreads: number; proxy: boolean } };
                env.backends.onnx.wasm = env.backends.onnx.wasm || {} as { numThreads: number; proxy: boolean };
                env.backends.onnx.wasm.numThreads = 1;
                env.backends.onnx.wasm.proxy = false;  // Don't use web worker proxy
                console.log('[HF] ONNX settings: numThreads=1, proxy=false');
            }
            // Also try to set ort.env.wasm directly if available in window
            const ortEnv = (globalThis as unknown as { ort?: { env?: { wasm?: { numThreads?: number; proxy?: boolean } } } }).ort?.env;
            if (ortEnv?.wasm) {
                ortEnv.wasm.numThreads = 1;
                ortEnv.wasm.proxy = false;
                console.log('[HF] ort.env.wasm also configured');
            }
        } catch (e) {
            console.warn('[HF] Could not set ONNX env:', e);
        }


        // Try WebGPU first (works on Apple Silicon), fall back to WASM
        const configs = [
            { device: 'webgpu' as const, name: 'WebGPU' },  // Preferred on Apple Silicon
            { device: undefined, name: 'WASM' }             // Fallback
        ];

        let lastError: unknown = null;
        for (const config of configs) {
            try {
                console.log(`[HF] Trying ${config.name}...`);
                generator = await transformers.pipeline('text-generation', modelId, {
                    device: config.device,
                    dtype: 'q4',
                    progress_callback: (p: { status: string; progress?: number }) => {
                        console.log(`[HF] ${p.status}${p.progress ? ` (${Math.round(p.progress)}%)` : ''}`);
                        progressCallback?.(p);
                    }
                }) as unknown as TextGenerationPipeline;

                loadedModel = modelId;
                console.log(`[HF] Model loaded (${config.name}): ${modelId}`);
                return generator;
            } catch (e) {
                lastError = e;
                const msg = e instanceof Error ? e.message : String(e);
                console.warn(`[HF] ${config.name} failed: ${msg}`);
                // If it's an Aborted error, try next config
                if (msg.includes('Aborted')) continue;
                // For other errors, throw immediately
                throw e;
            }
        }

        // All configs failed
        throw lastError || new Error('Failed to load model with any backend');
    } finally {
        isLoading = false;
    }
}

/**
 * Format tools into system prompt for prompt-based tool calling
 */
function formatToolsForPrompt(tools: ToolDefinition[]): string {
    const toolDescriptions = tools.map(t => {
        const f = t.function;
        return `- ${f.name}: ${f.description}
  Parameters: ${JSON.stringify(f.parameters, null, 2)}`;
    }).join('\n\n');

    return `You have access to the following tools:

${toolDescriptions}

When you need to use a tool, respond with a JSON object in this exact format:
{"tool_calls": [{"name": "tool_name", "arguments": {"arg1": "value1"}}]}

Only use this format when you need to call a tool. For normal responses, just reply with text.`;
}

/**
 * Parse tool calls from model output
 */
function parseToolCalls(output: string): ToolCall[] | null {
    // Try to find JSON with tool_calls
    const jsonMatch = output.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.tool_calls)) {
            return parsed.tool_calls.map((tc: { name: string; arguments: Record<string, unknown> }, i: number) => ({
                id: `call_${Date.now()}_${i}`,
                type: 'function' as const,
                function: {
                    name: tc.name,
                    arguments: typeof tc.arguments === 'string'
                        ? tc.arguments
                        : JSON.stringify(tc.arguments)
                }
            }));
        }
    } catch {
        // Not valid JSON
    }
    return null;
}

/**
 * Apply chat template or use fallback
 */
function applyTemplate(gen: TextGenerationPipeline, messages: ChatMessage[]): string {
    if (gen.tokenizer?.apply_chat_template) {
        try {
            return gen.tokenizer.apply_chat_template(messages, {
                tokenize: false,
                add_generation_prompt: true
            }) as unknown as string;
        } catch { /* fall through */ }
    }

    // ChatML fallback
    let prompt = '';
    for (const msg of messages) {
        prompt += `<|${msg.role}|>\n${msg.content}\n`;
    }
    prompt += '<|assistant|>\n';
    return prompt;
}

/**
 * Normalize message content (array format → string)
 */
function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(msg => {
        let content = msg.content;
        if (Array.isArray(content)) {
            content = (content as Array<{ type?: string; text?: string }>)
                .filter(p => p.type === 'text' || !p.type)
                .map(p => p.text || '')
                .join('');
        }
        return { ...msg, content: content as string };
    });
}

/**
 * Handle an HTTP request to the WebLLM virtual endpoint.
 */
export async function handleWebLLMRequest(
    method: string,
    url: string,
    _headers: Record<string, string>,
    body: Uint8Array | null
): Promise<TransportResponse> {
    const encoder = new TextEncoder();

    try {
        const parsedUrl = new URL(url);
        const path = parsedUrl.pathname;

        // POST /v1/chat/completions
        if (method === 'POST' && path === '/v1/chat/completions') {
            if (!body) {
                return {
                    status: 400,
                    headers: [['content-type', encoder.encode('application/json')]],
                    body: encoder.encode(JSON.stringify({ error: 'Missing request body' }))
                };
            }

            const request = JSON.parse(new TextDecoder().decode(body)) as ChatCompletionRequest;
            const modelId = request.model || 'HuggingFaceTB/SmolLM2-360M-Instruct';

            const gen = await getOrCreatePipeline(modelId);

            // Normalize messages
            let messages = normalizeMessages(request.messages);

            // Inject tools into system prompt if provided
            if (request.tools && request.tools.length > 0) {
                const toolPrompt = formatToolsForPrompt(request.tools);
                const hasSystem = messages.some(m => m.role === 'system');
                if (hasSystem) {
                    messages = messages.map(m =>
                        m.role === 'system'
                            ? { ...m, content: m.content + '\n\n' + toolPrompt }
                            : m
                    );
                } else {
                    messages = [{ role: 'system', content: toolPrompt }, ...messages];
                }
            }

            const prompt = applyTemplate(gen, messages);
            const maxTokens = request.max_tokens || 2048;
            const temperature = request.temperature ?? 0.7;

            // Non-streaming
            if (!request.stream) {
                const outputs = await gen(prompt, {
                    max_new_tokens: maxTokens,
                    do_sample: temperature > 0,
                    temperature: temperature,
                    return_full_text: false
                });

                const generatedText = outputs[0]?.generated_text || '';
                const toolCalls = parseToolCalls(generatedText);

                const response: ChatCompletionResponse = {
                    id: 'chatcmpl-' + Date.now(),
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: modelId,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: toolCalls ? null : generatedText,
                            tool_calls: toolCalls || undefined
                        },
                        finish_reason: toolCalls ? 'tool_calls' : 'stop'
                    }],
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                };

                return {
                    status: 200,
                    headers: [['content-type', encoder.encode('application/json')]],
                    body: encoder.encode(JSON.stringify(response))
                };
            }

            // Streaming - collect tokens then return as SSE
            const outputs = await gen(prompt, {
                max_new_tokens: maxTokens,
                do_sample: temperature > 0,
                temperature: temperature,
                return_full_text: false
            });

            const generatedText = outputs[0]?.generated_text || '';
            const toolCalls = parseToolCalls(generatedText);

            // Build SSE response
            const sseLines: string[] = [];
            const baseChunk = {
                id: 'chatcmpl-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId
            };

            if (toolCalls) {
                // Emit tool calls
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const chunk: ChatCompletionChunk = {
                        ...baseChunk,
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index: i,
                                    id: tc.id,
                                    type: 'function',
                                    function: { name: tc.function.name, arguments: tc.function.arguments }
                                }]
                            },
                            finish_reason: null
                        }]
                    };
                    sseLines.push(`data: ${JSON.stringify(chunk)}\n\n`);
                }
            } else {
                // Emit content in chunks
                const chunkSize = 20;
                for (let i = 0; i < generatedText.length; i += chunkSize) {
                    const chunk: ChatCompletionChunk = {
                        ...baseChunk,
                        choices: [{
                            index: 0,
                            delta: { content: generatedText.slice(i, i + chunkSize) },
                            finish_reason: null
                        }]
                    };
                    sseLines.push(`data: ${JSON.stringify(chunk)}\n\n`);
                }
            }

            // Final chunk
            sseLines.push(`data: ${JSON.stringify({
                ...baseChunk,
                choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? 'tool_calls' : 'stop' }]
            })}\n\n`);
            sseLines.push('data: [DONE]\n\n');

            return {
                status: 200,
                headers: [
                    ['content-type', encoder.encode('text/event-stream')],
                    ['cache-control', encoder.encode('no-cache')]
                ],
                body: encoder.encode(sseLines.join(''))
            };
        }

        // GET /v1/models
        if (method === 'GET' && path === '/v1/models') {
            const models = {
                object: 'list',
                data: [
                    { id: 'onnx-community/Qwen3-0.6B-ONNX', object: 'model', owned_by: 'onnx-community' },
                    { id: 'HuggingFaceTB/SmolLM2-360M-Instruct', object: 'model', owned_by: 'huggingface' },
                    { id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', object: 'model', owned_by: 'huggingface' },
                    { id: 'Qwen/Qwen2.5-0.5B-Instruct', object: 'model', owned_by: 'qwen' }
                ]
            };
            return {
                status: 200,
                headers: [['content-type', encoder.encode('application/json')]],
                body: encoder.encode(JSON.stringify(models))
            };
        }

        return {
            status: 404,
            headers: [['content-type', encoder.encode('application/json')]],
            body: encoder.encode(JSON.stringify({ error: `Unknown endpoint: ${method} ${path}` }))
        };

    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('[HF] Error:', errMsg);

        // Return error as SSE stream so rig-core can handle it gracefully
        // This prevents the TUI from crashing on errors
        const errorChunk = {
            id: 'error-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'local',
            choices: [{
                index: 0,
                delta: {
                    content: `[Local LLM Error: ${errMsg}. This may be a browser compatibility issue. Try a different browser or check the console for details.]`
                },
                finish_reason: 'stop'
            }]
        };

        return {
            status: 200,
            headers: [
                ['content-type', encoder.encode('text/event-stream')],
                ['cache-control', encoder.encode('no-cache')]
            ],
            body: encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\ndata: [DONE]\n\n`)
        };
    }
}
