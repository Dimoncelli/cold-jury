import fs from 'node:fs';
import path from 'node:path';
import { buildPrompt } from '../probes.js';
import { runSpawnEngine } from '../runner.js';

export const ENGINE = 'opencode';
export const PROBE_FILE = 'probe-input.md';
export const FILE_MESSAGE =
  'Audit the attached file strictly according to its instructions and output ONLY the JSON object.';

/**
 * `opencode run` needs a positional message and cannot read stdin alone, so the
 * prompt is written to a 0600 file inside the sterile room and attached with
 * --file. The diff never reaches argv.
 */
export function createOpencodeAdapter(deps = {}) {
  const fsImpl = deps.fs ?? fs;
  return {
    engine: ENGINE,
    async run({ spec, diffRedacted, probe, author = '', timeoutMs = 120_000, cwd, nonce = '' } = {}) {
      const prompt = buildPrompt({ spec, diffRedacted, probe, nonce });
      let args = ['run', '--format', 'json', FILE_MESSAGE];

      if (cwd) {
        const probePath = path.join(cwd, PROBE_FILE);
        fsImpl.writeFileSync(probePath, prompt, { encoding: 'utf8', mode: 0o600 });
        try {
          fsImpl.chmodSync(probePath, 0o600);
        } catch {
          /* Windows ignores the mode bits */
        }
        args = ['run', '--format', 'json', FILE_MESSAGE, '--file', probePath];
      }

      return runSpawnEngine({
        engine: ENGINE,
        binName: deps.binName ?? 'opencode',
        args,
        prompt,
        probe,
        author,
        timeoutMs,
        cwd,
        nonce,
        deps,
      });
    },
  };
}

export default createOpencodeAdapter;
