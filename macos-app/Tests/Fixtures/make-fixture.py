#!/usr/bin/env python3
"""Generate synthetic cache/state in an explicit isolated directory; no auth files."""
import json, pathlib, sys, time
root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
now = time.time()
cache = {}
for name, label, used in [('codex','Codex',32),('opencode','OpenCode',17),('kimi','Kimi',93),('commandcode','CmdCode',0)]:
    windows = [{'id':'five-hour','label':'5h窗口','used':used,'remaining':100-used,'limit':100,'unit':'count','resetsAt':int(now)+3600,'primary':True}, {'id':'weekly','label':'周配额','used':68 if name=='kimi' else 19,'limit':100,'unit':'count','resetsAt':int(now)+86400}]
    if name=='opencode': windows.append({'id':'monthly','label':'月配额','used':44,'limit':100,'unit':'percent','resetsAt':int(now)+864000})
    cache[name]={'fetchedAt':int(now*1000),'report':{'name':label,'capturedAt':int(now*1000),'windows':windows,'metrics':[{'label':'Credits','value':'无'}] if name=='codex' else [],'notes':['套餐：fixture，非真实账户']}}
(root/'subs-bar-cache.json').write_text(json.dumps(cache,ensure_ascii=False,indent=2))
(root/'subs-bar-state.json').write_text('{"selected":"kimi"}')
print(root)
