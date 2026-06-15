# Semantic Operation Spec

Use this reference after `summarize-network.mjs` and before writing `operation.recipe.draft.json`.

Recording artifacts capture observed phenomena: clicks, navigations, requests, responses, and downloads. A repeatable operation needs the mechanism behind those observations: business inputs, server state, runtime tokens, durable ids, polling semantics, authorization, and acceptance checks.

Write `operation.spec.json` first. Then decide whether the generic recipe runner can execute it, or whether the operation needs a specialized state-machine harness.

## Required Shape

```json
{
  "name": "export-report",
  "purpose": "Export a filtered report.",
  "operationType": "async-job-download",
  "userIntent": {
    "action": "export",
    "object": "report",
    "output": "xlsx"
  },
  "inputs": {
    "startDate": {
      "kind": "business-filter",
      "source": "user",
      "observedIn": ["request.body.startDate"]
    }
  },
  "apiChain": [
    {
      "role": "bootstrap-token",
      "evidence": "request/response ids or candidate paths",
      "captures": ["csrfToken"]
    },
    {
      "role": "primary-action",
      "evidence": "request/response ids or candidate paths",
      "captures": ["taskId"]
    },
    {
      "role": "status-poll",
      "evidence": "request/response ids or candidate paths",
      "matches": "same taskId created by primary-action",
      "doneWhen": "status is success/done"
    },
    {
      "role": "download",
      "evidence": "request/response ids or download event",
      "requires": ["download token or same-origin cookies"]
    }
  ],
  "stateModel": {
    "runtimeValues": ["csrfToken", "taskId", "downloadUrl"],
    "businessAnchors": ["taskId"],
    "weakAnchorsRejected": ["latest row", "totalRows", "timestamped filename"]
  },
  "authModel": {
    "storageState": "storage-state.json",
    "refreshTriggers": [401, 403, "redirect_to_login"],
    "runtimeTokenProviders": ["bootstrap-token step"]
  },
  "acceptance": {
    "equivalence": [
      "same business filters as recorded UI operation",
      "poll/download uses this run's taskId",
      "output file is valid and not an error page"
    ],
    "fileChecks": {
      "status": 200,
      "rejectContentTypes": ["text/html"],
      "minBytes": 10000
    }
  }
}
```

## Operation Types

- `simple-query`: one request returns the business result.
- `paginated-query`: repeated query requests are needed for the full result.
- `sync-download`: one request returns the final file.
- `async-job-download`: create job/task, poll same durable id, then download.
- `cross-domain-download`: download host differs from the app host or requires token exchange.
- `form-submit`: submit changes to server state.
- `approval-flow`: submit or approve durable business state with audit implications.
- `multi-page-workflow`: browser navigation remains part of the mechanism.
- `ui-only-state-machine`: no stable API mechanism is available; use fixed UI states and assertions.

## Runtime Fit

Write `replay-feasibility.json` after the spec:

```json
{
  "runner": "run-operation.mjs",
  "fit": "unsupported",
  "reasons": [
    "needs array filtering to find taskId row",
    "needs cross-domain download token exchange"
  ],
  "nextRuntime": "specialized async-job state-machine harness"
}
```

Use `fit: "supported"` only when the operation can be expressed with the generic runner's capabilities:

- Ordered HTTP steps.
- Templates limited to `${input.*}`, `${state.*}`, and `${env.*}`.
- Simple dot-path captures such as `$.data.taskId`.
- Polling with `equals` or `exists`.
- File output with explicit validation.

If the spec needs array filtering, row matching by predicate, dynamic token providers, browser storage APIs, SSO refresh, cross-domain token exchange, file parsing, or domain-specific assertions not available in `run-operation.mjs`, do not force it into a plain recipe. Keep the spec and write a narrow harness whose states, inputs, outputs, and acceptance checks match the spec.

## Acceptance Principle

Promotion requires business equivalence, not mechanical success. `recording complete`, HTTP 200, and file written are insufficient.

Require proof that:

- The replay used the same business inputs.
- Runtime secrets and tokens were refreshed or captured safely.
- Durable ids identify this run's server-side state.
- Polling observed the right entity reaching the right terminal state.
- Output files or structured results pass format and business checks.
- The user explicitly accepted the replay result before final materials were promoted.
