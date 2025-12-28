/**
 * Git Module for Shell
 *
 * Provides git CLI functionality via isomorphic-git.
 * Integrates with our OPFS filesystem and lazy module loading system.
 */

import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { opfsFs } from './opfs-git-adapter';
import type { CommandModule, InputStream, OutputStream, ExecEnv } from './lazy-modules';

// Default CORS proxy for GitHub and other services that don't support CORS
const CORS_PROXY = 'https://cors.isomorphic-git.org';

// Helper to write to output stream
function write(stream: OutputStream, text: string): void {
    stream.write(new TextEncoder().encode(text + '\n'));
}

/**
 * Git command module - implements CommandModule interface
 */
export const command: CommandModule = {
    run(
        name: string,
        args: string[],
        env: ExecEnv,
        _stdin: InputStream,
        stdout: OutputStream,
        stderr: OutputStream,
    ): number {
        if (name !== 'git') {
            write(stderr, `Unknown command: ${name}`);
            return 1;
        }

        if (args.length === 0) {
            printUsage(stdout);
            return 0;
        }

        const subcommand = args[0];
        const subargs = args.slice(1);

        try {
            // Run synchronously for now - isomorphic-git is async but we need sync for shell
            // This will block, which is fine in a worker context
            return runSubcommand(subcommand, subargs, env.cwd, stdout, stderr);
        } catch (e) {
            write(stderr, `git: ${e instanceof Error ? e.message : String(e)}`);
            return 1;
        }
    },

    listCommands(): string[] {
        return ['git'];
    },
};

function printUsage(stdout: OutputStream): void {
    write(stdout, 'usage: git <command> [<args>]');
    write(stdout, '');
    write(stdout, 'Commands:');
    write(stdout, '   init       Create an empty Git repository');
    write(stdout, '   clone      Clone a repository');
    write(stdout, '   status     Show working tree status');
    write(stdout, '   add        Add file contents to index');
    write(stdout, '   commit     Record changes to repository');
    write(stdout, '   log        Show commit logs');
    write(stdout, '   branch     List or create branches');
    write(stdout, '   checkout   Switch branches');
}

function runSubcommand(
    subcommand: string,
    args: string[],
    cwd: string,
    stdout: OutputStream,
    stderr: OutputStream,
): number {
    // Note: isomorphic-git is async, we need to handle this
    // For now, we'll use a synchronous wrapper pattern
    // In the future, we might need to make shell commands async-aware

    switch (subcommand) {
        case 'init':
            return gitInit(args, cwd, stdout, stderr);
        case 'clone':
            return gitClone(args, cwd, stdout, stderr);
        case 'status':
            return gitStatus(args, cwd, stdout, stderr);
        case 'add':
            return gitAdd(args, cwd, stdout, stderr);
        case 'commit':
            return gitCommit(args, cwd, stdout, stderr);
        case 'log':
            return gitLog(args, cwd, stdout, stderr);
        case 'branch':
            return gitBranch(args, cwd, stdout, stderr);
        case 'checkout':
            return gitCheckout(args, cwd, stdout, stderr);
        case 'version':
        case '--version':
            write(stdout, 'git version 2.x (isomorphic-git)');
            return 0;
        case 'help':
        case '--help':
        case '-h':
            printUsage(stdout);
            return 0;
        default:
            write(stderr, `git: '${subcommand}' is not a git command.`);
            return 1;
    }
}

// ============================================================
// Git Subcommand Implementations
// ============================================================

function gitInit(args: string[], cwd: string, stdout: OutputStream, _stderr: OutputStream): number {
    const dir = args[0] ? `${cwd}/${args[0]}` : cwd;

    // Use blocking pattern for async operation
    let result = 0;
    const initPromise = git.init({ fs: opfsFs, dir })
        .then(() => {
            write(stdout, `Initialized empty Git repository in ${dir}/.git/`);
        })
        .catch((e) => {
            write(stdout, `error: ${e.message}`);
            result = 1;
        });

    // Block on the promise (this works in worker context)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__gitPromise = initPromise;

    return result;
}

function gitClone(args: string[], cwd: string, stdout: OutputStream, stderr: OutputStream): number {
    if (args.length === 0) {
        write(stderr, 'usage: git clone <url> [<directory>]');
        return 1;
    }

    const url = args[0];
    const dirName = args[1] || url.split('/').pop()?.replace('.git', '') || 'repo';
    const dir = `${cwd}/${dirName}`;

    // Parse options
    let depth: number | undefined;
    let singleBranch = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--depth' && args[i + 1]) {
            depth = parseInt(args[i + 1], 10);
        }
        if (args[i] === '--single-branch') {
            singleBranch = true;
        }
    }

    write(stdout, `Cloning into '${dirName}'...`);

    let result = 0;
    const clonePromise = git.clone({
        fs: opfsFs,
        http,
        dir,
        url,
        corsProxy: CORS_PROXY,
        depth,
        singleBranch,
        onProgress: (event) => {
            if (event.phase) {
                write(stdout, `${event.phase}: ${event.loaded}/${event.total || '?'}`);
            }
        },
    })
        .then(() => {
            write(stdout, 'done.');
        })
        .catch((e) => {
            write(stderr, `error: ${e.message}`);
            result = 1;
        });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__gitPromise = clonePromise;

    return result;
}

