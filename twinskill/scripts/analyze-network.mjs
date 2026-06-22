import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [, , inputFile, outputFile = "api-analysis.json", userActionsFile] = process.argv;

if (!inputFile) {
  console.error("Usage: node analyze-network.mjs <network.jsonl> [api-analysis.json] [user-actions.jsonl]");
  process.exit(2);
}

const STATIC_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".mjs",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".wasm",
  ".mp4",
  ".mp3"
]);

const BACKGROUND_PATH_PATTERNS = [
  /\/analytics?\b/i,
  /\/telemetry\b/i,
  /\/track(?:ing)?\b/i,
  /\/beacon\b/i,
  /\/metrics?\b/i,
  /\/logs?\b/i,
  /\/collect\b/i,
  /\/sentry\b/i,
  /\/heartbeat\b/i,
  /\/click-interface\b/i,
  /\/history\/report\b/i,
  /\/player\/online/i,
  /\/xlog\b/i,
  /\/hmr\b/i,
  /\/sockjs\b/i,
  /\/webpack/i,
  /\/vite\b/i,
  /\/favicon\b/i,
  /\/static\b/i,
  /\/assets?\b/i,
  /\/cdn\b/i
];

const QUERY_ROLE_PATTERNS = [/query/i, /keyword/i, /search/i, /filter/i, /page/i, /pagesize/i, /cursor/i, /offset/i, /limit/i];
const OUTPUT_ROLE_PATTERNS = [/items/i, /records/i, /rows/i, /list/i, /total/i, /result/i, /data/i, /count/i];
const FILE_ROLE_PATTERNS = [
  /export/i,
  /download/i,
  /(^|[._/\-?&=])reports?($|[._/\-?&=])/i,
  /(^|[._/\-?&=])file(id|name|url)?($|[._/\-?&=])/i,
  /excel/i,
  /csv/i,
  /pdf/i,
  /attachment/i
];
const ASYNC_ROLE_PATTERNS = [/task/i, /job/i, /status/i, /progress/i, /poll/i, /downloadurl/i, /fileid/i];
const MUTATION_ROLE_PATTERNS = [/approve/i, /submit/i, /save/i, /create/i, /update/i, /delete/i, /remove/i, /cancel/i, /upload/i];
const AUTH_ROLE_PATTERNS = [/auth/i, /login/i, /token/i, /csrf/i, /xsrf/i, /nonce/i, /session/i, /wbi/i, /signature/i];

function parseLines(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: "parse_error", index, error: error.message, line: line.slice(0, 200) };
      }
    });
}

function tryUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function urlPath(url) {
  const parsed = tryUrl(url);
  if (!parsed) return url;
  return `${parsed.pathname}${parsed.search}`;
}

function extensionOf(pathname) {
  const last = pathname.split("/").pop() || "";
  const index = last.lastIndexOf(".");
  return index === -1 ? "" : last.slice(index).toLowerCase();
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function templateSegment(segment) {
  const decoded = decodeSegment(segment);
  if (/^[0-9]+$/.test(decoded)) return "{number}";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) return "{uuid}";
  if (/^[0-9a-f]{12,}$/i.test(decoded)) return "{hex}";
  if (/^[A-Za-z0-9_-]{24,}$/.test(decoded) && /\d/.test(decoded) && /[A-Za-z]/.test(decoded)) return "{token}";
  return decoded;
}

function urlShape(url) {
  const parsed = tryUrl(url);
  if (!parsed) {
    return {
      origin: "",
      pathname: url,
      templatePath: url,
      queryKeys: [],
      querySignature: ""
    };
  }
  const segments = parsed.pathname.split("/").map((segment, index) => index === 0 ? "" : templateSegment(segment));
  const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort();
  return {
    origin: parsed.origin,
    pathname: parsed.pathname,
    templatePath: segments.join("/") || "/",
    queryKeys,
    querySignature: queryKeys.join("&")
  };
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text || ""));
}

