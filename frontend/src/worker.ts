// Simple in-memory filesystem for POC
// Can be upgraded to Wasmer-JS WASI later

interface FSNode {
    type: 'file' | 'dir';
    content?: string;
    children?: Map<string, FSNode>;
}

class VirtualFileSystem {
    private root: FSNode = { type: 'dir', children: new Map() };
    private cwd: string = '/';

    private resolvePath(path: string): string[] {
        const parts = path.startsWith('/') ? path.split('/') : [...this.cwd.split('/'), ...path.split('/')];
        const resolved: string[] = [];
        for (const part of parts) {
            if (part === '' || part === '.') continue;
            if (part === '..') resolved.pop();
            else resolved.push(part);
        }
        return resolved;
    }

    private getNode(parts: string[]): FSNode | null {
        let node = this.root;
        for (const part of parts) {
            if (node.type !== 'dir' || !node.children?.has(part)) return null;
            node = node.children.get(part)!;
        }
        return node;
    }

    private getParentAndName(parts: string[]): { parent: FSNode; name: string } | null {
        if (parts.length === 0) return null;
        const name = parts[parts.length - 1];
        const parentParts = parts.slice(0, -1);
        const parent = parentParts.length === 0 ? this.root : this.getNode(parentParts);
        if (!parent || parent.type !== 'dir') return null;
        return { parent, name };
    }

    ls(path: string = '.'): string {
        const parts = this.resolvePath(path);
        const node = parts.length === 0 ? this.root : this.getNode(parts);
        if (!node) return `ls: ${path}: No such file or directory`;
        if (node.type === 'file') return path;
        const entries = Array.from(node.children?.keys() || []);
        return entries.length ? entries.join('\n') : '';
    }

    cat(path: string): string {
        const parts = this.resolvePath(path);
        const node = this.getNode(parts);
        if (!node) return `cat: ${path}: No such file or directory`;
        if (node.type === 'dir') return `cat: ${path}: Is a directory`;
        return node.content || '';
    }

    echo(args: string[], redirect?: { op: string; file: string }): string {
        const output = args.join(' ');
        if (redirect) {
            const parts = this.resolvePath(redirect.file);
            const pn = this.getParentAndName(parts);
            if (!pn) return `echo: cannot create ${redirect.file}: No such file or directory`;
            const existing = pn.parent.children?.get(pn.name);
            if (redirect.op === '>') {
                pn.parent.children!.set(pn.name, { type: 'file', content: output + '\n' });
            } else if (redirect.op === '>>') {
                const prev = existing?.type === 'file' ? existing.content || '' : '';
                pn.parent.children!.set(pn.name, { type: 'file', content: prev + output + '\n' });
            }
            return '';
        }
        return output;
    }

    mkdir(path: string): string {
        const parts = this.resolvePath(path);
        const pn = this.getParentAndName(parts);
        if (!pn) return `mkdir: cannot create directory '${path}': No such file or directory`;
        if (pn.parent.children?.has(pn.name)) return `mkdir: cannot create directory '${path}': File exists`;
        pn.parent.children!.set(pn.name, { type: 'dir', children: new Map() });
        return '';
    }

    rm(path: string): string {
        const parts = this.resolvePath(path);
        const pn = this.getParentAndName(parts);
        if (!pn) return `rm: cannot remove '${path}': No such file or directory`;
        if (!pn.parent.children?.has(pn.name)) return `rm: cannot remove '${path}': No such file or directory`;
        pn.parent.children!.delete(pn.name);
        return '';
    }

    pwd(): string {
        return this.cwd;
    }

    cd(path: string): string {
        const parts = this.resolvePath(path);
        const node = parts.length === 0 ? this.root : this.getNode(parts);
        if (!node) return `cd: ${path}: No such file or directory`;
        if (node.type !== 'dir') return `cd: ${path}: Not a directory`;
        this.cwd = '/' + parts.join('/');
        return '';
    }
}

const fs = new VirtualFileSystem();

function parseCommand(command: string): { cmd: string; args: string[]; redirect?: { op: string; file: string } } {
    // Simple tokenizer
    const tokens: string[] = [];
    let current = '';
    let inQuote = '';

    for (const char of command) {
        if (inQuote) {
            if (char === inQuote) inQuote = '';
            else current += char;
        } else if (char === '"' || char === "'") {
            inQuote = char;
        } else if (char === ' ') {
            if (current) tokens.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    if (current) tokens.push(current);

    // Check for redirect
    let redirect: { op: string; file: string } | undefined;
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === '>' || tokens[i] === '>>') {
            redirect = { op: tokens[i], file: tokens[i + 1] };
            tokens.splice(i);
            break;
        } else if (tokens[i].startsWith('>>')) {
            redirect = { op: '>>', file: tokens[i].slice(2) };
            tokens.splice(i);
            break;
        } else if (tokens[i].startsWith('>')) {
            redirect = { op: '>', file: tokens[i].slice(1) };
            tokens.splice(i);
            break;
        }
    }

    return { cmd: tokens[0] || '', args: tokens.slice(1), redirect };
}

function executeCommand(command: string): string {
    // Handle command chaining with &&
    const commands = command.split('&&').map(c => c.trim());
    const outputs: string[] = [];

    for (const cmd of commands) {
        const { cmd: name, args, redirect } = parseCommand(cmd);
        let output = '';

        switch (name) {
            case 'ls':
                output = fs.ls(args[0]);
                break;
            case 'cat':
                output = fs.cat(args[0]);
                break;
            case 'echo':
                output = fs.echo(args, redirect);
                break;
            case 'mkdir':
                output = fs.mkdir(args[0]);
                break;
            case 'rm':
                output = fs.rm(args[0]);
                break;
            case 'pwd':
                output = fs.pwd();
                break;
            case 'cd':
                output = fs.cd(args[0] || '/');
                break;
            case 'touch':
                const parts = args[0]?.split('/').filter(Boolean) || [];
                if (parts.length > 0) {
                    const content = '';
                    fs.echo([content], { op: '>', file: args[0] });
                }
                break;
            case '':
                break;
            default:
                output = `${name}: command not found`;
        }

        if (output) outputs.push(output);
    }

    return outputs.join('\n');
}

// Worker message handler
self.onmessage = (event: MessageEvent) => {
    const { type, id, command } = event.data;

    if (type === 'execute') {
        try {
            const output = executeCommand(command);
            self.postMessage({ type: 'result', id, output });
        } catch (error: any) {
            self.postMessage({ type: 'result', id, output: `Error: ${error.message}` });
        }
    }
};

// Signal that worker is ready
self.postMessage({ type: 'ready' });
