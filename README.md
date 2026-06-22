# TwinSkill

TwinSkill builds verified API-level digital twins of human web workflows for LLM agents.

A human demonstrates a browser workflow once. TwinSkill records the UI timeline and runtime network traffic, filters noisy requests, groups API-like endpoints, links useful API chains to the demonstrated task, verifies deterministic API replay, and turns the accepted replay into skill-ready materials.

The project is in its 2.0 direction: UI operation is the discovery path and fallback; API replay is the durable execution path.

## Positioning

TwinSkill is a recorder, analyzer, and Skill-production precursor. It copies one human UI operation into a managed run directory and prepares verified materials for a later complete Skill, for example:

- scrape data from an internal website
- export or download reports
- transform the captured data
- run analysis
- generate a final report
- approve, submit, or batch-process records with explicit replay validation

The key idea is to create an executable twin of the demonstrated workflow. The UI shows intent and triggers real auth/API behavior; TwinSkill turns the useful runtime API chain into `operation.recipe.draft.json`, validates replay, and finalizes only after explicit user confirmation.

## Workflow

1. Optionally run preflight against the target website to verify the standard browser environment, login state, and expected page controls.
2. Start a headed recorder on the target website.
3. Let the user complete one representative operation in the browser.
4. Save local artifacts under a separate `runs/<task-name>/` directory.
5. Analyze the UI timeline and network traffic into endpoint groups, noise reports, action-to-API links, and API chain candidates.
6. Compile the selected chain into `operation.recipe.draft.json`.
7. Run API replay and show the non-secret result summary to the user.
8. After explicit user confirmation, promote the draft recipe, write final API materials, and mark the run as `skill-ready`.
9. Use `skill-seed.json` and `skill-brief.md` as input to a later formal Skill.

Typical artifacts:

```text
runs/<task-name>/
  run-manifest.json
  storage-state.json
  session.json
  network.jsonl
  user-actions.jsonl
  environment.json
  preflight.json
  api-analysis.json
  endpoint-groups.json
  traffic-noise-report.json
  action-api-links.json
  api-chain-candidates.json
  candidates.json
  operation.recipe.draft.json
  operation.recipe.json
  inputs.json
  validation.json
  replay-acceptance.json
  api-materials.json
  skill-seed.json
  skill-brief.md
  results.jsonl
  ui-replay-report.json
  downloads/
  screenshots/
  debug-snapshots/
```

Run artifacts are intentionally ignored by git because they can contain cookies, tokens, intranet URLs, request bodies, downloaded files, or business data.

## TwinSkill 2.0 API Analysis

The network analyzer no longer treats "useful API" as a pure score-ranking problem. It follows an APISENSOR-inspired pipeline adapted to task-level workflow reconstruction:

```text
human UI demonstration
-> record UI actions + runtime network traffic
-> denoise static/background/telemetry traffic
-> normalize endpoint paths into templates
-> group similar API-like requests
-> align endpoint groups to UI action windows
-> propose ordered API chain candidates
-> replay the selected chain
-> user confirms
-> finalize skill-ready materials
```

The main outputs are:

- `endpoint-groups.json`: normalized API-like endpoint clusters, such as `/api/report/{number}/export`.
- `traffic-noise-report.json`: requests filtered as static assets, telemetry, full documents, or background traffic.
- `action-api-links.json`: endpoint groups that happened after recorded UI actions, page-aware when possible.
- `api-chain-candidates.json`: ordered chains likely to reproduce the demonstrated task.
- `api-analysis.json`: the complete analysis bundle, including a legacy ranked `candidates` view.

Score still exists, but it is only supporting evidence. The durable selection should be a replayable API chain with declared inputs, captured state, and verifiable outputs.

## Installation

This repository can be used by Codex, OpenCode, Claude Code, Cursor-style agents, or any local AI agent that can read a folder of instructions and run shell commands.

The skill itself is the folder:

```text
twinskill/
```

The important entrypoint for an AI agent is:

```text
twinskill/SKILL.md
```

Agent-facing install prompt:

```text
Install the TwinSkill skill.

1. Clone https://github.com/Jiegenglyu/TwinSkill.git.
2. Run npm install from the repository root.
3. Use twinskill/SKILL.md as the skill entrypoint.
4. If your environment has a skills directory, install the whole twinskill folder there by copy or symlink.
5. Keep runs/, storage-state.json, network.jsonl, user-actions.jsonl, downloads/, cookies, tokens, CSRF values, and intranet data local. Do not commit or paste them into chat.
```

Manual install:

```bash
git clone https://github.com/Jiegenglyu/TwinSkill.git ~/.twinskill
npm --prefix ~/.twinskill install
```

If your agent supports a skill directory, install the skill folder into that directory:

```bash
mkdir -p ~/.agent-skills
ln -sfn ~/.twinskill/twinskill ~/.agent-skills/twinskill
```

For agents without a native skill directory, keep the repository cloned and ask the agent to read `~/.twinskill/twinskill/SKILL.md` before using the scripts.

