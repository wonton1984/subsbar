// Shared synthetic payloads -> real Node wire; Swift does not normalize provider data.
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeAntigravityUsage, normalizeDevinQuota, normalizeDevinCliStatus, normalizeGrokBilling } from '../../core/providers/engine/m2-providers.mjs';
const fixture = name => JSON.parse(readFileSync(new URL('../../test/fixtures/providers/' + name + '.json', import.meta.url)));
const now = 1800000000000;
let denied = false;
try { normalizeAntigravityUsage(fixture('antigravity-synthetic-denied'), now); } catch { denied = true; }
writeFileSync(process.argv[2], JSON.stringify({now, denied,
  agyGroups: normalizeAntigravityUsage(fixture('antigravity-synthetic-cli-groups'), now),
  agy: normalizeAntigravityUsage(fixture('antigravity-synthetic-normal'), now),
  devin: normalizeDevinQuota(fixture('devin-synthetic-normal'), now),
  hideDaily: normalizeDevinQuota(fixture('devin-synthetic-hide-daily'), now),
  dailyOnly: normalizeDevinCliStatus({daily:fixture('devin-synthetic-normal').daily}, now),
  grok: normalizeGrokBilling(fixture('grok-synthetic-normal'), now),
  capOnly: normalizeGrokBilling({onDemandCap:2500}, now),
  monthly: normalizeGrokBilling(fixture('grok-synthetic-monthly'), now),
  weekly: normalizeGrokBilling({credits:{creditUsagePercent:10},config:{currentPeriod:{start:'2031-09-01T00:00:00Z',end:'2031-09-08T00:00:00Z'}}},now),
}));
