// One catalogue for the loopback manager, CLI, and MCP. Each operation
// declares its fields, defaults and bounds, which entry points expose it, its
// handler-facing description, and its read/destructive annotations. Validation
// and rendering derive from this table so a new operation changes one file.
import {parseOptionalMaxTokens} from '../../prototype/budget.mjs';
import {parseOptionalEffort} from '../../prototype/effort.mjs';
import fs from 'node:fs';
import {parseOverride, validateLimits} from '../usage/policy.mjs';
import {safeOffset, safePageLimit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT} from '../view/page.mjs';

export const TASK_VIEWS = ['summary', 'result', 'history', 'usage', 'report', 'workspace', 'diff', 'log'];
export const PAGINATED_VIEWS = TASK_VIEWS.filter(view => view !== 'summary');
export const DEFAULT_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 86400;
export const MAX_PROMPT_LENGTH = 100000;

/** A stable error code and HTTP status that adapters can rely on. */
export class OperationError extends Error {
  constructor(message, {code = 'INVALID_ARGUMENT', status = 400} = {}) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.status = status;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validatePrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PROMPT_LENGTH) {
    throw new OperationError(`Nonempty prompt required (max ${MAX_PROMPT_LENGTH} characters)`);
  }
  return value;
}

function validateEvidence(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OperationError('Delegating acceptance evidence required');
  }
  return value;
}

const field = (schema, validate = null) => ({schema, validate});

const id = field({type: 'string'});
const prompt = field({type: 'string'}, validatePrompt);
const text = field({type: 'string'});
const maxTokens = field({type: 'integer', minimum: 1}, parseOptionalMaxTokens);
const effort = field({type: 'string', enum: ['high', 'max']}, parseOptionalEffort);
const usageLimits = field({type: 'object', properties: {
  enabled: {type: 'boolean'},
  warnCostCny: {type: 'number', exclusiveMinimum: 0},
  blockCostCny: {type: 'number', exclusiveMinimum: 0},
  warnRequests: {type: 'integer', minimum: 1},
  blockRequests: {type: 'integer', minimum: 1},
}, additionalProperties: false}, value => validateLimits(value));
const workspaceMode = field({type: 'string', enum: ['auto', 'worktree', 'shared'], default: 'auto'});
const view = field({type: 'string', enum: TASK_VIEWS, default: 'summary'});
const offset = field({type: 'integer', minimum: 0, default: 0}, value => safeOffset(value));
const limit = field({type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT}, value => safePageLimit(value));
const timeoutSeconds = field({type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS, default: DEFAULT_WAIT_SECONDS});
const overrides = field({type: 'boolean'});
const overrideReason = field({type: 'string', maxLength: 1000});

const researchShard = {
  type: 'object',
  properties: {
    id: {type: 'string'},
    subject: {type: 'string'},
    url: {type: 'string'},
    focus: {type: 'string'},
    prompt: {type: 'string'},
  },
  required: ['subject'],
  additionalProperties: false,
};
const researchShards = field({
  type: 'array',
  minItems: 1,
  items: researchShard,
});

const IDS = {fields: {id}, required: ['id']};

function operation(name, {
  description,
  fields = {},
  required = [],
  order = null,
  cli = false,
  mcp = true,
  desktop = false,
  server = false,
  humanOnly = false,
  readOnly = false,
  destructive = false,
  validate = null,
  mcpMaxima = null,
  mcpFields = null,
} = {}) {
  return {
    name,
    description,
    fields,
    required,
    order: order ?? Object.keys(fields),
    entries: {cli, mcp, desktop, server, humanOnly},
    annotations: {readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: ['create', 'rework', 'research_start'].includes(name)},
    validate,
    mcpMaxima,
    mcpFields,
  };
}

