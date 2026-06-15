---
name: api-replay-recorder
description: Fake and preserve human browser operations by recording UI actions, page transitions, downloads, and network requests, then turning the trace into reusable pre-skill materials for a low-capability agent. Use when an agent must copy a human UI workflow on logged-in web apps, replay what the user did visually, generate local artifacts for later skills such as data scraping, analysis, and reporting, or compile the discovered workflow into semantic operation specs and deterministic API/state-machine replay with explicit runtime-fit and acceptance checks.
---

# Fake Human UI Recorder

## Overview

Use this skill as a pre-skill for copying human web operations. It records a real or agent-driven browser session, preserves the UI timeline and related API/download traffic, and produces compact local materials that a later full skill can use for tasks such as data scraping, data analysis, report generation, approval flows, exports, and batch operations.

The main goal is not to finish the business task directly. The goal is to fake the human UI operation once, preserve enough evidence to analyze the operation mechanism, and keep a low-capability agent on a narrow state-machine path. Playwright discovers the operation and refreshes auth, scripts create compact artifacts, and replay uses two distinct meanings:

- **UI replay**: best-effort visual replay from `user-actions.jsonl` with recorded URLs, viewport sizes, and click coordinates. Use this only when the user asks to "show what I did" or wants to inspect the captured path. It is not an acceptance gate.
- **API replay**: deterministic HTTP execution from `operation.recipe.draft.json`. Use this as the only correctness replay for repeatable operations, batch work, exports, scraping, or later skills.

Recording captures phenomena; replay needs mechanism. Treat "recording complete" as evidence capture only, not as replayability, correctness, or task completion. The required bridge is:

```text
UI/network evidence -> operation.spec.json -> replay-feasibility.json -> runtime recipe or harness -> accepted replay
```

Do not invent ad hoc Playwright replay scripts. Use `scripts/replay-ui.mjs` for visual inspection only. For API replay, first write `operation.spec.json`, then compile it into `operation.recipe.draft.json` only if the generic runner can represent the mechanism. If not, keep the spec and build a narrow state-machine harness with explicit states, runtime values, assertions, and acceptance checks. Produce final API materials only after the user explicitly confirms that the replay result is correct.

## Agent Assumption

- Assume no stronger model is available for planning, review, endpoint selection, or recovery.
- Make every important decision either deterministic or bounded by small enumerations.
- Require scripts to create compact artifacts before the agent reasons over them.
- Prefer "choose one candidate from a ranked list" over "inspect all network traffic".
- Prefer "fill these declared variables and run an operation recipe" over "write a custom replay program" only after the semantic operation spec says the generic runner fits.
- Stop and ask for a tighter state machine when the current UI path cannot be expressed with fixed selectors and assertions.
- Stop the local patch loop after a preflight failure or two replay failures. Re-run operation analysis before changing more JSON.
- Treat "Interrupted" or a failed shell command as unknown until the command output proves the cause. Do not claim a permission failure when earlier commands with the same prefix already ran.

## Core Rules

- Do not ask the model to freely browse, inspect, decide, and batch-query in one loop.
- Prefer human-driven recording when the user can perform the operation. Let the user click; let the agent wait, record, summarize, and replay.
- Use the UI for 1-3 representative examples only. Run repeated work through the captured API operation.
- Persist raw artifacts to files. Put only compact summaries and selected candidates in model context.
- Treat cookies, bearer tokens, CSRF tokens, and intranet data as local secrets. Do not paste them into chat, logs, or final answers.
- Use selectors, URL assertions, timeouts, and state transitions owned by code. The model may choose among known actions but must not invent arbitrary browser operations.
- Do not design a strong-model/weak-model handoff. This skill is for one low-capability agent operating with deterministic guardrails.
- The required final output is a user-confirmed executable API material set plus a short invocation command, not just an endpoint guess.
- Do not generate a final business skill from the recording. Produce durable pre-skill materials that another workflow can compose into a complete skill later.
- Treat unconfirmed API chains as draft material. Do not present `operation.recipe.json` as final until API replay has run and the user has explicitly accepted the result.
- Do not generalize from one successful business skill by copying its domain path. Generalize the structure: explicit path choice, business contracts, auth model, state transitions, failure branches, acceptance checks, and stable output model.
- Do not treat raw network order as operation logic. Compile observed requests into a semantic operation spec before choosing a runtime.

## Material Requirements

Every recording must preserve enough local material to replay or compose the operation later:

