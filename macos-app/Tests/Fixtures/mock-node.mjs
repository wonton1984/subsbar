#!/usr/bin/env node
// Isolated UI verification bridge. Never use with the real agent directory.
import {readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {join} from 'node:path';
if (process.argv.includes('--version')) { console.log('v22.0.0'); process.exit(0); }
const root = process.env.PI_CODING_AGENT_DIR;
if (!root || !root.includes('SubsBar UI fixtures ') || !process.argv.includes('--refresh')) process.exit(90);
const config = JSON.parse(readFileSync(join(root,'mock-config.json'),'utf8'));
appendFileSync(join(root,'mock-events.jsonl'),JSON.stringify({pid:process.pid,args:process.argv.slice(2),startedAt:Date.now()})+'\n');
if (config.mode==='hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
else setTimeout(()=>{
  if(config.mode==='partial') {
    const cache=JSON.parse(readFileSync(join(root,'subs-bar-cache.json'),'utf8'));
    cache.kimi.fetchedAt=Date.now(); cache.kimi.report.windows[0].used=92; cache.kimi.report.windows[0].remaining=8;
    writeFileSync(join(root,'subs-bar-cache.json'),JSON.stringify(cache));
  }
  process.exit(config.mode==='nonzero'?7:0);
},config.delayMs??15000);
