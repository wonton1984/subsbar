// Synthetic shared payloads only; never resolves signing keys or sends HTTP.
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeOllamaUsage } from '../../core/providers/engine/m2-providers.mjs';
const fixture = name => JSON.parse(readFileSync(new URL('../../test/fixtures/providers/' + name + '.json', import.meta.url)));
const now = 1800000000000;
let missingRejected = false;
try { normalizeOllamaUsage(fixture('ollama-synthetic-missing'), now); } catch { missingRejected = true; }
writeFileSync(process.argv[2], JSON.stringify({now, missingRejected,
  monthly: normalizeOllamaUsage(fixture('ollama-synthetic-normal'), now),
  legacy: normalizeOllamaUsage(fixture('ollama-synthetic-legacy'), now),
  noReset: normalizeOllamaUsage({monthly:{used:7.5,limit:60}}, now),
}));