- Interfaces: method, URL, redacted headers, payload shape, response status, response keys, file/download metadata, and request order.
- Auth: `storage-state.json`, redacted auth header names, cookie domains, CSRF-like header names, login redirects, and refresh triggers such as `401` or `403`.
- Navigation: page attachment, main-frame URL changes, popups/new pages, downloads, and `pageName` on UI actions and network events.
- Operation logic: user action timeline, API chain after each action, captured state values such as `jobId` or `downloadUrl`, and final output paths.
- Operation semantics: primary business action, input-to-payload mapping, auth/token providers, durable ids, polling semantics, download authorization, output contract, and acceptance checks.

Keep these materials local. Summaries may mention header names and domains, but never raw token, cookie, or business data values.

## Artifact Layout

Create a run directory for every task:

```text
runs/<task-name>/
  storage-state.json        # login state, local only
  session.json              # recording scope, stop reason, pages observed
  network.jsonl             # raw API/download capture with pageName
  user-actions.jsonl        # human click/input/change/navigation timeline
  candidates.json           # compact ranked operation candidates
  operation.spec.json       # semantic mechanism: inputs, states, anchors, auth, outputs
  replay-feasibility.json   # runtime fit, gaps, selected runner or harness
  operation.recipe.draft.json # unconfirmed API operation contract
  operation.recipe.json     # user-confirmed final API operation contract
  inputs.json               # user-specified variables for replay
  validation.json           # replay checks on 2-3 examples
  replay-acceptance.json    # explicit user acceptance of API replay
  api-materials.json        # final API material manifest
  results.jsonl             # structured batch output
  ui-replay-report.json     # best-effort visual replay report
  downloads/                # exported files
  screenshots/              # failure screenshots only
```

## Operation Discovery Workflow

1. Establish login state with Playwright and save `storage-state.json`. Do not print auth headers or cookies.
2. Translate the user's request into one concrete UI action, such as `export current report as Excel` or `search keyword and download results`.
3. If the user can operate the site manually, use Human-Driven Recording. Otherwise execute one representative UI action through the fixed state machine below.

## Human-Driven Recording

Use this as the default mode when the user can click the site faster than the agent can safely navigate it.

1. Start a headed browser recorder:

```bash
node api-replay-recorder/scripts/human-record.mjs \
  "https://internal.example.com/report" \
  runs/export-report
```

The recorder refuses to silently mix a new run with existing artifacts. If `runs/export-report` already contains recording files, it creates a timestamped sibling directory and prints the actual run directory. Use that printed directory for summarize, UI replay, and API replay commands. Pass `--append` only when intentionally continuing the same run.

2. Tell the user to complete the exact operation once, for example choose filters and click Export.
3. Wait while the script records `network.jsonl`, `user-actions.jsonl`, downloads, and `storage-state.json`.
4. End recording only when the user explicitly ends the operation by pressing Enter in the terminal, or by sending SIGINT/SIGTERM to cancel and finalize local artifacts.

5. Summarize the session:

```bash
node api-replay-recorder/scripts/summarize-network.mjs \
  runs/export-report/network.jsonl \
  runs/export-report/candidates.json \
  runs/export-report/user-actions.jsonl
```

6. Use `uiTimeline` and `actionWindows` in `candidates.json` to map the user's click to the API request chain.
7. Run Operation Analysis and write `operation.spec.json`.
8. Run Runtime Fit Analysis and write `replay-feasibility.json`.
9. If the generic runner fits, write `operation.recipe.draft.json`, preflight it, then execute it with `scripts/run-operation.mjs`. If it does not fit, build a narrow state-machine harness from `operation.spec.json`.
10. Show the replay result to the user without exposing secrets. If and only if the user explicitly confirms the replay is correct, finalize the materials with `scripts/finalize-api-materials.mjs`.

## Operation Analysis

Run this before writing any recipe. The point is to translate observed UI/network evidence into the mechanism the enterprise system actually uses.

Read `references/operation-spec.md`, then write `operation.spec.json` with:

- `operationType`: classify as `simple-query`, `paginated-query`, `sync-download`, `async-job-download`, `cross-domain-download`, `form-submit`, `approval-flow`, `multi-page-workflow`, or `ui-only-state-machine`.
- `userIntent`: the business action, object, and expected output.
- `inputs`: user-controlled business values and where they appear in UI/API evidence.
- `apiChain`: requests grouped by role, such as bootstrap token, primary action, status poll, download, verification, or auxiliary metadata.
- `stateModel`: runtime values to capture, durable business/server ids, terminal states, and weak anchors to reject.
- `authModel`: storage state, login redirects, token providers, refresh triggers, and values that recording intentionally redacted.
- `acceptance`: proof that replay is business-equivalent to the recorded operation.

