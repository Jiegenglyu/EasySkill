import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SUPPORTED_TEMPLATE_SCOPES = new Set(["input", "state", "env"]);
const SUPPORTED_REPEAT_UNTIL_KEYS = new Set(["path", "equals", "exists"]);

function list(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function walk(value, visit, path = "$") {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visit, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      walk(entry, visit, `${path}.${key}`);
    }
  }
}

function getTemplateExpressions(value) {
  const expressions = [];
  walk(value, (entry, path) => {
    if (typeof entry !== "string") return;
    for (const match of entry.matchAll(/\$\{([^}]+)\}/g)) {
      expressions.push({ expression: match[1], path });
    }
  });
  return expressions;
}

function validatePath(path, location, errors) {
  if (typeof path !== "string" || !path) {
    errors.push(`${location} must be a non-empty path string`);
    return;
  }
  if (path !== "$" && !path.startsWith("$.")) {
    errors.push(`${location} must start with "$" or "$."`);
  }
  if (/[\[\]\?\*]/.test(path)) {
    errors.push(`${location} uses JSONPath syntax unsupported by run-operation.mjs: ${path}`);
  }
}

function validateTemplates(value, location, context, errors, warnings) {
  for (const { expression, path } of getTemplateExpressions(value)) {
    if (expression.trim() !== expression) {
      errors.push(`${location}${path} has whitespace inside template expression: \${${expression}}`);
      continue;
    }

    const [scope, ...rest] = expression.split(".");
    const topKey = rest[0];
    if (!SUPPORTED_TEMPLATE_SCOPES.has(scope)) {
      errors.push(`${location}${path} uses unsupported template expression \${${expression}}. Supported scopes: input, state, env.`);
      continue;
    }
    if (!topKey) {
      errors.push(`${location}${path} must reference a key path, not just \${${scope}}`);
      continue;
    }
    if (scope === "input" && !context.definedInputs.has(topKey)) {
      errors.push(`${location}${path} references undeclared input "${topKey}" in \${${expression}}`);
    }
    if (scope === "input" && context.hasInputValues && !context.providedInputs.has(topKey) && !context.inputDefaults.has(topKey)) {
      warnings.push(`${location}${path} references input "${topKey}", but inputs.json does not provide it and no default is declared`);
    }
    if (scope === "state" && !context.availableState.has(topKey)) {
      warnings.push(`${location}${path} references state "${topKey}" before any earlier capture declares it`);
    }
  }
}