export const OPERATIONS = [
  operation('health', {
    description: 'Report the local manager identity, data root, model, port, and PID.',
    cli: {style: 'none', command: 'health'},
    mcp: false,
    server: true,
    readOnly: true,
  }),
  operation('shutdown', {
    description: 'Stop the local manager after the current response.',
    cli: {style: 'none', command: 'shutdown'},
    mcp: false,
    server: true,
    destructive: true,
  }),
  operation('list', {
    description: 'List compact task summaries (no instructions, rounds, or outputs).',
    cli: {style: 'none', command: 'list'},
    desktop: true,
    readOnly: true,
  }),
  operation('status', {
    description: 'Read a bounded summary by default. Paginated views: result, history, usage, report, workspace, diff, and log. offset/limit default to 0/2000 and max 4000 characters.',
    fields: {id, view, offset, limit},
    required: ['id'],
    order: ['id', 'view', 'offset', 'limit'],
    cli: {style: 'status', command: 'status', requirePagedView: true},
    desktop: true,
    readOnly: true,
  }),
  operation('wait', {
    description: 'Wait server-side until the task stops running or timeoutSeconds expires. Returns the bounded summary plus wait.timedOut.',
    fields: {id, timeoutSeconds},
    required: ['id'],
    order: ['id', 'timeoutSeconds'],
    cli: {style: 'wait', command: 'wait'},
    readOnly: true,
    mcpMaxima: {timeoutSeconds: 300},
  }),
  operation('research_start', {
    description: 'Fan out one read-only research batch. Every shard gets its own scratch workspace and runs concurrently. Use research_wait, then research_collect once no shard is running. Request and cost limits are disabled by default.',
    fields: {
      title: text,
      question: text,
      shards: researchShards,
      commonPrompt: text,
      criteria: text,
      provider: text,
      maxTokens,
      effort,
    },
    required: ['question', 'shards'],
    order: ['question', 'shards', 'title', 'commonPrompt', 'criteria', 'provider', 'maxTokens', 'effort'],
    cli: {style: 'json', command: 'research-start'},
  }),
  operation('research_status', {
    description: 'Read one research batch with shard task status and counts.',
    fields: {id},
    required: ['id'],
    cli: {style: 'id', command: 'research-status'},
    readOnly: true,
  }),
  operation('research_wait', {
    description: 'Wait server-side until the research batch settles or timeoutSeconds expires. Returns the batch plus wait.timedOut.',
    fields: {id, timeoutSeconds},
    required: ['id'],
    order: ['id', 'timeoutSeconds'],
    cli: {style: 'wait', command: 'research-wait'},
    readOnly: true,
    mcpMaxima: {timeoutSeconds: 300},
  }),
  operation('research_collect', {
    description: 'Write the final research report and return a bounded page. offset/limit default to 0/2000 and max 4000 characters. Refuses while shards are active.',
    fields: {id, offset, limit},
    required: ['id'],
    order: ['id', 'offset', 'limit'],
    cli: {style: 'page', command: 'research-collect'},
    readOnly: true,
  }),
  operation('research_cancel', {
    description: 'Stop the unfinished shard tasks in one research batch and retain completed shard results.',
    fields: {id},
    required: ['id'],
    cli: {style: 'id', command: 'research-cancel'},
    destructive: true,
  }),
  operation('create', {
    description: "Create a real task after planning. workspaceMode=auto uses an isolated Git worktree for a clean repository, shared locks for a non-Git directory, and refuses a dirty Git repository. Returns a bounded summary. Optional maxTokens sets this task's output budget. Optional effort high|max sets reasoning effort. Request and cost limits are disabled by default.",
    fields: {
      workspace: text,
      prompt,
      plan: text,
      criteria: text,
      maxTokens,
      effort,
      usageLimits,
      workspaceMode,
      provider: text,
      kind: text,
      batchId: text,
      shardId: text,
    },
    required: ['workspace', 'prompt'],
    order: ['prompt', 'usageLimits', 'maxTokens', 'effort', 'workspace', 'plan', 'criteria', 'workspaceMode', 'provider', 'kind', 'batchId', 'shardId'],
    cli: {style: 'json', command: 'create'},
    desktop: true,
    mcpFields: ['workspace', 'prompt', 'plan', 'criteria', 'maxTokens', 'effort', 'usageLimits', 'workspaceMode'],
  }),
  operation('rework', {
    description: "Continue the SAME conversation after delegating review; send precise corrections. Returns a bounded summary. Optional maxTokens changes the budget from the next round on; omitted inherits the task's previous budget. Optional effort high|max changes reasoning effort from the next round on (use max when repeated attempts fail); omitted inherits the task's effort. usageLimits adjusts later rounds; limits are disabled by default. If explicitly enabled cumulative limits block rework, overrideLimits:true with a nonempty overrideReason approves exactly this next round.",
    fields: {
      id,
      prompt,
      maxTokens,
      effort,
      usageLimits,
      overrideLimits: overrides,
      overrideReason,
    },
    required: ['id', 'prompt'],
    order: ['usageLimits', 'overrideLimits', 'overrideReason', 'maxTokens', 'effort', 'prompt', 'id'],
    cli: {style: 'json', command: 'rework'},
    desktop: true,
    validate: args => parseOverride(args),
  }),
  operation('accept', {
    description: 'Record delegating acceptance evidence and save a durable external report. Returns a bounded summary.',
    fields: {id, evidence: field({type: 'string'}, validateEvidence)},
    required: ['id', 'evidence'],
    order: ['id', 'evidence'],
    cli: {style: 'json', command: 'accept'},
    desktop: true,
  }),
  operation('cancel', {
    description: 'Stop owned DSH work and reap its runtime; retain records. Returns a bounded summary.',
    ...IDS,
    cli: {style: 'id', command: 'cancel'},
    desktop: true,
    destructive: true,
  }),
  operation('close', {
    description: 'Close the task and owned runtime; retain records. Returns a bounded summary.',
    ...IDS,
    cli: {style: 'id', command: 'close'},
    desktop: true,
    destructive: true,
  }),
  operation('cleanup_worktree', {
    description: 'After a task is closed, remove its clean Git worktree. The branch is retained; dirty worktrees are refused.',
    ...IDS,
    cli: {style: 'id', command: 'cleanup-worktree'},
    desktop: true,
    destructive: true,
  }),
  operation('export', {
    description: 'Export task instructions and results to an external report.',
    ...IDS,
    cli: {style: 'id', command: 'export'},
  }),
  operation('preview_delete', {
    description: 'Preview cleanup of a closed archived task; never grants permission.',
    ...IDS,
    cli: {style: 'id', command: 'preview-delete'},
    readOnly: true,
  }),
  operation('grant_delete', {
    description: 'Record explicit human authorization to delete one closed task record. Human terminal only.',
    fields: {id, confirmation: text},
    required: ['id', 'confirmation'],
    order: ['id', 'confirmation'],
    cli: {style: 'grant', command: 'grant-delete'},
    mcp: false,
    humanOnly: true,
  }),
  operation('delete', {
    description: 'Delete scratch task records ONLY after explicit human authorization via local grant-delete CLI; preserve project and report.',
    ...IDS,
    cli: {style: 'id', command: 'delete'},
    destructive: true,
  }),
];

