const output = document.getElementById('output')!;

function log(msg: string, type: 'info' | 'error' | 'success' = 'info') {
    const div = document.createElement('div');
    div.className = `log ${type}`;
    div.textContent = `[${new Date().toISOString().split('T')[1]?.slice(0, -1)}] ${msg}`;
    div.style.color = type === 'error' ? 'red' : type === 'success' ? 'green' : '#333';
    output.appendChild(div);
    console.log(msg);
}

const worker = new Worker(new URL('./sandbox-worker.ts', import.meta.url), { type: 'module' });

let pendingResolvers = new Map<string, (result: any) => void>();
let nextId = 1;

worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'ready') {
        log('Sandbox Worker Ready', 'success');
        runTests();
    } else if (data.type === 'tool_result') {
        const resolve = pendingResolvers.get(data.id);
        if (resolve) {
            pendingResolvers.delete(data.id);
            resolve(data.result);
        }
    } else if (data.type === 'log') {
        // Legacy logs
        log(`Worker Log: ${data.message}`);
    } else if (data.type === 'error') {
        log(`Worker Error: ${data.message}`, 'error');
    }
};

function callTool(name: string, input: any): Promise<any> {
    return new Promise((resolve) => {
        const id = String(nextId++);
        pendingResolvers.set(id, resolve);
        worker.postMessage({ type: 'call_tool', id, tool: { name, input } });
    });
}

async function runTests() {
    log('Starting tests...');

    try {
        // Test 1: Console
        log('Test 1: Console execution');
        let res = await callTool('execute', { code: 'console.log("Hello Harness")' });
        if (res.success && res.output.includes('Hello Harness')) {
            log('Test 1 Passed', 'success');
        } else {
            log(`Test 1 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 2a: Fetch Status (Basic Async)
        log('Test 2a: Fetch Status');
        res = await callTool('execute_typescript', {
            code: `
                console.log('Fetching 2a...');
                const r = await fetch('https://jsonplaceholder.typicode.com/todos/1'); 
                console.log('Status 2a:', r.status);
            `
        });
        if (res.success && res.output.includes('Status 2a: 200')) {
            log('Test 2a Passed', 'success');
        } else {
            log(`Test 2a Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 2b: Fetch Text
        log('Test 2b: Fetch Text');
        res = await callTool('execute_typescript', {
            code: `
                console.log('Fetching 2b...');
                const r = await fetch('https://jsonplaceholder.typicode.com/todos/1'); 
                const t = await r.text();
                console.log('Text length:', t.length);
            `
        });
        if (res.success && res.output.includes('Text length:')) {
            log('Test 2b Passed', 'success');
        } else {
            log(`Test 2b Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 2c: Fetch JSON
        log('Test 2c: Fetch JSON');
        res = await callTool('execute_typescript', {
            code: `
                console.log('Fetching 2c...');
                const r = await fetch('https://jsonplaceholder.typicode.com/todos/1'); 
                const j = await r.json(); 
                console.log("Fetched ID:", j.id);
            `
        });
        if (res.success && res.output.includes('Fetched ID: 1')) {
            log('Test 2c Passed', 'success');
        } else {
            log(`Test 2c Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 3: FS (OPFS)
        log('Test 3: File System');
        await callTool('write_file', { path: '/test.txt', content: 'hello harness' });
        res = await callTool('read_file', { path: '/test.txt' });
        if (res.success && res.output === 'hello harness') {
            log('Test 3 Passed', 'success');
        } else {
            log(`Test 3 Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 3b: FS (QuickJS)
        log('Test 3b: File System (QuickJS)');
        res = await callTool('execute_typescript', {
            code: `
                const path = '/test-quickjs.txt';
                await fs.promises.writeFile(path, 'from quickjs');
                const content = await fs.promises.readFile(path);
                console.log('Read:', content);
            `
        });
        if (res.success && res.output.includes('Read: from quickjs')) {
            log('Test 3b Passed', 'success');
        } else {
            log(`Test 3b Failed: ${JSON.stringify(res)}`, 'error');
        }

        // Test 4: Timeout (Infinite Loop)
        log('Test 4: Timeout (Infinite Loop)');
        res = await callTool('execute', { code: 'while(true){}' });
        // Error message might vary but should indicate timeout
        if (res.success === false && (res.error?.includes('timed out') || res.error?.includes('interrupted'))) {
            log('Test 4 Passed (Correctly timed out)', 'success');
        } else {
            log(`Test 4 Failed: Expected timeout, got ${JSON.stringify(res)}`, 'error');
        }

        // Test 5: Recovery after timeout
        log('Test 5: Recovery check');
        res = await callTool('execute', { code: 'console.log("Recovered")' });
        if (res.success && res.output.includes('Recovered')) {
            log('Test 5 Passed', 'success');
        } else {
            log(`Test 5 Failed: Context did not recover. ${JSON.stringify(res)}`, 'error');
        }

        log('All tests completed.');

    } catch (e: any) {
        log(`Harness Error: ${e.message}`, 'error');
    }
}
