// Worker-side tool set for OpenAI-compatible providers.
//
// The Worker runs these inside its own process with the task workspace as the
// working directory. Bash already gives the model a shell, so the file tools
// deliberately accept an absolute path as well as a workspace-relative one;
// they are convenience wrappers, not a second permission boundary.
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
        description: 'Write content to a file (relative to workspace or absolute path)',
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

/** Resolve a relative tool path inside the workspace; absolute paths pass through. */
export function resolveToolPath(value, workspace) {
    if (path.isAbsolute(value)) return value;
    const fullPath = path.join(workspace, value);
    // A relative path with `..` may still leave the workspace.
    const root = path.resolve(workspace);
    if (!path.resolve(fullPath).startsWith(root)) {
        throw new Error('path must stay inside the workspace');
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
            const content = fs.readFileSync(resolveToolPath(args.path, workspace), 'utf8');
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
