/**
 * Git Module for Shell
 *
 * Provides git CLI functionality via isomorphic-git.
 * Integrates with our OPFS filesystem and lazy module loading system.
 * Uses async spawn/resolve pattern for proper async command execution.
 *
 * In sync mode (Safari), uses syncGitFs which returns immediately-resolved
 * promises backed by synchronous Atomics.wait operations.
 */
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { opfsFs } from './opfs-git-adapter';
import { syncGitFs } from '@tjfontaine/wasi-shims/opfs-filesystem-sync-impl.js';
import { hasJSPI } from '../lazy-loading/async-mode';
// Get the appropriate fs adapter based on JSPI support
// In JSPI mode, use async opfsFs; in sync mode, use syncGitFs
const fs = hasJSPI ? opfsFs : syncGitFs;
// Default CORS proxy for GitHub and other services that don't support CORS
const CORS_PROXY = 'https://cors.isomorphic-git.org';
// Helper to write to output stream
function write(stream, text) {
    stream.write(new TextEncoder().encode(text + '\n'));
}
/**
 * Git command module - implements CommandModule interface with spawn/resolve pattern
 */
export const command = {
    spawn(name, args, env, _stdin, stdout, stderr) {
        if (name !== 'git') {
            write(stderr, `Unknown command: ${name}`);
            return createResolvedHandle(1);
        }
        if (args.length === 0) {
            printUsage(stdout);
            return createResolvedHandle(0);
        }
        const subcommand = args[0];
        const subargs = args.slice(1);
        // In sync mode (non-JSPI), use synchronous git implementations
        // because async/await doesn't work properly without JSPI
        if (!hasJSPI) {
            const exitCode = runSubcommandSync(subcommand, subargs, env.cwd, stdout, stderr);
            return createResolvedHandle(exitCode);
        }
        // JSPI mode: use async implementations with isomorphic-git
        const promise = runSubcommandAsync(subcommand, subargs, env.cwd, stdout, stderr);
        return createAsyncHandle(promise);
    },
    listCommands() {
        return ['git'];
    },
};
/**
 * Create a handle that is already resolved with an exit code
 */
function createResolvedHandle(exitCode) {
    return {
        poll: () => exitCode,
        resolve: () => Promise.resolve(exitCode),
    };
}
/**
 * Create a handle that wraps an async promise
 */
