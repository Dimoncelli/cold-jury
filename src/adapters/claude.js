import { buildPrompt } from '../probes.js';
import { runSpawnEngine } from '../runner.js';

export const ENGINE = 'claude';

export function createClaudeAdapter(deps = {}) {
  return {
    engine: ENGINE,
    async run({ spec, diffRedacted, probe, author = '', timeoutMs = 120_000, cwd, nonce = '' } = {}) {
      return runSpawnEngine({
        engine: ENGINE,
        binName: deps.binName ?? 'claude',
        args: ['-p', '--output-format', 'json'],
        prompt: buildPrompt({ spec, diffRedacted, probe, nonce }),
        nonce,
        probe,
        author,
        timeoutMs,
        cwd,
        deps,
      });
    },
  };
}

export default createClaudeAdapter;