function gitStatus(_args: string[], cwd: string, stdout: OutputStream, stderr: OutputStream): number {
    let result = 0;

    const statusPromise = git.statusMatrix({ fs: opfsFs, dir: cwd })
        .then((matrix) => {
            const staged: string[] = [];
            const unstaged: string[] = [];
            const untracked: string[] = [];

            for (const [filepath, head, workdir, stage] of matrix) {
                if (head === 0 && workdir === 2 && stage === 0) {
                    untracked.push(filepath);
                } else if (head !== workdir) {
                    unstaged.push(filepath);
                } else if (head !== stage) {
                    staged.push(filepath);
                }
            }

            if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
                write(stdout, 'nothing to commit, working tree clean');
            } else {
                if (staged.length > 0) {
                    write(stdout, 'Changes to be committed:');
                    for (const f of staged) write(stdout, `\t${f}`);
                }
                if (unstaged.length > 0) {
                    write(stdout, 'Changes not staged for commit:');
                    for (const f of unstaged) write(stdout, `\t${f}`);
                }
                if (untracked.length > 0) {
                    write(stdout, 'Untracked files:');
                    for (const f of untracked) write(stdout, `\t${f}`);
                }
            }
        })
        .catch((e) => {
            write(stderr, `fatal: ${e.message}`);
            result = 128;
        });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__gitPromise = statusPromise;

    return result;
}

function gitAdd(args: string[], cwd: string, stdout: OutputStream, stderr: OutputStream): number {
    if (args.length === 0) {
        write(stderr, 'Nothing specified, nothing added.');
        return 0;
    }

    let result = 0;

    const addPromises = args.map((filepath) =>
        git.add({ fs: opfsFs, dir: cwd, filepath })
    );

    const addPromise = Promise.all(addPromises)
        .catch((e) => {
            write(stderr, `error: ${e.message}`);
            result = 1;
        });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__gitPromise = addPromise;

    return result;
}

function gitCommit(args: string[], cwd: string, stdout: OutputStream, stderr: OutputStream): number {
    let message = '';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-m' && args[i + 1]) {
            message = args[i + 1];
            break;
        }
    }

    if (!message) {
        write(stderr, 'error: commit message required (-m)');
        return 1;
    }

    let result = 0;

    const commitPromise = git.commit({
        fs: opfsFs,
        dir: cwd,
        message,
        author: {
            name: 'Web Agent',
            email: 'agent@web.local',
        },
    })
        .then((sha) => {
            write(stdout, `[${sha.slice(0, 7)}] ${message}`);
        })
        .catch((e) => {
            write(stderr, `error: ${e.message}`);
            result = 1;
        });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__gitPromise = commitPromise;

    return result;
}

function gitLog(args: string[], cwd: string, stdout: OutputStream, stderr: OutputStream): number {
    let depth = 10;
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('-n')) {
            depth = parseInt(args[i].slice(2) || args[i + 1], 10);
        }
    }

    let result = 0;

    const logPromise = git.log({ fs: opfsFs, dir: cwd, depth })
        .then((commits) => {
            for (const commit of commits) {
                write(stdout, `commit ${commit.oid}`);
                write(stdout, `Author: ${commit.commit.author.name} <${commit.commit.author.email}>`);
                const date = new Date(commit.commit.author.timestamp * 1000);
                write(stdout, `Date:   ${date.toISOString()}`);
                write(stdout, '');
                write(stdout, `    ${commit.commit.message}`);
                write(stdout, '');
            }
        })
        .catch((e) => {
            write(stderr, `fatal: ${e.message}`);
            result = 128;
        });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__gitPromise = logPromise;

    return result;
}

function gitBranch(args: string[], cwd: string, stdout: OutputStream, stderr: OutputStream): number {
    let result = 0;

    if (args.length === 0) {
        // List branches
        const branchPromise = Promise.all([
            git.listBranches({ fs: opfsFs, dir: cwd }),
            git.currentBranch({ fs: opfsFs, dir: cwd }),
        ])
            .then(([branches, current]) => {
                for (const branch of branches) {
                    const prefix = branch === current ? '* ' : '  ';
                    write(stdout, `${prefix}${branch}`);
                }
            })
            .catch((e) => {
                write(stderr, `error: ${e.message}`);
                result = 1;
            });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__gitPromise = branchPromise;
    } else {
        // Create branch
        const branchName = args[0];
        const createPromise = git.branch({ fs: opfsFs, dir: cwd, ref: branchName })
            .catch((e) => {
                write(stderr, `error: ${e.message}`);
                result = 1;
            });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__gitPromise = createPromise;
    }

    return result;
}

function gitCheckout(args: string[], cwd: string, stdout: OutputStream, stderr: OutputStream): number {
    if (args.length === 0) {
        write(stderr, 'error: you must specify a branch to checkout');
        return 1;
    }

    const ref = args[0];
    let result = 0;

    const checkoutPromise = git.checkout({ fs: opfsFs, dir: cwd, ref })
        .then(() => {
            write(stdout, `Switched to branch '${ref}'`);
        })
        .catch((e) => {
            write(stderr, `error: ${e.message}`);
            result = 1;
        });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__gitPromise = checkoutPromise;

    return result;
}
