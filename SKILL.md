---
name: cold-jury
description: "Cross-CLI hostile code review with three parallel jurors, pre-flight secret redaction and a deterministic PASS/BLOCK gate. Node 20+, zero dependencies."
license: MIT
metadata:
  version: "0.1.0"
---

# cold-jury

Use this skill when a change must be reviewed before it is committed or pushed, and the reviewing engine must not be the engine that wrote it.

## What it does

cold-jury reads the staged diff (or `git diff <rev>`), redacts secrets locally, and sends the same redacted input to up to three cold-start jurors running on other CLIs. Each juror answers with strict JSON. The gate is deterministic: `PASS` exits `0`, `BLOCK` exits `1`, usage or engine execution problems exit `2`.

## Prerequisites

- Node.js 20 or newer. No npm dependencies are installed by this package.
- At least one review engine in `PATH`: `claude`, `codex`, `gemini`, `opencode` or `ollama` (local HTTP on port 11434, daemon running).

## Invocation

Prefer the binary that ships inside the skill folder, so nothing is fetched at run time:

```bash
node <skill-dir>/bin/cold-jury.mjs doctor
node <skill-dir>/bin/cold-jury.mjs review --author hook --spec "One sentence about the change"
```

From a repository without the skill installed, call the package straight from GitHub:

```bash
npx --yes github:Dimoncelli/cold-jury doctor
npx --yes github:Dimoncelli/cold-jury review --author hook --spec "One sentence about the change"
```

## Workflow

1. Stage the change: `git add -A`.
2. Check the engines: `doctor`. An engine whose daemon is stopped shows `OFFLINE`, not `READY`.
3. Run the room: `review --author <engine> --spec "<one sentence>"`. From a hook or CI use `--author hook` or `--author ci`.
4. Read the verdict. Fix every `P0` and `P1` finding, stage again and repeat.
5. Keep the JSON for CI with `--json` or `--output .cold-jury/verdict.json`.
6. Optional gate: `install-hook` writes an idempotent `pre-push` hook (it reads the pushed refs from stdin and reviews the real range). `install-hook --type pre-commit` reviews the index. `--force` replaces a different hook.

## Rules

- Never pass secrets in `--spec`. The shield redacts the diff and the spec, but do not paste credentials anywhere.
- Do not lift the `Writer != Juror` rule outside a sterile room test. `--allow-same-engine` exists only for that.
- Treat a `P0 SECRET_LEAK` as a hard stop: remove the secret, rotate it, then re-run.
- `--fail-on` is the contract: `P0` blocks only on P0, `P1` on P0 and P1, `P2` on any finding.
- If every juror fails technically, the run exits `2` with `engine_execution_failed` instead of inventing a finding.
- Do not add npm dependencies to this package, and do not replace `spawn` with shell string execution.

## Output contract

`--json` prints a single object with `tool`, `version`, `author`, `jurors`, `probes`, `gate`, `exitCode`, `threshold`, `counts`, `secretShield`, `findings`, `errors`, `durationMs` and `generatedAt`. Findings are ordered `P0`, `P1`, `P2` and carry `id`, `severity`, `title`, `file`, `line`, `cwe`, `evidence` and `suggestion`. `errors` lists engine failures without turning them into code findings.

## Manifests

- `agents/openai.yaml` for Codex, including the `interface` block.
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` for Claude Code.