Do not use a success case as a domain template. Use it only as evidence that robust skills reduce open-ended UI work into one of these shapes:

```text
explicit path choice
business contract
auth and token model
state transitions
failure branches
acceptance checks
stable output model
```

## Runtime Fit Analysis

Write `replay-feasibility.json` after `operation.spec.json`.

Use `fit: "supported"` only when the mechanism can be represented by `scripts/run-operation.mjs`:

- Ordered HTTP steps.
- Templates limited to `${input.*}`, `${state.*}`, and `${env.*}`.
- Simple dot-path captures such as `$.data.taskId`.
- Polling with `equals` or `exists`.
- File outputs with explicit status, content-type, and size checks.

Use `fit: "unsupported"` and choose a specialized harness when the spec needs:

- Array filtering or row matching by predicate, such as "find row where taskId equals this run's taskId".
- Runtime token providers not expressible as ordinary recipe steps.
- SSO refresh, localStorage/sessionStorage extraction, or browser-only auth.
- Cross-domain download authorization or token exchange.
- File parsing, content validation, or domain-specific assertions beyond generic checks.
- Multi-page UI state as part of the mechanism.

Do not run replay when fit is unsupported. Running anyway turns a compiler/runtime mismatch into a local patch loop.

Preflight supported recipes:

```bash
node api-replay-recorder/scripts/validate-recipe.mjs \
  runs/export-report/operation.recipe.draft.json \
  runs/export-report/inputs.json
```

## UI Replay Workflow

Use UI replay only to visibly repeat a captured browser path once. It is not a correctness proof and may click different content if the website changes, recommendations reorder, or coordinates no longer map to the same element. User acceptance of UI replay does not authorize final API materials; acceptance must be based on API replay output.

Run:

```bash
node api-replay-recorder/scripts/replay-ui.mjs \
  runs/export-report
```

Useful flags:

- `--headless`: run without a visible browser.
- `--dry-run`: print the planned navigation and actions without opening the browser.
- `--keep-open`: leave the browser open after replay for inspection.
- `--step-delay-ms=1000`: set the delay between actions.

After running, inspect `ui-replay-report.json`. If it reports skipped `ui.input` or `ui.change` actions, explain that raw input values were intentionally not stored and an API recipe or a tighter state machine is required.

## Recording Scope Boundary

Define one recording run as one user-intended operation, not one page and not one click.

In scope for one run:

- The start URL and every page, popup, redirect, tab, document request, API call, and download created inside the same browser context.
- Multi-page flows such as list page -> detail page -> export page -> download.
- Login or SSO redirects that happen inside the recording context, while keeping credentials and tokens local.
- Async operation chains such as create job -> status polling -> download.

Out of scope for one run:

- A second unrelated user goal after the first operation is complete. Start a new run for that.
- Pages opened in a different browser/profile outside the recorder context.
- Native OS dialogs and external desktop apps. Record only the resulting browser action, API request, or download.
- Raw secrets or business data copied into summaries.

If the user performs extra unrelated clicks before ending the run, keep the raw artifacts but build the recipe only from the shortest UI/API chain that satisfies the stated operation.

## Recording End Rules

Use explicit user stop only:

- Start recording before navigation and before the user performs any operation.
- Do not tell the user to click until the recorder has attached to the browser context and printed the run directory.
- Keep recording continuously while the user operates the site and while exports, async jobs, redirects, popups, polling, and downloads continue.
- End only when the user explicitly indicates this recording is finished, normally by pressing Enter in the recorder terminal.
- If this recorder is wrapped by a chat workflow, end only when the user says the current operation/recording is finished, such as "结束录制" or "本次操作完成".
- Treat SIGINT/SIGTERM as explicit user cancellation; finalize artifacts before closing.

Do not use Playwright `networkidle`, quiet-period heuristics, auto-stop timers, success toasts, downloads, or hard timeouts as recording end conditions. Long-running exports may appear idle for a long time before producing a file. Success signals are useful for later analysis, but they must not stop the recorder.

Write `session.json` with the start URL, stop reason, start/end timestamps, and observed pages. Use it later to decide whether the materials cover the whole operation.

## Multi-Page Handling

Record at the browser context level, not just the first page:

