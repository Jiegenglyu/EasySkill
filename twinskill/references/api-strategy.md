# API Twin Strategy

Use this file after recording `network.jsonl` and before writing `operation.recipe.draft.json`.

TwinSkill treats UI automation as discovery and fallback. The durable target is an API-level digital twin of the demonstrated human workflow: an ordered, replayable API chain with declared inputs, captured state, and verifiable outputs.

## API First

Prefer API replay when any of these are true:

- The operation is a search, export, approval, submit, report generation, download, pagination, or batch action.
- The same workflow must run for more than 1-3 examples.
- The UI uses async jobs, polling, generated download URLs, or hidden filters.
- The page layout changes across users, tenants, zoom levels, or screen sizes.

Use the UI to collect human intent, auth state, request order, dynamic tokens, and representative payloads. Use `scripts/analyze-network.mjs` to turn the raw stream into endpoint groups and chain candidates. The durable output should be `operation.recipe.draft.json` executed by `scripts/run-operation.mjs`.

## Discovery Pipeline

Run:

```bash
node twinskill/scripts/analyze-network.mjs \
  runs/export-report/network.jsonl \
  runs/export-report/api-analysis.json \
  runs/export-report/user-actions.jsonl
```

The analyzer writes:

- `api-analysis.json`: complete TwinSkill 2.0 analysis.
- `endpoint-groups.json`: API-like requests grouped by method, origin, normalized path template, and query-key signature.
- `traffic-noise-report.json`: static assets, telemetry, full HTML documents, and other likely noise that were filtered before task reasoning.
- `action-api-links.json`: page-aware temporal links from UI actions to endpoint groups.
- `api-chain-candidates.json`: ordered API chains likely to reproduce the demonstrated task.

The older `candidates` list is still present inside `api-analysis.json`, but it is not the selection mechanism. It is a ranked view of events after denoising and grouping.

## Useful API Chain Criteria

Select endpoint chains that:

- Occur after a relevant user action or inside a `mark_before_action` / `mark_after_action` window.
- Belong to stable endpoint groups, not one-off static, telemetry, menu, feature-flag, or heartbeat traffic.
- Change predictably when the sample input changes.
- Have request parameters that map to user inputs, current page state, or values captured from earlier API responses.
- Return result-like fields, file headers, job ids, task ids, cursors, totals, rows, records, or download URLs.
- Can be replayed with declared inputs plus captured state from earlier recipe steps.

Reject endpoints that only load menus, permissions, telemetry, feature flags, static assets, full HTML documents, or background heartbeats unless no better API route exists and the recipe explains why.

## Multiple Demonstrations

When a single recording leaves uncertainty, ask for 1-2 more demonstrations with changed inputs. Compare `endpoint-groups.json` and `api-chain-candidates.json` across runs:

- Values that change with the human input become `inputs`.
- Values returned by one step and used by a later step become `state` captures.
- Values that remain stable across runs are likely tenant, locale, default filter, or auth context.
- Endpoint groups that appear in every relevant run are stronger chain candidates than one-off high-scoring requests.

## Replace UI Waits With Business Waits

Use:

- Response status and response body assertions.
- DOM assertions only when no replayable API proof exists.
- Polling repeat conditions with explicit max attempts.
- Download metadata: filename, content type, byte size.

Do not use `networkidle`, quiet-period heuristics, success toasts, or fixed sleeps as proof that the operation is complete.
