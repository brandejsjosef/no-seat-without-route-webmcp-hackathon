/**
 * Tool-surface contract check.
 *
 * Chrome's WebMCP guidance publishes budgets for tool names, descriptions,
 * parameter descriptions and tool output. Those budgets are easy to break by
 * accident while editing copy, and nothing in a browser complains - the agent
 * just gets worse at picking the right tool.
 *
 * This runs in plain Node, needs no browser, no network and no model key.
 *
 *   node evals/contract.mjs
 */

import {
  TOOL_LIMITS,
  PHASES,
  createVisitorTools,
  createOperatorTools,
  toolsForPhase,
  toolCounts,
} from '../public/tools.mjs';

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

function collectParameterDescriptions(schema, trail = 'inputSchema') {
  const found = [];
  if (!schema || typeof schema !== 'object') return found;
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (typeof value?.description === 'string') {
      found.push({ path: `${trail}.${key}`, description: value.description });
    }
    if (value?.type === 'object') found.push(...collectParameterDescriptions(value, `${trail}.${key}`));
  }
  return found;
}

export function checkToolContract(tools, surface) {
  const problems = [];
  const fail = (tool, rule, detail) => problems.push({ surface, tool, rule, detail });
  const seenNames = new Set();
  const seenDescriptions = new Map();

  for (const tool of tools) {
    if (typeof tool.name !== 'string' || !tool.name) {
      fail('(unnamed)', 'NAME_REQUIRED', 'A tool has no name.');
      continue;
    }
    if (tool.name.length > TOOL_LIMITS.nameChars) {
      fail(tool.name, 'NAME_TOO_LONG', `${tool.name.length} characters, limit ${TOOL_LIMITS.nameChars}.`);
    }
    if (!NAME_PATTERN.test(tool.name)) {
      fail(tool.name, 'NAME_SHAPE', 'Use lowercase letters, digits and underscores, starting with a letter.');
    }
    if (seenNames.has(tool.name)) fail(tool.name, 'NAME_DUPLICATE', 'Two tools share this name.');
    seenNames.add(tool.name);

    const description = tool.description ?? '';
    if (description.length < 40) {
      fail(tool.name, 'DESCRIPTION_TOO_SHORT', `${description.length} characters; say what it does and when to use it.`);
    }
    if (description.length > TOOL_LIMITS.descriptionChars) {
      fail(tool.name, 'DESCRIPTION_TOO_LONG', `${description.length} characters, limit ${TOOL_LIMITS.descriptionChars}.`);
    }
    if (seenDescriptions.has(description)) {
      fail(tool.name, 'DESCRIPTION_DUPLICATE', `Identical wording to ${seenDescriptions.get(description)}; an agent cannot tell them apart.`);
    }
    seenDescriptions.set(description, tool.name);

    for (const parameter of collectParameterDescriptions(tool.inputSchema)) {
      if (parameter.description.length > TOOL_LIMITS.parameterDescriptionChars) {
        fail(tool.name, 'PARAM_DESCRIPTION_TOO_LONG', `${parameter.path} is ${parameter.description.length} characters, limit ${TOOL_LIMITS.parameterDescriptionChars}.`);
      }
    }

    const schema = tool.inputSchema;
    if (!schema || schema.type !== 'object') {
      fail(tool.name, 'SCHEMA_SHAPE', 'inputSchema must be a JSON Schema object.');
    } else {
      if (schema.additionalProperties !== false) {
        fail(tool.name, 'SCHEMA_OPEN', 'Set additionalProperties to false so unexpected keys are rejected.');
      }
      for (const required of schema.required ?? []) {
        if (!Object.hasOwn(schema.properties ?? {}, required)) {
          fail(tool.name, 'REQUIRED_UNKNOWN', `"${required}" is required but is not a declared property.`);
        }
      }
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        if (!value?.type) fail(tool.name, 'PARAM_UNTYPED', `${key} declares no type.`);
        if (!value?.description) fail(tool.name, 'PARAM_UNDESCRIBED', `${key} has no description.`);
      }
    }

    if (typeof tool.annotations?.readOnlyHint !== 'boolean') {
      fail(tool.name, 'ANNOTATION_MISSING', 'readOnlyHint must be declared true or false.');
    }
    for (const annotation of Object.keys(tool.annotations ?? {})) {
      if (!['readOnlyHint', 'untrustedContentHint'].includes(annotation)) {
        fail(tool.name, 'ANNOTATION_UNKNOWN', `"${annotation}" is not in the live specification.`);
      }
    }

    if (!Array.isArray(tool.availableIn) || tool.availableIn.length === 0) {
      fail(tool.name, 'PHASES_MISSING', 'Declare the page states this tool is registered in.');
    } else {
      for (const phase of tool.availableIn) {
        if (!PHASES.includes(phase)) fail(tool.name, 'PHASE_UNKNOWN', `"${phase}" is not a page state.`);
      }
    }

    if (typeof tool.execute !== 'function') fail(tool.name, 'EXECUTE_MISSING', 'execute must be a function.');
  }

  return problems;
}

export function phaseMatrix(tools) {
  return PHASES.map((phase) => {
    const active = toolsForPhase(tools, phase);
    return { phase, ...toolCounts(active), names: active.map((tool) => tool.name) };
  });
}

const stub = {
  api: async () => ({ evaluation: { options: [], feasibleCount: 0, venueRevision: 1 }, state: { resources: {} } }),
  refresh: async () => ({ phase: 'READY', resourceVersion: 1, resources: {}, atomicity: { reservedResourceCount: 0 } }),
};

export function runContract() {
  const surfaces = [
    ['visitor booking', createVisitorTools(stub)],
    ['venue operations', createOperatorTools(stub)],
  ];

  const problems = [];
  for (const [surface, tools] of surfaces) problems.push(...checkToolContract(tools, surface));

  return { surfaces, problems };
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop());

if (isDirectRun) {
  const { surfaces, problems } = runContract();

  for (const [surface, tools] of surfaces) {
    console.log(`\n${surface}: ${tools.length} tools`);
    if (surface === 'visitor booking') {
      for (const row of phaseMatrix(tools)) {
        const declarative = row.phase === 'READY' ? ' + set_access_requirements (declarative)' : '';
        const write = row.write + (row.phase === 'READY' ? 1 : 0);
        console.log(`  ${row.phase.padEnd(28)} ${String(row.read).padStart(2)} read · ${write} write   ${row.names.join(', ')}${declarative}`);
      }
    } else {
      const counts = toolCounts(tools);
      console.log(`  always registered            ${counts.read} read · ${counts.write} write   ${tools.map((tool) => tool.name).join(', ')}`);
    }
  }

  console.log('');
  if (problems.length === 0) {
    console.log(`Tool contract clean. Limits: name ${TOOL_LIMITS.nameChars}, description ${TOOL_LIMITS.descriptionChars}, parameter ${TOOL_LIMITS.parameterDescriptionChars}, output ${TOOL_LIMITS.outputChars} characters.`);
  } else {
    for (const problem of problems) {
      console.error(`  ${problem.surface} · ${problem.tool} · ${problem.rule}: ${problem.detail}`);
    }
    console.error(`\n${problems.length} contract problem(s).`);
    process.exitCode = 1;
  }
}