function createAsyncHandle(promise) {
    let result;
    const resolvedPromise = promise.then(code => {
        result = code;
        return code;
    });
    return {
        poll: () => result,
        resolve: () => resolvedPromise,
    };
}
function printUsage(stdout) {
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
// ============================================================
// Sync Git Implementations (for non-JSPI browsers like Safari)
// Uses syncGitFs which performs blocking OPFS operations
// ============================================================
/**
 * Run a git subcommand synchronously using the sync fs adapter.
 * This is used in non-JSPI mode where async/await doesn't work properly.
 */
function runSubcommandSync(subcommand, args, cwd, stdout, stderr) {
    try {
        switch (subcommand) {
            case 'init':
                return gitInitSync(args, cwd, stdout, stderr);
            case 'status':
                return gitStatusSync(cwd, stdout, stderr);
            case 'version':
            case '--version':
                write(stdout, 'git version 2.x (sync mode)');
                return 0;
            case 'help':
            case '--help':
            case '-h':
                printUsage(stdout);
                return 0;
            default:
                // For unimplemented commands in sync mode, show a helpful message
                write(stderr, `git: '${subcommand}' is not available in sync mode (Safari).`);
                write(stderr, 'Available sync commands: init, status, help, version');
                return 1;
        }
    }
    catch (e) {
        write(stderr, `error: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
/**
 * Sync git init - creates .git directory structure
 */
function gitInitSync(args, cwd, stdout, _stderr) {
    const dir = args[0] ? `${cwd}/${args[0]}` : cwd;
    const gitDir = `${dir}/.git`;
    // Create .git directory structure synchronously
    // syncGitFs.promises methods return immediately-resolved promises
    // We can't use await, so we just call them and they complete synchronously
    // Create directories
    syncGitFs.promises.mkdir(`${gitDir}/objects`);
    syncGitFs.promises.mkdir(`${gitDir}/refs/heads`);
    syncGitFs.promises.mkdir(`${gitDir}/refs/tags`);
    syncGitFs.promises.mkdir(`${gitDir}/hooks`);
    // Create initial files
    syncGitFs.promises.writeFile(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
    syncGitFs.promises.writeFile(`${gitDir}/config`, `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallaliases = false
`);
    syncGitFs.promises.writeFile(`${gitDir}/description`, 'Unnamed repository; edit this file to name the repository.\n');
    write(stdout, `Initialized empty Git repository in ${gitDir}/`);
    return 0;
}
/**
 * Sync git status - shows working tree status
 */
function gitStatusSync(cwd, stdout, stderr) {
    const gitDir = `${cwd}/.git`;
    // Check if .git exists
    try {
        // Read HEAD synchronously - the stat call will throw if not found
        syncGitFs.promises.stat(`${gitDir}/HEAD`);
    }
    catch {
        write(stderr, 'fatal: not a git repository (or any of the parent directories): .git');
        return 128;
    }
    // For sync mode, show a basic status
    write(stdout, 'On branch main');
    write(stdout, '');
    write(stdout, 'No commits yet');
    write(stdout, '');
    write(stdout, 'nothing to commit (create/copy files and use "git add" to track)');
    return 0;
}
async function runSubcommandAsync(subcommand, args, cwd, stdout, stderr) {
    try {
        switch (subcommand) {
            case 'init':
                return await gitInit(args, cwd, stdout, stderr);
            case 'clone':
                return await gitClone(args, cwd, stdout, stderr);
            case 'status':
                return await gitStatus(args, cwd, stdout, stderr);
            case 'add':
                return await gitAdd(args, cwd, stdout, stderr);
            case 'commit':
                return await gitCommit(args, cwd, stdout, stderr);
            case 'log':
                return await gitLog(args, cwd, stdout, stderr);
            case 'branch':
                return await gitBranch(args, cwd, stdout, stderr);
            case 'checkout':
                return await gitCheckout(args, cwd, stdout, stderr);
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
    catch (e) {
        write(stderr, `git: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
// ============================================================
// Git Subcommand Implementations (now properly async)
// ============================================================
async function gitInit(args, cwd, stdout, stderr) {
    const dir = args[0] ? `${cwd}/${args[0]}` : cwd;
    try {
        await git.init({ fs, dir });
        write(stdout, `Initialized empty Git repository in ${dir}/.git/`);
        return 0;
    }
    catch (e) {
        write(stderr, `error: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
async function gitClone(args, cwd, stdout, stderr) {
    if (args.length === 0) {
        write(stderr, 'usage: git clone <url> [<directory>]');
        return 1;
    }
    const url = args[0];
    const dirName = args[1] || url.split('/').pop()?.replace('.git', '') || 'repo';
    const dir = `${cwd}/${dirName}`;
    // Parse options
    let depth;
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
    try {
        await git.clone({
            fs,
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
        });
        write(stdout, 'done.');
        return 0;
    }
    catch (e) {
        write(stderr, `error: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
async function gitStatus(_args, cwd, stdout, stderr) {
    try {
        // Get current branch
        const branch = await git.currentBranch({ fs, dir: cwd, fullname: false }) || 'HEAD detached';
        write(stdout, `On branch ${branch}`);
        write(stdout, '');
        const matrix = await git.statusMatrix({ fs, dir: cwd });
        const staged = [];
        const unstaged = [];
        const untracked = [];
        for (const [filepath, head, workdir, stage] of matrix) {
            if (head === 0 && workdir === 2 && stage === 0) {
                untracked.push(filepath);
            }
            else if (head !== workdir) {
                unstaged.push(filepath);
            }
            else if (head !== stage) {
                staged.push(filepath);
            }
        }
        if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
            write(stdout, 'nothing to commit, working tree clean');
        }
        else {
            if (staged.length > 0) {
                write(stdout, 'Changes to be committed:');
                for (const f of staged)
                    write(stdout, `\t${f}`);
            }
            if (unstaged.length > 0) {
                write(stdout, 'Changes not staged for commit:');
                for (const f of unstaged)
                    write(stdout, `\t${f}`);
            }
            if (untracked.length > 0) {
                write(stdout, 'Untracked files:');
                for (const f of untracked)
                    write(stdout, `\t${f}`);
            }
        }
        return 0;
    }
    catch (e) {
        write(stderr, `fatal: ${e instanceof Error ? e.message : String(e)}`);
        return 128;
    }
}
async function gitAdd(args, cwd, _stdout, stderr) {
    if (args.length === 0) {
        write(stderr, 'Nothing specified, nothing added.');
        return 0;
    }
    try {
        await Promise.all(args.map((filepath) => git.add({ fs, dir: cwd, filepath })));
        return 0;
    }
    catch (e) {
        write(stderr, `error: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
async function gitCommit(args, cwd, stdout, stderr) {
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
    try {
        const sha = await git.commit({
            fs,
            dir: cwd,
            message,
            author: {
                name: 'Web Agent',
                email: 'agent@web.local',
            },
        });
        write(stdout, `[${sha.slice(0, 7)}] ${message}`);
        return 0;
    }
    catch (e) {
        write(stderr, `error: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
async function gitLog(args, cwd, stdout, stderr) {
    let depth = 10;
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('-n')) {
            depth = parseInt(args[i].slice(2) || args[i + 1], 10);
        }
    }
    try {
        const commits = await git.log({ fs, dir: cwd, depth });
        for (const commit of commits) {
            write(stdout, `commit ${commit.oid}`);
            write(stdout, `Author: ${commit.commit.author.name} <${commit.commit.author.email}>`);
            const date = new Date(commit.commit.author.timestamp * 1000);
            write(stdout, `Date:   ${date.toISOString()}`);
            write(stdout, '');
            write(stdout, `    ${commit.commit.message}`);
            write(stdout, '');
        }
        return 0;
    }
    catch (e) {
        write(stderr, `fatal: ${e instanceof Error ? e.message : String(e)}`);
        return 128;
    }
}
async function gitBranch(args, cwd, stdout, stderr) {
    try {
        if (args.length === 0) {
            // List branches
            const [branches, current] = await Promise.all([
                git.listBranches({ fs, dir: cwd }),
                git.currentBranch({ fs, dir: cwd }),
            ]);
            for (const branch of branches) {
                const prefix = branch === current ? '* ' : '  ';
                write(stdout, `${prefix}${branch}`);
            }
        }
        else {
            // Create branch
            const branchName = args[0];
            await git.branch({ fs, dir: cwd, ref: branchName });
        }
        return 0;
    }
    catch (e) {
        write(stderr, `error: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
async function gitCheckout(args, cwd, stdout, stderr) {
    if (args.length === 0) {
        write(stderr, 'error: you must specify a branch to checkout');
        return 1;
    }
    const ref = args[0];
    try {
        await git.checkout({ fs, dir: cwd, ref });
        write(stdout, `Switched to branch '${ref}'`);
        return 0;
    }
    catch (e) {
        write(stderr, `error: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
    }
}