- Attach recorders to every new page from `context.on("page")`.
- Assign each page a stable `pageName` such as `page-1`, `page-2`, and include it in `user-actions.jsonl`.
- Record main-frame navigation as `ui.navigation`.
- Keep all page requests in one `network.jsonl` and all UI actions in one `user-actions.jsonl`.
- Preserve popup/download pages. Export buttons often open a new page or hidden document request before the file download starts.
- Use timestamps plus `pageName` to map user actions to API chains. If two pages are active at once, prefer events from the same `pageName`, then nearby events within the next 10 seconds.
- Do not split a cross-page flow into multiple recipes unless the user clearly performed two independent operations.

## Agent-Driven Discovery

Use this only when the user cannot manually operate the site.

1. Attach a network recorder before the action. Prefer `scripts/record-network.mjs`.
2. Execute one representative UI action through a fixed state machine:

```js
import { attachNetworkRecorder } from "./api-replay-recorder/scripts/record-network.mjs";

const recorder = attachNetworkRecorder(page, {
  outFile: "runs/export-report/network.jsonl"
});

recorder.mark("before_action", { operation: "export_report", format: "xlsx" });
await Promise.all([
  page.waitForResponse((response) =>
    ["fetch", "xhr", "document"].includes(response.request().resourceType())
  ),
  page.getByRole("button", { name: "Export" }).click()
]);
recorder.mark("after_action", { operation: "export_report" });
```

```yaml
states:
  - ensure_logged_in
  - open_target_page
  - assert_required_controls
  - set_user_inputs
  - mark_before_action
  - trigger_user_action
  - wait_for_api_or_download
  - mark_after_action
  - assert_operation_result
  - save_artifacts
```

3. Repeat for at most 2 more representative examples when variables, filters, export format, pagination, or async jobs are uncertain.
4. Summarize `network.jsonl` with `scripts/summarize-network.mjs`; inspect `candidates.json`, not the raw log.
5. Select the operation chain using the heuristics below. An operation may have multiple requests.
6. Write `operation.spec.json` using `references/operation-spec.md`.
7. Write `replay-feasibility.json` and choose `run-operation.mjs` or a specialized harness.
8. If supported, write `operation.recipe.draft.json` using `references/api-recipe.md` and preflight it with `scripts/validate-recipe.mjs`.
9. Validate replay on 1-3 known examples before running the user-requested operation.
10. Execute the operation with `scripts/run-operation.mjs` or a narrowly equivalent harness.
11. Ask the user to confirm whether the replay result is correct. Finalize the API materials only after explicit confirmation.

## Low-Capability Agent Action Contract

When an LLM must control part of the UI, force it to emit only JSON matching this shape:

```json
{
  "action": "fill",
  "target": "search_input",
  "value": "example query"
}
```

Allowed actions:

- `click`
- `fill`
- `select`
- `wait_for_url`
- `wait_for_selector`
- `mark`
- `extract_text`
- `stop`

The executor must map `target` names to fixed selectors. Reject any action outside the enum, any unknown target, and any value that does not match the current state. Keep a small step budget per state and fail closed with a screenshot and network log. The agent should never receive a raw DOM dump or full HAR unless a human explicitly asks for debugging.

## Endpoint Selection Heuristics

Prefer requests that:

- Occur after `mark_before_action` and before `mark_after_action`.
- Are `fetch`, `xhr`, `document`, or a Playwright download event, not image, script, beacon, analytics, or telemetry.
- Have JSON request/response bodies, file response headers, or download metadata.
- Contain action words in the URL or payload such as `search`, `query`, `export`, `download`, `report`, `file`, `task`, `job`, `approve`, or `submit`.
- Return result-like keys such as `items`, `records`, `rows`, `list`, `data`, `total`, `page`, `jobId`, `taskId`, `downloadUrl`, `fileId`, or `status`.
- Reappear with predictable payload changes across different sample inputs.

Treat these as candidate evidence for operation types:

- `simple-query`: one request returns the business result.
- `paginated-query`: query request has cursor, page, offset, or limit semantics.
- `sync-download`: action returns `text/csv`, Excel, PDF, octet-stream, or `content-disposition`.
- `async-job-download`: first request creates `jobId`, `taskId`, `exportId`, `requestId`, or equivalent; later requests poll and download.
- `cross-domain-download`: download URL host differs from app host, or a token exchange precedes the file request.
- `form-submit` / `approval-flow`: request mutates durable business state and needs a verification endpoint.
- `multi-page-workflow`: browser navigation, frame state, or popup state remains part of the mechanism.

Reject candidates that:

- Are static assets, tracking calls, permission heartbeats, feature flags, or menu metadata.
- Do not change when the query changes.
- Return HTML for full-page navigation unless no API endpoint exists.
- Require browser-only state that cannot be refreshed or reproduced reliably.

