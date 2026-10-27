import { readFileSync } from 'node:fs';
import { fetchDevinQuota, normalizeDevinQuota, selectDevinOrganization } from '../core/providers/engine/m2-providers.mjs';
import { fetchJson } from '../core/providers/engine/engine.mjs';
export async function devinOrgCases(check) {
  const payload=JSON.parse(readFileSync(new URL('./fixtures/providers/devin-synthetic-flat.json',import.meta.url)));
  const now=1950000000000;
  const report=normalizeDevinQuota(payload,now);
  check('Devin flat daily/weekly used and primary',report.windows.length===2 && report.windows[0].used===27 && report.windows[1].used===63 && report.primaryMetricId==='devin-daily');
  check('Devin timezone reset milliseconds',report.windows[0].period.resetsAtMs===Date.parse(payload.daily_reset_at) && report.windows[1].period.resetsAtMs===Date.parse(payload.weekly_reset_at));
  check('Devin overage diagnostic without invented currency',report.diagnostics.some(d=>d.code==='overage-available') && report.metrics.length===0);
  check('Devin verified org not pending',!report.diagnostics.some(d=>d.code==='pending-verification'));
  const hidden=normalizeDevinQuota({...payload,hide_daily_quota:true},now);
  check('Devin hidden daily makes weekly primary',hidden.windows.length===1 && hidden.primaryMetricId==='devin-weekly');
  const boundary=normalizeDevinQuota({...payload,daily_percentage:0,weekly_percentage:100,overage_balance:0},now);
  check('Devin 0 and 100 preserved',boundary.windows[0].used===0 && boundary.windows[1].used===100 && !boundary.diagnostics.some(d=>d.code==='overage-available'));
  const missing=normalizeDevinQuota({...payload,daily_percentage:null,daily:{usedPercent:90},weekly_reset_at:null},now);
  check('Devin flat null does not revive old nested daily',missing.windows.length===1 && missing.windows[0].id==='devin-weekly' && missing.windows[0].period.resetState==='unknown');
  check('Devin explicit primary preferred',selectDevinOrganization([{org_id:'first'},{org_id:'primary',is_primary_org:true}]).id==='primary');
  check('Devin one non-primary org unambiguous',!selectDevinOrganization([{org_id:'only',is_primary_org:false}]).ambiguous);
  check('Devin multiple no primary flagged',selectDevinOrganization([{org_id:'first'},{org_id:'second'}]).ambiguous);
  check('Devin multiple primary flagged',selectDevinOrganization([{org_id:'first',is_primary_org:true},{org_id:'second',is_primary_org:true}]).ambiguous);
  for(const bad of [[],{organizations:[{org_id:'other'}]},[{org_id:'../invalid'}]]) {
    let threw=false;try{selectDevinOrganization(bad)}catch{threw=true}check('Devin invalid org list rejected',threw);
  }
  const original=globalThis.fetch;
  const token='synthetic-devin-key';
  let calls=[];
  const install=(organizations,quotaStatus=200,orgStatus=200)=>{
    calls=[];
    globalThis.fetch=async(url,options)=>{
      calls.push({url,options});
      const org=url.endsWith('/api/organizations');
      return new Response(JSON.stringify(org?organizations:quotaStatus===200?payload:{error:'synthetic failure'}),{status:org?orgStatus:quotaStatus});
    };
  };
  try {
    install([{org_id:'first'},{org_id:'primary',is_primary_org:true}]);
    const fetched=await fetchDevinQuota(token,{dataSourceId:'devin-web-org'});
    check('Devin discover org then quota',calls.length===2 && calls[1].url==='https://app.devin.ai/api/primary/billing/quota/usage' && fetched.windows.length===2);
    check('Devin same bearer, fixed org header and GET',calls.every(c=>c.options.headers.Authorization===`Bearer ${token}` && c.options.method==='GET') && calls[1].options.headers['x-cog-org-id']==='primary');
    install([{org_id:'first'},{org_id:'second'}]);
    const ambiguous=await fetchDevinQuota(token,{dataSourceId:'devin-web-org'});
    check('Devin ambiguous first org visible diagnostic',calls[1].options.headers['x-cog-org-id']==='first' && ambiguous.diagnostics.some(d=>d.code==='org-selection-ambiguous'));
    install([]);
    await fetchDevinQuota(token,{dataSourceId:'devin-web-org',organizationId:'configured'});
    check('Devin explicit org skips discovery',calls.length===1 && calls[0].url.includes('/configured/'));
    for(const status of [401,403]) {
      install([{org_id:'first'},{org_id:'second'}],status);
      let caught;try{await fetchDevinQuota(token,{dataSourceId:'devin-web-org'})}catch(e){caught=e.httpStatus}
      check('Devin quota failure never falls back '+status,caught===status && calls.length===2);
    }
    install([],200,403);
    let denied;try{await fetchDevinQuota(token,{dataSourceId:'devin-web-org'})}catch(e){denied=e.httpStatus}
    check('Devin discovery denial stops before quota',denied===403 && calls.length===1);
    install([]);
    let rejected=false;try{await fetchJson({url:'https://app.devin.ai/api/organizations',description:'synthetic',secrets:[]})}catch{rejected=true}
    check('Generic fetch still rejects arrays unless opted in',rejected);
  } finally {globalThis.fetch=original}
}
