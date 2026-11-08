import { buildPrompt } from '../probes.js';
import { runSpawnEngine } from '../runner.js';

export const ENGINE = 'gemini';

export function createGeminiAdapter(deps = {}) {
  return {
    engine: ENGINE,
    async run({ spec, diffRedacted, probe, author = '', timeoutMs = 120_000, cwd, nonce = '' } = {}) {
      return runSpawnEngine({
        engine: ENGINE,
        binName: deps.binName ?? 'gemini',
        args: ['-p', '--output-format', 'json', '-y'],
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

export default createGeminiAdapter;