function keys(record, field) {
  return Array.isArray(record?.[field]) ? record[field] : [];
}

function parseJsonMaybe(text) {
  if (!text || typeof text !== "string") return null;
  if (text.startsWith("[unreadable:")) return null;
  try {
    return JSON.parse(text.replace(/\.\.\.\[truncated:\d+\]$/, ""));
  } catch {
    return null;
  }
}

function jsonKeyPaths(text, limit = 80) {
  const root = parseJsonMaybe(text);
  if (root == null) return [];
  const out = [];
  const seen = new Set();

  function add(path) {
    if (!seen.has(path) && out.length < limit) {
      seen.add(path);
      out.push(path);
    }
  }

  function walk(value, path, depth) {
    if (out.length >= limit || depth > 3 || value == null) return;
    if (Array.isArray(value)) {
      add(`${path}[]`);
      if (value.length > 0) walk(value[0], `${path}[]`, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      add(next);
      walk(entry, next, depth + 1);
      if (out.length >= limit) return;
    }
  }

  walk(root, "", 0);
  return out;
}

function classifyTraffic(request, response) {
  const parsed = tryUrl(request.url || "");
  const pathname = parsed?.pathname || request.url || "";
  const path = `${pathname}${parsed?.search || ""}`;
  const ext = extensionOf(pathname);
  const contentType = response?.contentType || "";
  const resourceType = request.resourceType || "";
  const reasons = [];
  const apiSignals = [];

  if (STATIC_EXTENSIONS.has(ext)) reasons.push(`static-extension:${ext}`);
  if (["image", "script", "stylesheet", "font", "media"].includes(resourceType)) reasons.push(`resource-type:${resourceType}`);
  if (BACKGROUND_PATH_PATTERNS.some((pattern) => pattern.test(path))) reasons.push("background-or-telemetry-path");
  if (resourceType === "document" && /text\/html/i.test(contentType)) reasons.push("html-document");

  if (["fetch", "xhr"].includes(resourceType)) apiSignals.push(`resource-type:${resourceType}`);
  if (/json|graphql|text\/csv|spreadsheet|excel|pdf|octet-stream|application\/zip/i.test(contentType)) {
    apiSignals.push(`content-type:${contentType || "unknown"}`);
  }
  if (/\/api\/|\/graphql\b|\/rest\/|\/v\d+\//i.test(path)) apiSignals.push("api-like-path");
  if ((request.method || "GET") !== "GET") apiSignals.push(`method:${request.method}`);

  const hardNoise = reasons.some((reason) =>
    reason.startsWith("static-extension") ||
    reason.startsWith("resource-type") ||
    reason === "background-or-telemetry-path"
  );
  const likelyNoise = hardNoise || (reasons.includes("html-document") && apiSignals.length === 0);
  return {
    likelyNoise,
    reasons,
    apiSignals,
    apiLikelihood: Math.max(0, apiSignals.length * 2 - reasons.length)
  };
}

function detectRoles(request, response, requestKeyPaths, responseKeyPaths) {
  const headersText = JSON.stringify(response?.headers || {});
  const allText = [
    request.url,
    request.postData,
    headersText,
    requestKeyPaths.join("\n"),
    responseKeyPaths.join("\n")
  ].join("\n");
  const roles = new Set();

  if (hasAny(allText, QUERY_ROLE_PATTERNS)) roles.add("query");
  if (hasAny(allText, OUTPUT_ROLE_PATTERNS)) roles.add("result");
  if (hasAny(allText, FILE_ROLE_PATTERNS) || /content-disposition/i.test(headersText)) roles.add("file");
  if (hasAny(allText, ASYNC_ROLE_PATTERNS)) roles.add("async");
  if (hasAny(allText, MUTATION_ROLE_PATTERNS)) roles.add("mutation");
  if (hasAny(allText, AUTH_ROLE_PATTERNS)) roles.add("auth");
  if (/json/i.test(response?.contentType || "")) roles.add("json");
  return [...roles].sort();
}

function scoreCandidate(request, response, markerBefore, traffic, roles) {
  const url = request.url || "";
  const payload = request.postData || "";
  const responseBody = response?.bodyText || "";
  const allText = `${url}\n${payload}\n${responseBody}`;
  const reasons = [];
  let score = 0;

  if (request.resourceType === "fetch" || request.resourceType === "xhr") {
    score += 3;
    reasons.push("fetch/xhr");
  }
  if (/json/i.test(response?.contentType || "")) {
    score += 3;
    reasons.push("json response");
  }
  if (request.method === "POST") {
    score += 2;
    reasons.push("POST");
  }
  if (request.method === "GET") {
    score += 1;
    reasons.push("GET");
  }
  if (markerBefore) {
    score += 2;
    reasons.push(`after marker:${markerBefore.name}`);
  }
  if (hasAny(allText, QUERY_ROLE_PATTERNS)) {
    score += 4;
    reasons.push("query-like fields");
  }
  if (hasAny(allText, FILE_ROLE_PATTERNS) || roles.includes("mutation")) {
    score += 5;
    reasons.push("operation-like fields");
  }
  if (hasAny(allText, OUTPUT_ROLE_PATTERNS) || roles.includes("async")) {
    score += 4;
    reasons.push("result-like response");
  }
  if (hasAny(response?.contentType || "", [/csv/i, /excel/i, /spreadsheet/i, /pdf/i, /octet-stream/i])) {
    score += 5;
    reasons.push("file response");
  }
  if (hasAny(JSON.stringify(response?.headers || {}), [/content-disposition/i, /filename=/i])) {
    score += 5;
    reasons.push("download headers");
  }
  if (traffic.likelyNoise) {
    score -= 10;
    reasons.push(`noise:${traffic.reasons.join(",") || "unknown"}`);
  }
  if ((response?.status || 0) >= 400) {
    score -= 3;
    reasons.push(`status ${response.status}`);
  }

  return { score, reasons };
}

function lastMarkerBefore(markers, ts) {
  let selected = null;
  for (const marker of markers) {
    if (marker.ts <= ts) selected = marker;
    if (marker.ts > ts) break;
  }
  return selected;
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = value == null || value === "" ? "(empty)" : String(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function uniq(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))].sort();
}

function summarizeEvent(event) {
  return {
    ts: event.ts,
    deltaMs: event.deltaMs ?? null,
    id: event.id,
    groupId: event.groupId,
    pageName: event.pageName || null,
    score: event.score,
    roles: event.roles,
    method: event.method,
    url: event.url,
    path: event.path,
    endpointTemplate: event.endpointTemplate,
    status: event.status,
    contentType: event.contentType,
    requestPayloadKeys: event.requestPayloadKeys,
    responseBodyKeys: event.responseBodyKeys,
    responseKeyPaths: event.responseKeyPaths,
    suggestedFilename: event.suggestedFilename || null,
    savedPath: event.savedPath || null,
    reasons: event.reasons
  };
}

function actionSummary(action) {
  return {
    ts: action.ts,
    type: action.type,
    pageName: action.pageName || null,
    url: action.url || null,
    target: action.target ? {
      tag: action.target.tag || null,
      role: action.target.role || null,
      text: action.target.text || null,
      ariaLabel: action.target.ariaLabel || null,
      placeholder: action.target.placeholder || null,
      selectorHints: action.target.selectorHints || []
    } : null,
    valueShape: action.valueShape || null
  };
}

function operationShape(events) {
  const roles = new Set(events.flatMap((event) => event.roles || []));
  const hasDownload = events.some((event) => event.type === "download" || event.roles.includes("file"));
  if (roles.has("async") && hasDownload) return "async_export_or_download";
  if (roles.has("async")) return "async_operation";
  if (hasDownload) return "export_or_download";
  if (roles.has("mutation")) return "mutation_or_submit";
  if (roles.has("query")) return "query_or_search";
  if (events.length > 1) return "multi_request_chain";
  return "single_request";
}

function chainConfidence(events, hasAction) {
  let confidence = hasAction ? 0.45 : 0.3;
  const roles = new Set(events.flatMap((event) => event.roles || []));
  if (roles.has("result")) confidence += 0.15;
  if (roles.has("file")) confidence += 0.15;
  if (roles.has("query") || roles.has("mutation")) confidence += 0.1;
  if (events.some((event) => event.requestPayloadKeys.length > 0 || event.responseBodyKeys.length > 0)) confidence += 0.1;
  if (events.length > 1) confidence += 0.05;
  return Math.min(0.95, Number(confidence.toFixed(2)));
}

const records = parseLines(inputFile);
const userActions = userActionsFile && existsSync(userActionsFile) ? parseLines(userActionsFile) : [];
const markers = records.filter((record) => record.type === "marker").sort((a, b) => a.ts - b.ts);
const responses = new Map(records.filter((record) => record.type === "response").map((record) => [record.id, record]));
const requests = records.filter((record) => record.type === "request");
const downloads = records.filter((record) => record.type === "download");

const requestEvents = requests
  .map((request) => {
    const response = responses.get(request.id);
    const shape = urlShape(request.url);
    const traffic = classifyTraffic(request, response);
    const markerBefore = lastMarkerBefore(markers, request.ts);
    const requestKeyPaths = jsonKeyPaths(request.postData);
    const responseKeyPaths = jsonKeyPaths(response?.bodyText);
    const roles = detectRoles(request, response, requestKeyPaths, responseKeyPaths);
    const scoring = scoreCandidate(request, response, markerBefore, traffic, roles);
    return {
      type: "request",
      ts: request.ts,
      id: request.id,
      pageName: request.pageName || null,
      method: request.method,
      url: request.url,
      path: urlPath(request.url),
      origin: shape.origin,
      endpointTemplate: shape.templatePath,
      queryKeys: shape.queryKeys,
      querySignature: shape.querySignature,
      groupKey: `${request.method} ${shape.origin}${shape.templatePath}?${shape.querySignature}`,
      status: response?.status || null,
      contentType: response?.contentType || null,
      resourceType: request.resourceType || null,
      requestPayloadKeys: keys(request, "postDataKeys"),
      responseBodyKeys: keys(response, "bodyKeys"),
      requestKeyPaths,
      responseKeyPaths,
      traffic,
      roles,
      markerBefore: markerBefore?.name || null,
      score: scoring.score,
      reasons: scoring.reasons
    };
  });

const downloadEvents = downloads.map((download) => {
  const shape = urlShape(download.url);
  const markerBefore = lastMarkerBefore(markers, download.ts);
  return {
    type: "download",
    ts: download.ts,
    id: `download-${download.ts}`,
    pageName: download.pageName || null,
    method: "GET",
    url: download.url,
    path: urlPath(download.url),
    origin: shape.origin,
    endpointTemplate: shape.templatePath,
    queryKeys: shape.queryKeys,
    querySignature: shape.querySignature,
    groupKey: `DOWNLOAD ${shape.origin}${shape.templatePath}?${shape.querySignature}`,
    status: null,
    contentType: null,
    resourceType: "download",
    requestPayloadKeys: [],
    responseBodyKeys: [],
    requestKeyPaths: [],
    responseKeyPaths: [],
    traffic: { likelyNoise: false, reasons: [], apiSignals: ["playwright-download"], apiLikelihood: 4 },
    roles: ["file"],
    markerBefore: markerBefore?.name || null,
    score: 12,
    reasons: ["playwright download event"],
    suggestedFilename: download.suggestedFilename,
    savedPath: download.savedPath
  };
});

const allEvents = [...requestEvents, ...downloadEvents].sort((a, b) => a.ts - b.ts);
const apiEvents = allEvents.filter((event) => !event.traffic.likelyNoise);

const groupMap = new Map();
for (const event of apiEvents) {
  if (!groupMap.has(event.groupKey)) {
    groupMap.set(event.groupKey, []);
  }
  groupMap.get(event.groupKey).push(event);
}

const endpointGroups = [...groupMap.entries()]
  .map(([groupKey, events], index) => {
    const first = events[0];
    const id = `eg-${String(index + 1).padStart(3, "0")}`;
    for (const event of events) event.groupId = id;
    return {
      id,
      groupKey,
      method: first.method,
      origin: first.origin,
      templatePath: first.endpointTemplate,
      queryKeys: first.queryKeys,
      requestCount: events.length,
      firstTs: events[0].ts,
      lastTs: events[events.length - 1].ts,
      pageNames: uniq(events.map((event) => event.pageName)),
      statuses: countBy(events.map((event) => event.status)),
      contentTypes: countBy(events.map((event) => event.contentType)),
      resourceTypes: countBy(events.map((event) => event.resourceType)),
      roleHints: uniq(events.flatMap((event) => event.roles)),
      requestPayloadKeys: uniq(events.flatMap((event) => event.requestPayloadKeys)),
      responseBodyKeys: uniq(events.flatMap((event) => event.responseBodyKeys)),
      responseKeyPaths: uniq(events.flatMap((event) => event.responseKeyPaths)).slice(0, 80),
      representativeUrls: uniq(events.map((event) => event.url)).slice(0, 5),
      maxScore: Math.max(...events.map((event) => event.score)),
      averageScore: Number((events.reduce((sum, event) => sum + event.score, 0) / events.length).toFixed(2))
    };
  })
  .sort((a, b) => b.maxScore - a.maxScore || b.requestCount - a.requestCount);

const groupIdByKey = new Map(endpointGroups.map((group) => [group.groupKey, group.id]));
for (const event of apiEvents) {
  event.groupId = groupIdByKey.get(event.groupKey);
}

const candidates = apiEvents
  .map(summarizeEvent)
  .sort((a, b) => b.score - a.score)
  .slice(0, 50);

const noiseEvents = allEvents.filter((event) => event.traffic.likelyNoise);
const trafficNoiseReport = {
  totalRecords: records.length,
  requestCount: requests.length,
  responseCount: responses.size,
  downloadCount: downloads.length,
  keptApiEventCount: apiEvents.length,
  noisyEventCount: noiseEvents.length,
  noiseReasons: countBy(noiseEvents.flatMap((event) => event.traffic.reasons)),
  apiSignals: countBy(apiEvents.flatMap((event) => event.traffic.apiSignals)),
  noisySamples: noiseEvents.slice(0, 20).map((event) => ({
    ts: event.ts,
    method: event.method,
    url: event.url,
    resourceType: event.resourceType,
    contentType: event.contentType,
    reasons: event.traffic.reasons
  }))
};

const chronologicalCandidates = apiEvents.sort((a, b) => a.ts - b.ts);
const beforeMarkers = markers.filter((marker) => /^before_|_start$|start_/i.test(marker.name || ""));
const actionWindows = beforeMarkers.map((start) => {
  const end = markers.find((marker) => marker.ts > start.ts && /^after_|_done$|end_/i.test(marker.name || ""));
  const events = chronologicalCandidates
    .filter((candidate) => candidate.ts >= start.ts && (!end || candidate.ts <= end.ts))
    .map(summarizeEvent);
  return {
    startMarker: start.name,
    endMarker: end?.name || null,
    events
  };
});

const linkableActionTypes = new Set(["ui.click", "ui.input", "ui.change", "ui.submit", "ui.download"]);
const uiActions = userActions.filter((action) => linkableActionTypes.has(action.type || ""));
const actionApiLinks = uiActions
  .map((action, index, actions) => {
    const nextAction = actions[index + 1];
    const hardStopTs = action.ts + 10000;
    const stopTs = nextAction ? Math.min(nextAction.ts, hardStopTs) : hardStopTs;
    const events = chronologicalCandidates
      .filter((candidate) => candidate.ts >= action.ts && candidate.ts <= stopTs)
      .filter((candidate) => !action.pageName || !candidate.pageName || candidate.pageName === action.pageName)
      .map((event) => ({ ...event, deltaMs: event.ts - action.ts }));
    const grouped = [...new Map(events.map((event) => [event.groupId, event])).values()];
    return {
      action: actionSummary(action),
      window: { startTs: action.ts, stopTs },
      endpointGroups: grouped.map((event) => ({
        groupId: event.groupId,
        deltaMs: event.deltaMs,
        method: event.method,
        templatePath: event.endpointTemplate,
        roles: event.roles,
        score: event.score
      })),
      events: events.map(summarizeEvent)
    };
  })
  .filter((entry) => entry.events.length > 0);

const apiChainCandidates = actionApiLinks
  .map((link, index) => {
    const events = link.events
      .filter((event) => event.score >= 4)
      .slice(0, 12);
    if (events.length === 0) return null;
    const shape = operationShape(events);
    return {
      id: `chain-${String(index + 1).padStart(3, "0")}`,
      source: "ui-action-window",
      action: link.action,
      operationShape: shape,
      confidence: chainConfidence(events, true),
      reasons: uniq([
        "events occurred after a recorded UI action",
        ...events.flatMap((event) => event.roles.map((role) => `role:${role}`)),
        ...events.flatMap((event) => event.reasons)
      ]).slice(0, 20),
      steps: events.map((event, stepIndex) => ({
        index: stepIndex + 1,
        groupId: event.groupId,
        method: event.method,
        templatePath: event.endpointTemplate,
        representativeUrl: event.url,
        roles: event.roles,
        status: event.status,
        requestPayloadKeys: event.requestPayloadKeys,
        responseBodyKeys: event.responseBodyKeys,
        responseKeyPaths: event.responseKeyPaths
      }))
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.confidence - a.confidence);

const outputPath = resolve(outputFile);
const outputDir = dirname(outputPath);
mkdirSync(outputDir, { recursive: true });
const sidecars = {
  endpointGroups: join(outputDir, "endpoint-groups.json"),
  trafficNoiseReport: join(outputDir, "traffic-noise-report.json"),
  actionApiLinks: join(outputDir, "action-api-links.json"),
  apiChainCandidates: join(outputDir, "api-chain-candidates.json")
};

const analysis = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  tool: "TwinSkill network analysis",
  inputFile,
  userActionsFile: userActionsFile || null,
  model: {
    denoise: "static/background traffic filtering with API-likelihood signals",
    endpointGrouping: "method + origin + normalized path template + query-key signature",
    taskLinking: "UI action windows with pageName-aware temporal alignment",
    chainProposal: "ordered endpoint groups after UI actions, classified by role hints"
  },
  sidecars: Object.fromEntries(Object.entries(sidecars).map(([key, path]) => [key, basename(path)])),
  trafficNoiseReport,
  endpointGroups,
  candidates,
  actionWindows,
  actionApiLinks,
  apiChainCandidates
};

writeFileSync(outputPath, `${JSON.stringify(analysis, null, 2)}\n`);
writeFileSync(sidecars.endpointGroups, `${JSON.stringify({ generatedAt: analysis.generatedAt, endpointGroups }, null, 2)}\n`);
writeFileSync(sidecars.trafficNoiseReport, `${JSON.stringify({ generatedAt: analysis.generatedAt, trafficNoiseReport }, null, 2)}\n`);
writeFileSync(sidecars.actionApiLinks, `${JSON.stringify({ generatedAt: analysis.generatedAt, actionApiLinks }, null, 2)}\n`);
writeFileSync(sidecars.apiChainCandidates, `${JSON.stringify({ generatedAt: analysis.generatedAt, apiChainCandidates }, null, 2)}\n`);

console.log(`Wrote TwinSkill API analysis to ${outputPath}`);
console.log(`Endpoint groups: ${endpointGroups.length}; chain candidates: ${apiChainCandidates.length}; noise events: ${trafficNoiseReport.noisyEventCount}`);