function requestHost(step) {
  try {
    const url = step?.request?.url;
    if (typeof url !== "string" || url.includes("${")) return null;
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function validateRecipe(recipe, options = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];

  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    return { ok: false, errors: ["recipe must be a JSON object"], warnings, notes };
  }

  if (!recipe.name) warnings.push("recipe.name is missing");
  if (!recipe.purpose) warnings.push("recipe.purpose is missing");
  if (!recipe.operationType) warnings.push("recipe.operationType is missing; compile from operation.spec.json before replay");
  if (!recipe.sourceSpec) warnings.push("recipe.sourceSpec is missing; recipes should point back to operation.spec.json");
  if (!recipe.auth?.storageState && !recipe.auth?.storage_state) {
    warnings.push("auth.storageState is missing; cookie replay will not load browser auth state");
  }
  if (recipe.auth?.refreshWithPlaywright !== true && recipe.auth?.refresh_with_playwright !== true) {
    warnings.push("auth.refreshWithPlaywright is not true; repeated auth failures need an explicit refresh path or a specialized harness");
  }

  const context = {
    definedInputs: new Set(Object.keys(recipe.inputs || {})),
    providedInputs: new Set(Object.keys(options.input || {})),
    hasInputValues: Boolean(options.input),
    inputDefaults: new Set(
      Object.entries(recipe.inputs || {})
        .filter(([, spec]) => spec && typeof spec === "object" && Object.hasOwn(spec, "default"))
        .map(([name]) => name)
    ),
    availableState: new Set()
  };

  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    errors.push("recipe.steps must be a non-empty array");
    return { ok: false, errors, warnings, notes };
  }

  const hosts = new Set();
  const captured = [];
  const stateRefs = [];

  recipe.steps.forEach((step, index) => {
    const label = `steps[${index}]${step?.id ? ` (${step.id})` : ""}`;
    if (!step || typeof step !== "object") {
      errors.push(`${label} must be an object`);
      return;
    }
    if (!step.id) warnings.push(`${label} is missing id`);

    if (!step.request || typeof step.request !== "object") {
      errors.push(`${label}.request is missing`);
    } else {
      if (!step.request.url) errors.push(`${label}.request.url is missing`);
      validateTemplates(step.request, `${label}.request`, context, errors, warnings);
      const host = requestHost(step);
      if (host) hosts.add(host);
      stateRefs.push(
        getTemplateExpressions(step.request)
          .map(({ expression }) => expression)
          .filter((expression) => expression.startsWith("state."))
          .map((expression) => expression.split(".")[1])
      );
    }

    if (step.repeat) {
      const until = step.repeat.until;
      if (!Number.isInteger(step.repeat.maxAttempts) || step.repeat.maxAttempts < 1) {
        errors.push(`${label}.repeat.maxAttempts must be a positive integer`);
      }
      if (step.repeat.delayMs != null && (!Number.isInteger(step.repeat.delayMs) || step.repeat.delayMs < 0)) {
        errors.push(`${label}.repeat.delayMs must be a non-negative integer`);
      }
      if (!until || typeof until !== "object") {
        errors.push(`${label}.repeat.until is required`);
      } else {
        for (const key of Object.keys(until)) {
          if (!SUPPORTED_REPEAT_UNTIL_KEYS.has(key)) {
            errors.push(`${label}.repeat.until uses unsupported key "${key}". Supported keys: path, equals, exists.`);
          }
        }
        validatePath(until.path, `${label}.repeat.until.path`, errors);
        if ("equals" in until && "exists" in until) errors.push(`${label}.repeat.until must use either equals or exists, not both`);
        if (!("equals" in until) && !("exists" in until)) errors.push(`${label}.repeat.until must use equals or exists`);
        if (/total(Row|Rows|Count)|latest|newest/i.test(String(until.path || ""))) {
          warnings.push(`${label}.repeat.until appears to poll aggregate/latest fields. Prefer polling the entity matching this run's durable id.`);
        }
      }
    }

    const capturedHere = [];
    for (const [name, path] of Object.entries(step.capture || {})) {
      capturedHere.push(name);
      validatePath(path, `${label}.capture.${name}`, errors);
      if (/csrf|xsrf|token|nonce/i.test(name)) {
        notes.push(`${label} captures runtime token "${name}"; keep values local and apply through state templates only`);
      }
    }
    captured.push(...capturedHere);
    for (const name of capturedHere) context.availableState.add(name);

    if (step.output?.type === "file") {
      validateTemplates(step.output.path || "", `${label}.output.path`, context, errors, warnings);
      const minBytes = step.expect?.minBytes ?? step.output.minBytes;
      if (!Number.isInteger(minBytes) || minBytes < 1) {
        warnings.push(`${label} writes a file without expect.minBytes or output.minBytes`);
      }
      const rejectedTypes = list(step.expect?.rejectContentTypes || step.output.rejectContentTypes);
      if (rejectedTypes.length === 0) {
        warnings.push(`${label} writes a file without rejecting login/error content types such as text/html`);
      }
    }
  });

  if (hosts.size > 1) {
    warnings.push(`recipe calls multiple hosts (${[...hosts].join(", ")}); cross-domain auth or token exchange must be modeled explicitly`);
  }

  const durableIds = captured.filter((name) => /jobId|taskId|exportId|requestId|fileId|docId|workflowId|approvalId/i.test(name));
  if (/(async|download|approval|workflow)/i.test(recipe.operationType || "") && durableIds.length === 0) {
    warnings.push(`${recipe.operationType} recipes should capture a durable business/server id such as taskId, jobId, fileId, workflowId, or approvalId`);
  }
  for (const id of durableIds) {
    const usedLater = stateRefs.some((refs) => refs.includes(id));
    if (!usedLater && !/fileId|docId/i.test(id)) {
      warnings.push(`captured durable id "${id}" is not used by a later request; avoid latest-row or aggregate-count replay`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, notes };
}

function main() {
  const [, , recipeFile, inputsFile] = globalThis.process.argv;
  if (!recipeFile || recipeFile === "--help" || recipeFile === "-h") {
    console.error("Usage: node validate-recipe.mjs <operation.recipe.draft.json|operation.recipe.json> [inputs.json]");
    globalThis.process.exit(recipeFile ? 0 : 2);
  }

  const recipe = JSON.parse(readFileSync(resolve(recipeFile), "utf8"));
  const input = inputsFile ? JSON.parse(readFileSync(resolve(inputsFile), "utf8")) : undefined;
  const result = validateRecipe(recipe, { input });
  console.log(JSON.stringify(result, null, 2));
  globalThis.process.exit(result.ok ? 0 : 1);
}

if (globalThis.process?.argv?.[1] && import.meta.url === pathToFileURL(resolve(globalThis.process.argv[1])).href) {
  main();
}
