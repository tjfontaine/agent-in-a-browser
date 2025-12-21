#!/usr/bin/env npx tsx
/**
 * Quick test script for the agent SDK and backend proxy
 * Run with: npx tsx test-agent.ts
 */

const BACKEND_URL = 'http://localhost:3001';

interface ToolDef {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties: Record<string, any>;
        required?: string[];
    };
}

async function testBackendHealth() {
    console.log('\n=== Testing Backend Health ===');
    try {
        const res = await fetch(`${BACKEND_URL}/health`);
        const data = await res.json();
        console.log('✅ Backend healthy:', data);
        return true;
    } catch (e: any) {
        console.log('❌ Backend not running:', e.message);
        return false;
    }
}

async function testDirectApiCall(tools: ToolDef[], message: string) {
    console.log(`\n=== Testing API with message: "${message}" ===`);
    console.log(`Tools: ${tools.map(t => t.name).join(', ')}`);

    const body = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [
            { role: 'user', content: [{ type: 'text', text: message }] }
        ],
        tools: tools,
        tool_choice: { type: 'auto' }
    };

    try {
        const res = await fetch(`${BACKEND_URL}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const err = await res.text();
            console.log('❌ API Error:', res.status, err);
            return null;
        }

        const data = await res.json();
        console.log('✅ Response received');
        console.log('  Stop reason:', data.stop_reason);

        for (const block of data.content) {
            if (block.type === 'text') {
                console.log('  Text:', block.text.substring(0, 100) + (block.text.length > 100 ? '...' : ''));
            } else if (block.type === 'tool_use') {
                console.log('  Tool use:', block.name);
                console.log('    Input:', JSON.stringify(block.input));
            }
        }

        return data;
    } catch (e: any) {
        console.log('❌ Request failed:', e.message);
        return null;
    }
}

async function main() {
    console.log('🧪 Agent API Test Script\n');

    // Test 1: Backend health
    if (!await testBackendHealth()) {
        console.log('\n⚠️  Start the backend with: cd backend && npm run dev');
        process.exit(1);
    }

    // Test 2: Simple message without tools
    await testDirectApiCall([], 'Say hello in one word');

    // Test 3: Message with run_typescript tool
    const runTypescriptTool: ToolDef = {
        name: 'run_typescript',
        description: 'Execute TypeScript or JavaScript code and return the output',
        input_schema: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'The TypeScript or JavaScript code to execute'
                }
            },
            required: ['code']
        }
    };

    await testDirectApiCall(
        [runTypescriptTool],
        'Calculate 15 * 23 using the run_typescript tool. Use console.log to output the result.'
    );

    // Test 4: Check if tool args are passed
    const evalTool: ToolDef = {
        name: 'eval',
        description: 'Execute JavaScript code',
        input_schema: {
            type: 'object',
            properties: {
                code: { type: 'string' }
            },
            required: ['code']
        }
    };

    await testDirectApiCall(
        [evalTool],
        'Run this code with eval: console.log("Hello World")'
    );

    console.log('\n✅ All tests completed');
}

main().catch(console.error);
