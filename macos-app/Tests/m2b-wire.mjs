// Native integration uses the real Node normalizers and shared synthetic payloads.
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeCopilotUsage, normalizeZaiQuota, normalizeOpenRouterKey } from '../../core/providers/engine/m2-providers.mjs';
const fixture = name => JSON.parse(readFileSync(new URL('../../test/fixtures/providers/' + name + '.json', import.meta.url)));
const now = 1800000000000;
writeFileSync(process.argv[2], JSON.stringify({now,
  credits: normalizeCopilotUsage(fixture('copilot-synthetic-ai-credits'), now),
  premium: normalizeCopilotUsage(fixture('copilot-synthetic-premium-requests'), now),
  unlimited: normalizeCopilotUsage(fixture('copilot-synthetic-unlimited'), now),
  zai: normalizeZaiQuota(fixture('zai-synthetic-normal'), now),
  router: normalizeOpenRouterKey(fixture('openrouter-synthetic-normal'), now),
  noLimit: normalizeOpenRouterKey(fixture('openrouter-synthetic-no-limit'), now),
}));
