// Worker-side tool set for OpenAI-compatible providers.
//
// The Worker runs these inside its own process with the task workspace as the
// working directory. Bash already gives the model a shell, so the file tools
// are not a permission boundary. They guard against a common mistake instead:
// read_file may look anywhere, but write_file only writes inside the
// workspace, so worktree isolation is not bypassed by a copied absolute path.
import {exec} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';

const execAsync = promisify(exec);
const MAX_READ_CHARS = 50000;
const TOOL_TIMEOUT_MS = 60000;
const TOOL_MAX_BUFFER = 1024 * 1024;

const TOOLS = [
    {
        name: 'bash',
        description: 'Execute a shell command and return its output. Runs in the task workspace directory.',
        input_schema: {
            type: 'object',
            properties: {
                command: {type: 'string', description: 'The shell command to execute'},
            },
            required: ['command'],
        },
    },
    {
        name: 'read_file',
        description: 'Read contents of a file (relative to workspace or absolute path)',
        input_schema: {
            type: 'object',
            properties: {
                path: {type: 'string', description: 'File path to read'},
            },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description: 'Write content to a file inside the task workspace (workspace-relative path, or an absolute path within the workspace)',
        input_schema: {
            type: 'object',
            properties: {
                path: {type: 'string', description: 'File path to write'},
                content: {type: 'string', description: 'Content to write'},
            },
            required: ['path', 'content'],
        },
    },
];

/** Tool definitions in Anthropic format. The adapter converts them. */
export function buildMinimalTools() {
    return TOOLS;
}

function insideWorkspace(fullPath, root) {
    const relative = path.relative(root, fullPath);
    return relative === ''
        || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Resolve a tool path against the workspace. A relative path may never climb
 * out of it. An absolute path is accepted only when `allowOutside` is set:
 * reads use that to look at source projects, writes never do, so a model that
 * copies an absolute path from its prompt cannot write past an isolated
 * worktree into the original checkout.
 */
export function resolveToolPath(value, workspace, {allowOutside = false} = {}) {
    const root = path.resolve(workspace);
    const fullPath = path.resolve(root, value);
    if (allowOutside && path.isAbsolute(value)) return fullPath;
    if (!insideWorkspace(fullPath, root)) {
        throw new Error(`path must stay inside the workspace ${root}; use a workspace-relative path`);
    }
    return fullPath;
}

/**
 * Execute one tool call. Every failure becomes `{content: 'Error: ...'}` so a
 * broken tool never ends the round.
 */
export async function executeTool(name, args = {}, workspace) {
    try {
        if (name === 'bash') {
            const command = args.command;
            if (!command || typeof command !== 'string') return {content: 'Error: command is required'};
            const {stdout, stderr} = await execAsync(command, {
                cwd: workspace,
                timeout: TOOL_TIMEOUT_MS,
                maxBuffer: TOOL_MAX_BUFFER,
                windowsHide: true,
            });
            return {content: stdout + (stderr ? `\n[stderr]\n${stderr}` : '')};
        }
        if (name === 'read_file') {
            if (!args.path || typeof args.path !== 'string') return {content: 'Error: path is required'};
            const content = fs.readFileSync(resolveToolPath(args.path, workspace, {allowOutside: true}), 'utf8');
            return {content: content.length > MAX_READ_CHARS
                ? content.slice(0, MAX_READ_CHARS) + '\n...[truncated]'
                : content};
        }
        if (name === 'write_file') {
            if (!args.path || typeof args.path !== 'string') return {content: 'Error: path is required'};
            const fullPath = resolveToolPath(args.path, workspace);
            fs.mkdirSync(path.dirname(fullPath), {recursive: true});
            fs.writeFileSync(fullPath, args.content || '', 'utf8');
            return {content: `Written ${args.content?.length || 0} bytes to ${args.path}`};
        }
        return {content: `Error: unknown tool "${name}"`};
    } catch (e) {
        return {content: `Error executing ${name}: ${e.message}`};
    }
}