const BY_NAME = new Map(OPERATIONS.map(spec => [spec.name, spec]));

export function operationByName(name) {
  return BY_NAME.get(name) ?? null;
}

function mcpFieldSchema(spec, name) {
  const descriptor = spec.fields[name];
  const schema = {...descriptor.schema};
  const maximum = spec.mcpMaxima?.[name];
  if (maximum !== undefined) schema.maximum = maximum;
  return schema;
}

/** JSON Schema for one MCP tool, including only MCP-exposed operations. */
export function mcpSchema(spec) {
  const names = spec.mcpFields ?? Object.keys(spec.fields);
  const properties = {};
  for (const name of names) properties[name] = mcpFieldSchema(spec, name);
  return {
    type: 'object',
    properties,
    required: spec.required.filter(name => names.includes(name)),
    additionalProperties: false,
  };
}

function actualType(value) {
  if (Array.isArray(value)) return 'array';
  return value === null ? 'null' : typeof value;
}

function validateSchema(schema, key, value) {
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new OperationError(`${key} must be a string`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new OperationError(`${key} must be one of ${schema.enum.join(', ')}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new OperationError(`${key} must be at most ${schema.maxLength} characters`);
    }
    return;
  }
  if (schema.type === 'integer') {
    const minimum = schema.minimum ?? 1;
    const maximum = schema.maximum;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
        value < minimum || (maximum !== undefined && value > maximum)) {
      throw new OperationError(`${key} must be an integer ${maximum === undefined
        ? `>= ${minimum}`
        : `between ${minimum} and ${maximum}`}`);
    }
    return;
  }
  if (schema.type === 'number') {
    const {minimum, maximum, exclusiveMinimum} = schema;
    if (typeof value !== 'number' || !Number.isFinite(value) ||
        (minimum !== undefined && value < minimum) ||
        (maximum !== undefined && value > maximum) ||
        (exclusiveMinimum !== undefined && value <= exclusiveMinimum)) {
      throw new OperationError(`${key} must be a positive finite number`);
    }
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new OperationError(`${key} must be a boolean`);
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new OperationError(`${key} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new OperationError(`${key} must contain at least ${schema.minItems} item`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new OperationError(`${key} must contain at most ${schema.maxItems} items`);
    }
    value.forEach((entry, index) => validateSchema(schema.items, `${key}[${index}]`, entry));
    return;
  }
  if (schema.type === 'object') {
    if (!plainObject(value)) throw new OperationError(`${key} must be an object`);
    for (const nestedKey of Object.keys(value)) {
      const nested = schema.properties?.[nestedKey];
      if (!nested) throw new OperationError(`Invalid argument ${key}.${nestedKey}`);
      validateSchema(nested, `${key}.${nestedKey}`, value[nestedKey]);
    }
    for (const required of schema.required ?? []) {
      if (value[required] === undefined) throw new OperationError(`Missing argument ${key}.${required}`);
    }
    return;
  }
  if (value !== undefined && actualType(value) !== undefined) {
    throw new OperationError(`Unsupported argument schema for ${key}`);
  }
}

function validateValue(descriptor, key, value) {
  if (descriptor.validate) {
    descriptor.validate(value);
    return;
  }
  validateSchema(descriptor.schema, key, value);
}

/**
 * Validate one operation's arguments and apply no defaults. The manager still
 * receives whatever the caller sent; defaults are applied by its handlers.
 * Unknown fields and missing required fields are rejected here for every entry.
 */
export function validateOperation(name, args = {}, {mcp = false} = {}) {
  const spec = operationByName(name);
  if (!spec) throw new OperationError(`Unknown action: ${name}`, {code: 'UNKNOWN_OPERATION', status: 404});
  if (!plainObject(args)) throw new OperationError('Arguments must be an object');
  for (const key of Object.keys(args)) {
    if (!spec.fields[key]) throw new OperationError(`Invalid argument ${key}`);
  }
  for (const key of spec.order) {
    if (args[key] === undefined) continue;
    const descriptor = spec.fields[key];
    const maximum = mcp ? spec.mcpMaxima?.[key] : undefined;
    if (maximum !== undefined) {
      validateSchema({...descriptor.schema, maximum}, key, args[key]);
    } else {
      validateValue(descriptor, key, args[key]);
    }
  }
  for (const key of spec.required) {
    if (args[key] === undefined) throw new OperationError(`Missing argument ${key}`);
  }
  if (spec.validate) spec.validate(args);
  return args;
}

export function operationForCli(command) {
  const direct = operationByName(command.replaceAll('-', '_'));
  if (direct?.entries.cli) return direct;
  return OPERATIONS.find(spec => spec.entries.cli?.command === command) ?? null;
}

function requireId(spec, command, rest) {
  if (rest[0] === undefined) {
    const label = spec.name.startsWith('research_') ? 'batch ID' : 'task ID';
    throw new OperationError(`${command} requires a ${label}`);
  }
  if (rest.length > 1) throw new OperationError(`Unexpected ${command} argument ${rest[1]}`);
  return rest[0];
}

function parseFlags(command, rest, allowed) {
  const data = {};
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new OperationError(`Unexpected ${command} argument ${token}`);
    const eq = token.indexOf('=');
    const name = token.slice(2, eq < 0 ? undefined : eq);
    if (!allowed.includes(name)) throw new OperationError(`Unknown ${command} option --${name}`);
    if (seen.has(name)) throw new OperationError(`Duplicate ${command} option --${name}`);
    seen.add(name);
    let value;
    if (eq >= 0) value = token.slice(eq + 1);
    else {
      if (i + 1 >= rest.length) throw new OperationError(`Missing value for --${name}`);
      value = rest[++i];
    }
    data[name] = value;
  }
  return data;
}

