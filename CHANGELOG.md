# Changelog

All notable changes to `cold-jury` are documented in this file.

## [0.2.0] - 2026-11-16

### Added
- **Local credential-injection gateway (`--gateway` / `--sterile`)**: keeps real provider API keys in the parent process, injects an ephemeral `COLD_JURY_EPHEMERAL_TOKEN` and local `127.0.0.1` base URL into the juror subprocess, validates destination hosts against a strict provider allowlist (`403 FORBIDDEN_HOST` / `503 NO_CREDENTIAL`), and strips `x-api-key` and sensitive environment variables (`KEY`, `TOKEN`, `SECRET`, `CREDENTIAL`, `OAUTH`, `PASSWORD`) from child processes.
- **Agent execution trace evaluator (`cold-jury trace`)**: evaluates JSON, JSON array, and `.jsonl` agent execution traces with four deterministic metrics (`tool_selection_accuracy`, `mcp_compliance`, `turn_efficiency`, `workflow_completion`) and three probes (`delegation_quality`, `instruction_compliance`, `prompt_injection_detection`), supporting `--deterministic`, `--json`, and live juror evaluation with deterministic fallback.
- **`doctor --json` and `GATEWAY` column**: machine-readable JSON output for `cold-jury doctor` plus live gateway readiness column (`yes` / `no`).

### Security & Hardening
- **Fail-closed trace parsing**: unparseable or empty traces after secret-shield redaction fail closed with exit code `2` (`trace_unusable`).
- **Gateway request body cap**: enforces a `2 MB` (`2_000_000` bytes) body limit (`413 PAYLOAD_TOO_LARGE`) on both declared `Content-Length` and chunked streams, and closes active keep-alive sockets cleanly on shutdown.
- **Linear-time secret shield (`O(n)`) & new detectors**: bounded regex quantifiers in `src/shield.js` to eliminate ReDoS backtracking on large diffs/traces, plus `P0` secret detection for JSON credentials and `Authorization: Bearer` headers.
- **Input bounds & sanitization**: validates `--max-bytes` within `1000..2000000` and redacts trace payloads before juror prompt construction.

## [0.1.0] - 2026-11-13

### Added
- Initial release of `cold-jury`: zero-dependency sterile-room code review CLI with secret shield, git diff extraction, multi-juror consensus (`claude`, `codex`, `opencode`, `ollama`, `gemini`), `doctor`, `install-hook`, and CI integration.
