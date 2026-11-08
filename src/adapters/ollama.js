import { buildPrompt } from '../probes.js';
import { errorDictamen, extractJurorJson } from '../verdict.js';
import { redactText } from '../shield.js';

export const ENGINE = 'ollama';
export const DEFAULT_BASE_URL = 'http://localhost:11434';
export const DEFAULT_MODEL = 'llama3.1';

/** Local HTTP only: no shell, no interactive `ollama run`, native fetch. */
export function createOllamaAdapter(deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    engine: ENGINE,
    async run({ spec, diffRedacted, probe, author = '', timeoutMs = 120_000, nonce = '' } = {}) {
      const prompt = buildPrompt({ spec, diffRedacted, probe, nonce });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: deps.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_MODEL,
            prompt,
            stream: false,
            format: 'json',
            options: { temperature: 0 },
          }),
          signal: controller.signal,
        });

        if (response?.ok === false) {
          return errorDictamen({ engine: ENGINE, probe, author, reason: `http_${response.status}` });
        }

        const payload = await response.json();
        const raw = JSON.stringify(payload ?? {});
        const parsed = extractJurorJson(raw, ENGINE) ?? extractJurorJson(raw, 'unknown');
        if (!parsed) {
          return errorDictamen({ engine: ENGINE, probe, author, reason: 'no_json_verdict' });
        }
        return {
          juror: { engine: ENGINE, probe, author },
          verdict: parsed.verdict,
          severity: parsed.severity,
          findings: parsed.findings,
          summary: parsed.summary,
        };
      } catch (error) {
        const aborted = error?.name === 'AbortError';
        return errorDictamen({
          engine: ENGINE,
          probe,
          author,
          reason: aborted
            ? `timeout after ${timeoutMs}ms`
            : redactText(String(error?.message ?? error)).slice(0, 200),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export default createOllamaAdapter;