function numeric(value, name, {minimum, maximum}) {
  if (!/^\d+$/.test(value)) {
    throw new OperationError(name === 'timeout'
      ? 'timeout must be a positive integer'
      : `${name} must be an integer between ${minimum} and ${maximum ?? 'a safe integer'}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || (maximum !== undefined && parsed > maximum)) {
    throw new OperationError(name === 'timeout'
      ? `timeout must be an integer between ${minimum} and ${maximum} seconds`
      : `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseStatusLike(command, rest) {
  const data = {};
  const flags = parseFlags(command, rest, ['view', 'offset', 'limit']);
  if (flags.view !== undefined) {
    const values = TASK_VIEWS;
    if (!values.includes(flags.view)) throw new OperationError(`view must be one of ${values.join(', ')}`);
    data.view = flags.view;
  }
  if (flags.offset !== undefined) {
    if (!/^\d+$/.test(flags.offset)) throw new OperationError('offset must be a non-negative integer');
    const value = Number(flags.offset);
    if (!Number.isSafeInteger(value)) throw new OperationError('offset must be a non-negative safe integer');
    data.offset = value;
  }
  if (flags.limit !== undefined) {
    if (!/^\d+$/.test(flags.limit)) throw new OperationError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
    const value = Number(flags.limit);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
      throw new OperationError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
    }
    data.limit = value;
  }
  return data;
}

/**
 * Parse one CLI command from the catalogue. `@file` JSON is accepted for the
 * JSON-style commands. Defaults are not applied here; the manager owns them.
 */
export function parseCliOperation(command, argv = []) {
  const spec = operationForCli(command);
  if (!spec) throw new OperationError(`Unknown command: ${command}`);
  const style = spec.entries.cli.style;
  if (style === 'json') {
    const textValue = argv.join(' ');
    const data = JSON.parse(textValue.startsWith('@')
      ? fs.readFileSync(textValue.slice(1), 'utf8')
      : textValue);
    validateOperation(spec.name, data);
    return {command: spec.name, data};
  }
  if (style === 'none') {
    if (argv.length) throw new OperationError(`Unexpected ${command} argument ${argv[0]}`);
    return {command: spec.name, data: {}};
  }
  if (style === 'id' || style === 'grant') {
    const data = {id: requireId(spec, command, argv)};
    if (style === 'id') validateOperation(spec.name, data);
    return {command: spec.name, data};
  }
  if (style === 'wait') {
    const id = requireId(spec, command, argv.slice(0, 1));
    const data = {id};
    const flags = parseFlags(command, argv.slice(1), ['timeout']);
    if (flags.timeout !== undefined) {
      data.timeoutSeconds = numeric(flags.timeout, 'timeout', {
        minimum: 1,
        maximum: MAX_WAIT_SECONDS,
      });
    }
    validateOperation(spec.name, data);
    return {command: spec.name, data};
  }
  if (style === 'status') {
    const id = requireId(spec, command, argv.slice(0, 1));
    const data = {id, ...parseStatusLike(command, argv.slice(1))};
    if (spec.entries.cli.requirePagedView &&
        (data.offset !== undefined || data.limit !== undefined) &&
        !PAGINATED_VIEWS.includes(data.view)) {
      throw new OperationError(`--offset/--limit require --view ${PAGINATED_VIEWS.join(', ')}`);
    }
    validateOperation(spec.name, data);
    return {command: spec.name, data};
  }
  if (style === 'page') {
    const id = requireId(spec, command, argv.slice(0, 1));
    const flags = parseFlags(command, argv.slice(1), ['offset', 'limit']);
    const data = {id};
    if (flags.offset !== undefined) {
      if (!/^\d+$/.test(flags.offset)) throw new OperationError('offset must be a non-negative integer');
      const value = Number(flags.offset);
      if (!Number.isSafeInteger(value)) throw new OperationError('offset must be a non-negative safe integer');
      data.offset = value;
    }
    if (flags.limit !== undefined) {
      if (!/^\d+$/.test(flags.limit)) throw new OperationError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
      const value = Number(flags.limit);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
        throw new OperationError(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
      }
      data.limit = value;
    }
    validateOperation(spec.name, data);
    return {command: spec.name, data};
  }
  throw new OperationError(`Unsupported CLI style for ${command}`);
}

/** Human-readable help generated from the same catalogue. */
export function cliHelp() {
  const names = OPERATIONS
    .filter(spec => spec.entries.cli)
    .map(spec => spec.entries.cli.command)
    .join(' | ');
  const lines = [
    `waxwing [tui | demo | ${names}]`,
    'JSON arguments may be inline or @absolute-file. Defaults: list/status return bounded summaries; parse offset/limit for paged views.',
  ];
  for (const spec of OPERATIONS) {
    if (!spec.entries.cli) continue;
    lines.push(`${spec.entries.cli.command}: ${spec.description}`);
  }
  lines.push('MCP: waxwing-mcp or node prototype/mcp.mjs');
  return lines.join('\n');
}
