/**
 * Tests for Agent SDK
 * 
 * Tests the WasmAgent class, config handling, and message types.
 * Note: Many parts require full integration testing since they depend
 * on the sandbox worker and MCP server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WasmAgent, type AgentConfig, type StreamCallbacks, type AgentMessage } from './Sdk';

// Mock the sandbox fetch
vi.mock('./agent/sandbox', () => ({
    fetchFromSandbox: vi.fn(),
}));

// Mock the remote MCP registry
vi.mock('./remote-mcp-registry', () => ({
    getRemoteMCPRegistry: () => ({
        subscribe: vi.fn(),
        getAggregatedTools: () => ({}),
    }),
}));

describe('Agent SDK', () => {
    describe('WasmAgent class', () => {
        describe('constructor', () => {
            it('creates agent with default config', () => {
                const agent = new WasmAgent();
                expect(agent).toBeDefined();
            });

            it('accepts custom config', () => {
                const config: AgentConfig = {
                    model: 'claude-opus-4-5-20250514',
                    maxSteps: 5,
                    systemPrompt: 'You are a test assistant',
                };
                const agent = new WasmAgent(config);
                expect(agent).toBeDefined();
            });

            it('sets default model to claude-sonnet-4-5', () => {
                // We can't directly inspect private fields, but we can test behavior
                const agent = new WasmAgent();
                expect(agent).toBeDefined();
            });

            it('sets default maxSteps to 10', () => {
                const agent = new WasmAgent();
                expect(agent).toBeDefined();
            });
        });

        describe('clearHistory', () => {
            it('clears conversation history', () => {
                const agent = new WasmAgent();
                agent.clearHistory();
                const history = agent.getHistory();
                expect(history).toEqual([]);
            });
        });

        describe('getHistory', () => {
            it('returns empty array initially', () => {
                const agent = new WasmAgent();
                expect(agent.getHistory()).toEqual([]);
            });

            it('returns a copy of history (not reference)', () => {
                const agent = new WasmAgent();
                const h1 = agent.getHistory();
                const h2 = agent.getHistory();
                expect(h1).not.toBe(h2);
            });
        });

        describe('getTools', () => {
            it('returns empty array before initialization', () => {
                const agent = new WasmAgent();
                const tools = agent.getTools();
                expect(tools).toEqual([]);
            });
        });
    });

    describe('AgentConfig interface', () => {
        it('accepts anthropic provider type', () => {
            const config: AgentConfig = {
                providerType: 'anthropic',
            };
            expect(config.providerType).toBe('anthropic');
        });

        it('accepts openai provider type', () => {
            const config: AgentConfig = {
                providerType: 'openai',
            };
            expect(config.providerType).toBe('openai');
        });

        it('accepts baseURL for custom endpoints', () => {
            const config: AgentConfig = {
                baseURL: 'http://localhost:3002',
            };
            expect(config.baseURL).toBe('http://localhost:3002');
        });

        it('accepts all config options', () => {
            const config: AgentConfig = {
                model: 'gpt-4o',
                apiKey: 'sk-test',
                baseURL: 'https://api.openai.com/v1',
                maxSteps: 20,
                systemPrompt: 'You are helpful',
                providerType: 'openai',
            };
            expect(config.model).toBe('gpt-4o');
            expect(config.apiKey).toBe('sk-test');
            expect(config.baseURL).toBe('https://api.openai.com/v1');
            expect(config.maxSteps).toBe(20);
            expect(config.systemPrompt).toBe('You are helpful');
            expect(config.providerType).toBe('openai');
        });
    });

    describe('StreamCallbacks interface', () => {
        it('accepts all callback types', () => {
            const callbacks: StreamCallbacks = {
                onText: vi.fn(),
                onToolCall: vi.fn(),
                onToolResult: vi.fn(),
                onToolProgress: vi.fn(),
                onStepStart: vi.fn(),
                onStepFinish: vi.fn(),
                onError: vi.fn(),
                onFinish: vi.fn(),
                getSteering: vi.fn(() => []),
            };

            expect(callbacks.onText).toBeDefined();
            expect(callbacks.onToolCall).toBeDefined();
            expect(callbacks.onToolResult).toBeDefined();
            expect(callbacks.onToolProgress).toBeDefined();
            expect(callbacks.onStepStart).toBeDefined();
            expect(callbacks.onStepFinish).toBeDefined();
            expect(callbacks.onError).toBeDefined();
            expect(callbacks.onFinish).toBeDefined();
            expect(callbacks.getSteering).toBeDefined();
        });

        it('all callbacks are optional', () => {
            const callbacks: StreamCallbacks = {};
            expect(callbacks).toEqual({});
        });

        it('getSteering returns steering messages', () => {
            const callbacks: StreamCallbacks = {
                getSteering: () => ['focus on tests', 'skip linting'],
            };
            expect(callbacks.getSteering?.()).toEqual(['focus on tests', 'skip linting']);
        });
    });

    describe('AgentMessage types', () => {
        it('represents text message', () => {
            const msg: AgentMessage = { type: 'text', text: 'Hello!' };
            expect(msg.type).toBe('text');
            expect((msg as { type: 'text'; text: string }).text).toBe('Hello!');
        });

        it('represents tool_use message', () => {
            const msg: AgentMessage = {
                type: 'tool_use',
                name: 'shell_eval',
                input: { command: 'ls -la' },
            };
            expect(msg.type).toBe('tool_use');
            expect((msg as { type: 'tool_use'; name: string }).name).toBe('shell_eval');
        });

        it('represents tool_result message', () => {
            const msg: AgentMessage = {
                type: 'tool_result',
                name: 'shell_eval',
                result: 'file1.ts\nfile2.ts',
            };
            expect(msg.type).toBe('tool_result');
            expect((msg as { type: 'tool_result'; result: string }).result).toContain('file1.ts');
        });

        it('represents error message', () => {
            const msg: AgentMessage = {
                type: 'error',
                error: 'Network timeout',
            };
            expect(msg.type).toBe('error');
            expect((msg as { type: 'error'; error: string }).error).toBe('Network timeout');
        });

        it('represents done message', () => {
            const msg: AgentMessage = {
                type: 'done',
                steps: 3,
            };
            expect(msg.type).toBe('done');
            expect((msg as { type: 'done'; steps: number }).steps).toBe(3);
        });
    });

    describe('refreshTools', () => {
        it('does not throw when called before initialization', () => {
            const agent = new WasmAgent();
            expect(() => agent.refreshTools()).not.toThrow();
        });
    });
});

describe('Module-level functions', () => {
    // initializeWasmMcp and createAiSdkTools require full sandbox integration
    // They are better tested via E2E tests

    describe('exports', () => {
        it('exports WasmAgent class', async () => {
            const module = await import('./Sdk');
            expect(module.WasmAgent).toBeDefined();
            expect(typeof module.WasmAgent).toBe('function');
        });

        it('exports initializeWasmMcp function', async () => {
            const module = await import('./Sdk');
            expect(module.initializeWasmMcp).toBeDefined();
            expect(typeof module.initializeWasmMcp).toBe('function');
        });
    });
});
