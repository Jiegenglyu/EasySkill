# Operation Recipe Format

Use this file when writing `operation.recipe.draft.json` after `operation.spec.json` and `replay-feasibility.json` prove that the generic runner can express the operation mechanism. A recipe is a compiled runtime contract, not a direct translation of network logs. Promote it to `operation.recipe.json` only after replay succeeds and the user explicitly confirms that the replay result is correct.

If the semantic operation spec needs row filtering, browser-only auth refresh, dynamic token providers, cross-domain download authorization, file parsing, or domain-specific validation that the generic runner cannot perform, do not force it into this format. Keep the spec and create a specialized state-machine harness.

## Required Shape

```json
{
  "name": "export-report",
  "purpose": "Export the current report as an Excel file.",
  "sourceSpec": "operation.spec.json",
  "operationType": "async-job-download",
  "auth": {
    "storageState": "storage-state.json",
    "refreshWithPlaywright": true
  },
  "inputs": {
    "startDate": { "type": "string", "source": "user" },
    "endDate": { "type": "string", "source": "user" },
    "format": { "type": "string", "default": "xlsx" }
  },
  "steps": [
    {
      "id": "start_export",
      "request": {
        "method": "POST",
        "url": "https://internal.example.com/api/reports/export",
        "headers": {
          "content-type": "application/json"
        },
        "body": {
          "startDate": "${input.startDate}",
          "endDate": "${input.endDate}",
          "format": "${input.format}"
        }
      },
      "expect": { "status": 200 },
      "capture": {
        "jobId": "$.data.jobId"
      }
    },
    {
      "id": "poll_export",
      "repeat": {
        "maxAttempts": 30,
        "delayMs": 1000,
        "until": { "path": "$.data.status", "equals": "DONE" }
      },
      "request": {
        "method": "GET",
        "url": "https://internal.example.com/api/reports/export/${state.jobId}/status"
      },
      "expect": { "status": 200 },
      "capture": {
        "downloadUrl": "$.data.downloadUrl"
      }
    },
    {
      "id": "download_file",
      "request": {
        "method": "GET",
        "url": "${state.downloadUrl}"
      },
      "expect": {
        "status": 200,
        "rejectContentTypes": ["text/html"],
        "minBytes": 10000
      },
      "output": {
        "type": "file",
        "path": "downloads/report-${input.startDate}-${input.endDate}.xlsx",
        "minBytes": 10000,
        "rejectContentTypes": ["text/html"]
      }
    }
  ],
  "failureHandling": {
    "refreshAuthOn": [401, 403, "redirect_to_login"],
    "retry": { "maxAttempts": 3, "backoffMs": 1000 }
  },
  "rateLimit": {
    "concurrency": 1,
    "delayMs": 300
  },
  "outputs": {
    "resultLog": "results.jsonl"
  },
  "acceptance": {
    "requiresUserConfirmation": true,
    "businessAnchors": ["jobId"],
    "proofPoints": [
      "same declared business inputs as operation.spec.json",
      "poll step uses jobId captured by start_export",
      "download returns HTTP 200",
      "download is not text/html",
      "downloaded file is at least 10000 bytes"
    ]
  }
}
```

## Rules

- Keep secrets out of the recipe. Load cookies and tokens from local auth state or runtime extraction.
- Point `sourceSpec` to `operation.spec.json`.
- Set `operationType` from the semantic spec, not from a single URL name.
- Declare every user-controlled value under `inputs`.
- Represent multi-request operations as ordered `steps`.
- Use `capture` to save values needed by later steps, such as `jobId`, `taskId`, `exportId`, `requestId`, `fileId`, `docId`, `workflowId`, `approvalId`, `downloadUrl`, CSRF tokens, or cursor values.
- For async work, later steps must use the durable id captured from this run. Do not use latest row, total count, or timestamp alone as the anchor.
- Use `repeat` for polling and pagination. Keep explicit max attempts. The generic runner supports only `until.path` with `equals` or `exists`.
- Use only simple dot paths such as `$.data.jobId` and `$.headers.content-disposition`. The generic runner does not support array filters, bracket syntax, `minimum`, `contains`, joins, or arbitrary predicates.
- Use only templates supported by the generic runner: `${input.name}`, `${state.name}`, and `${env.NAME}`. Precompute timestamps, serialized JSON, or derived values into `inputs.json`.
- Use `output.type: "file"` for exports and downloads, and include file acceptance checks through `expect.minBytes`, `expect.rejectContentTypes`, or equivalent output fields.
- Include enough validation examples in the run directory to prove the recipe executes the same operation the UI performed.
- Prefer replay with the browser's storage state or request context over manually copying cookies into code.
- Model runtime tokens explicitly. If recording redacted CSRF, nonce, or download tokens, add a bootstrap step that captures fresh values and applies them through `${state.*}`. If that is not possible in the generic runner, mark the runtime fit unsupported.
- For cross-domain downloads, model token exchange or authorization explicitly. A browser-observed download URL is not stable unless required auth is reproducible.
- Treat `operation.recipe.draft.json` as an unverified hypothesis. Do not publish final API materials until `scripts/finalize-api-materials.mjs` records explicit user acceptance.

## Preflight

Run:

```bash
node api-replay-recorder/scripts/validate-recipe.mjs \
  runs/export-report/operation.recipe.draft.json \
  runs/export-report/inputs.json
```

Treat errors as hard stops. Warnings should either be fixed or explained in `replay-feasibility.json`.