## Replay Workflow

Use direct HTTP replay only after operation analysis and runtime fit analysis. Do not use this workflow until `operation.spec.json`, `replay-feasibility.json`, and `operation.recipe.draft.json` exist and the feasibility result says the generic runner fits. This is the only generic replay mode that can promote API materials to final status.

1. Load auth from `storage-state.json` or a browser-refreshed session.
2. Run `scripts/validate-recipe.mjs`. Treat errors as a hard stop and warnings as prompts to revisit `operation.spec.json`.
3. Build requests from `operation.recipe.draft.json`, replacing only declared input variables.
4. Run a small validation set and compare status code, returned fields, captured durable ids, file metadata, or known UI observations.
5. Run the user-requested operation. For batches, checkpoint after every item.
6. Show a compact replay result to the user: statuses, response keys, captured anchors, row counts, file names, file sizes, or other non-secret proof points.
7. Wait for explicit user confirmation that the replay result is business-equivalent to the UI operation.
8. Finalize the materials by promoting `operation.recipe.draft.json` to `operation.recipe.json`, writing `replay-acceptance.json`, and writing `api-materials.json`.
9. Use rate limits and retries with backoff. On repeated `401`, `403`, CSRF errors, or redirect-to-login responses, refresh auth with Playwright and resume from the checkpoint.
10. Save structured responses to `results.jsonl` and exported files to `downloads/`.

Example invocation:

```bash
node api-replay-recorder/scripts/validate-recipe.mjs \
  runs/export-report/operation.recipe.draft.json \
  runs/export-report/inputs.json

node api-replay-recorder/scripts/run-operation.mjs \
  runs/export-report/operation.recipe.draft.json \
  runs/export-report/inputs.json \
  runs/export-report
```

After the user confirms the API replay is correct:

```bash
node api-replay-recorder/scripts/finalize-api-materials.mjs \
  runs/export-report \
  --user-confirmed \
  --confirmed-by=user
```

## Failure Recovery

- If no stable endpoint appears, capture another run with one changed query value and compare candidates.
- If CSRF or nonce fields differ per request, add a runtime token provider to `operation.spec.json`; only add recipe steps if the generic runner can fetch and apply the token.
- If the endpoint paginates, identify page, cursor, offset, or limit fields before batch execution.
- If export is async, model create-job, poll, and download roles in `operation.spec.json`; require the poll/download chain to use this run's durable id.
- If the system exposes a task list, do not use "latest row" unless no durable id exists and the user accepts the risk.
- If the download host differs from the app host, model download authorization or token exchange explicitly. A raw URL copied from the browser is not enough.
- If the browser download has no visible API body, use the download URL and response headers as the candidate operation.
- If replay returns fewer rows than the UI, check hidden filters, tenant headers, locale, date range defaults, and permission-scoping headers.
- If replay writes a tiny file, HTML login page, JSON error, or unauthorized body, treat it as failed acceptance, not a successful download.
- If the same class of failure repeats twice, stop local repair and update `replay-feasibility.json`. The likely issue is an abstraction/runtime mismatch, not a missing field.
- If the agent loops or clicks unrelated controls, stop the run and tighten the UI state machine before retrying.

## Resources

- `scripts/human-record.mjs`: open a headed browser, let the user click manually, and record UI actions, API requests, downloads, and auth state.
- `scripts/record-network.mjs`: import this helper into Playwright scripts to write structured API/download events and action markers to `network.jsonl`.
- `scripts/summarize-network.mjs`: run this on `network.jsonl` and optional `user-actions.jsonl` to produce compact ranked operation candidates and UI-to-API timelines.
- `scripts/replay-ui.mjs`: best-effort visual replay from `user-actions.jsonl`; use for "show me what I did" requests, not deterministic automation.
- `scripts/validate-recipe.mjs`: preflight a generic recipe; it catches unsupported templates, unsupported repeat conditions, unsupported JSONPath, undeclared inputs, weak anchors, and missing file validation.
- `scripts/run-operation.mjs`: execute `operation.recipe.draft.json` or `operation.recipe.json` with user inputs and local auth state.
- `scripts/finalize-api-materials.mjs`: promote a successful API replay to final materials only after explicit user confirmation.
- `references/operation-spec.md`: read this after summarizing evidence and before writing a recipe or harness.
- `references/api-recipe.md`: read this before writing `operation.recipe.draft.json`, finalizing `operation.recipe.json`, or creating a replay harness.