### For Codex

For Codex, run:

```bash
git clone https://github.com/Jiegenglyu/TwinSkill.git "${CODEX_HOME:-$HOME/.codex}/twinskill-repo"
npm --prefix "${CODEX_HOME:-$HOME/.codex}/twinskill-repo" install

mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -sfn \
  "${CODEX_HOME:-$HOME/.codex}/twinskill-repo/twinskill" \
  "${CODEX_HOME:-$HOME/.codex}/skills/twinskill"
```

Restart Codex after installation. The skill should be available as:

```text
$twinskill
```

Quick verification:

```bash
test -f ~/.twinskill/twinskill/SKILL.md
node --check ~/.twinskill/twinskill/scripts/runtime-profile.mjs
node --check ~/.twinskill/twinskill/scripts/preflight.mjs
node --check ~/.twinskill/twinskill/scripts/human-record.mjs
node --check ~/.twinskill/twinskill/scripts/analyze-network.mjs
node --check ~/.twinskill/twinskill/scripts/replay-ui.mjs
node --check ~/.twinskill/twinskill/scripts/finalize-api-materials.mjs
```

## Usage

Install dependencies:

```bash
npm install
```

The commands below assume the current working directory is the cloned `TwinSkill` repository root.

Preflight a target page before a fragile workflow:

```bash
npm run preflight -- \
  "https://internal.example.com/report" \
  runs/export-report \
  --expect-text="Report"
```

Record a human operation:

```bash
npm run record -- "https://internal.example.com/report" runs/export-report
```

Use the opened browser to complete the target operation once. Press Enter in the terminal when the operation is finished.

Analyze the captured materials:

```bash
npm run analyze -- \
  runs/export-report/network.jsonl \
  runs/export-report/api-analysis.json \
  runs/export-report/user-actions.jsonl
```

Inspect `api-chain-candidates.json`, `action-api-links.json`, and `endpoint-groups.json` before writing `operation.recipe.draft.json`.

Replay the visible UI path once from `user-actions.jsonl`:

```bash
npm run replay-ui -- runs/export-report
```

This is best-effort: it first tries recorded selector hints and falls back to recorded coordinates. It is useful for showing "what I did" once, but it is not deterministic API replay and it does not authorize final API or Skill materials.

Replay an extracted API operation from a draft recipe:

```bash
npm run replay -- \
  runs/export-report/operation.recipe.draft.json \
  runs/export-report/inputs.json \
  runs/export-report
```

After the user explicitly confirms that the API replay result is correct, finalize the API materials:

```bash
npm run finalize-api -- \
  runs/export-report \
  --user-confirmed \
  --confirmed-by=user
```

Finalization writes:

- `operation.recipe.json`: verified operation recipe
- `replay-acceptance.json`: explicit acceptance record
- `api-materials.json`: verified material manifest
- `skill-seed.json`: structured input for generating a formal Skill
- `skill-brief.md`: human-readable Skill production brief
- `run-manifest.json`: updated to `skill-ready`

Capture text-first debug evidence when a workflow fails:

```bash
npm run debug-snapshot -- \
  "https://internal.example.com/report" \
  runs/export-report \
  --storage-state=runs/export-report/storage-state.json \
  --label=after-failure
```

## Design Principles

- Record the human UI workflow once; avoid repeated fragile browser automation.
- Treat UI automation as discovery and fallback; prefer verified API replay for durable execution.
- Manage every recording as a separate run; never mix unrelated operations in one run directory.
- Standardize Playwright Chromium at `1920 x 1080`, device scale factor `1`, `zh-CN`, and `Asia/Shanghai`.
- Preserve raw materials locally; expose only compact summaries to the agent.
- Keep secrets out of chat, git, prompts, and final answers.
- Use denoising, endpoint grouping, action alignment, and replay validation before calling an API useful.
- Require explicit user confirmation before promoting draft API materials.
- Treat `skill-seed.json` and `skill-brief.md` as the handoff into a later formal Skill.

## Repository Layout

```text
twinskill/
  SKILL.md
  agents/openai.yaml
  references/environment.md
  references/selectors.md
  references/api-strategy.md
  references/api-recipe.md
  references/recovery.md
  references/skill-production.md
  scripts/runtime-profile.mjs
  scripts/preflight.mjs
  scripts/debug-snapshot.mjs
  scripts/human-record.mjs
  scripts/record-network.mjs
  scripts/analyze-network.mjs
  scripts/summarize-network.mjs
  scripts/replay-ui.mjs
  scripts/run-operation.mjs
  scripts/finalize-api-materials.mjs
```

## Status

Prototype, TwinSkill 2.0 direction. The recorder, standard runtime, preflight, text-first debug snapshots, UI replay, API replay finalization, Skill seed generation, endpoint grouping, noise reporting, action-to-API linking, and chain-candidate analysis are implemented. Automatic recipe synthesis, full UI-vs-API equivalence checking, multi-run diffing, and broad enterprise recovery remain active research and engineering work.
