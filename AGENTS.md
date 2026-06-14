# EasySkill Agent Instructions

Use this repository as an agent-readable skill package for copying human browser operations.

## What This Repo Provides

- `api-replay-recorder/SKILL.md`: main skill instructions.
- `api-replay-recorder/scripts/human-record.mjs`: record a human browser session.
- `api-replay-recorder/scripts/summarize-network.mjs`: summarize UI and network traces.
- `api-replay-recorder/scripts/run-operation.mjs`: replay an extracted operation recipe.
- `api-replay-recorder/references/api-recipe.md`: recipe schema for reusable API operations.

## When To Use

Use `api-replay-recorder` when the user wants to fake or copy a human UI operation on a web app, record the operation once, and produce materials for a later full workflow such as scraping data, analyzing results, exporting reports, or automating a repeated business action.

## Agent Setup

1. Ensure Node.js 18+ and npm are available.
2. From this repository root, run `npm install`.
3. For agents with a skills directory, install the skill with:

```bash
node install.mjs --target-dir "$HOME/.agent-skills"
```

4. For Codex-compatible installs, run:

```bash
node install.mjs --codex
```

5. For agents without native skill support, read `api-replay-recorder/SKILL.md` directly and run scripts from the repository root.

## Core Commands

Record a human browser operation:

```bash
npm run record -- "https://internal.example.com/report" runs/export-report
```

Summarize captured materials:

```bash
npm run summarize -- \
  runs/export-report/network.jsonl \
  runs/export-report/candidates.json \
  runs/export-report/user-actions.jsonl
```

Replay an extracted operation:

```bash
npm run replay -- \
  runs/export-report/operation.recipe.json \
  runs/export-report/inputs.json \
  runs/export-report
```

## Safety Rules

- Treat `runs/`, `storage-state.json`, `network.jsonl`, downloads, cookies, tokens, CSRF values, and intranet data as local secrets.
- Do not paste raw auth headers, cookies, request bodies, or business data into chat.
- Do not commit run artifacts.
- Prefer one representative human recording, then summarize and replay from local artifacts.
- Ask for human confirmation before recording or replaying destructive actions such as submit, approve, delete, or payment flows.
