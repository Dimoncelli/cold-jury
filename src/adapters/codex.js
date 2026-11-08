import { buildPrompt } from '../probes.js';
import { runSpawnEngine } from '../runner.js';

export const ENGINE = 'codex';

export function createCodexAdapter(deps = {}) {
  return {
    engine: ENGINE,
    async run({ spec, diffRedacted, probe, author = '', timeoutMs = 120_000, cwd, nonce = '' } = {}) {
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only'];
      if (cwd) args.push('-C', cwd);
      args.push('-');
      return runSpawnEngine({
        engine: ENGINE,
        binName: deps.binName ?? 'codex',
        args,
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

export default createCodexAdapter;
