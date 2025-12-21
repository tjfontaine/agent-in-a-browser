/**
 * Tests for Slash Command Parser
 */
import { describe, it, expect } from 'vitest';
import { parseSlashCommand, getCommandUsage } from './command-parser';

describe('parseSlashCommand', () => {
    it('returns null for non-slash input', () => {
        expect(parseSlashCommand('hello')).toBeNull();
        expect(parseSlashCommand('')).toBeNull();
        expect(parseSlashCommand('  ')).toBeNull();
    });

    it('parses simple command', () => {
        const result = parseSlashCommand('/help');
        expect(result).toEqual({
            command: 'help',
            subcommand: null,
            args: [],
            options: {},
            raw: '/help',
        });
    });

    it('parses command with subcommand', () => {
        const result = parseSlashCommand('/mcp add');
        expect(result).toEqual({
            command: 'mcp',
            subcommand: 'add',
            args: [],
            options: {},
            raw: '/mcp add',
        });
    });

    it('parses command with subcommand and args', () => {
        const result = parseSlashCommand('/mcp add https://example.com');
        expect(result).toEqual({
            command: 'mcp',
            subcommand: 'add',
            args: ['https://example.com'],
            options: {},
            raw: '/mcp add https://example.com',
        });
    });

    it('parses long-form options', () => {
        const result = parseSlashCommand('/mcp add https://example.com --name MyServer');
        expect(result).toEqual({
            command: 'mcp',
            subcommand: 'add',
            args: ['https://example.com'],
            options: { name: 'MyServer' },
            raw: '/mcp add https://example.com --name MyServer',
        });
    });

    it('parses boolean flags', () => {
        const result = parseSlashCommand('/mcp list --verbose');
        expect(result).toEqual({
            command: 'mcp',
            subcommand: 'list',
            args: [],
            options: { verbose: true },
            raw: '/mcp list --verbose',
        });
    });

    it('parses short flags', () => {
        const result = parseSlashCommand('/files -a');
        expect(result).toEqual({
            command: 'files',
            subcommand: null,
            args: [],
            options: { a: true },
            raw: '/files -a',
        });
    });

    it('handles quoted strings', () => {
        const result = parseSlashCommand('/mcp add https://example.com --name "My Server"');
        expect(result).toEqual({
            command: 'mcp',
            subcommand: 'add',
            args: ['https://example.com'],
            options: { name: 'My Server' },
            raw: '/mcp add https://example.com --name "My Server"',
        });
    });

    it('handles single-quoted strings', () => {
        const result = parseSlashCommand("/mcp add url --desc 'A description'");
        expect(result).toEqual({
            command: 'mcp',
            subcommand: 'add',
            args: ['url'],
            options: { desc: 'A description' },
            raw: "/mcp add url --desc 'A description'",
        });
    });

    it('lowercases the command', () => {
        const result = parseSlashCommand('/HELP');
        expect(result?.command).toBe('help');
    });
});

describe('getCommandUsage', () => {
    it('returns usage for known commands', () => {
        expect(getCommandUsage('mcp')).toBe('/mcp <add|remove|auth|connect|disconnect|list>');
    });

    it('returns simple usage for commands without subcommands', () => {
        expect(getCommandUsage('clear')).toBe('/clear');
    });

    it('returns null for unknown commands', () => {
        expect(getCommandUsage('unknown')).toBeNull();
    });
});
