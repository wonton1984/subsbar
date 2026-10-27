// Synthetic credentials only. Never reads a real database or real Keychain.
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decodeCursorCredential, createCredentialStores, ReaderOutcome } from '../core/credentials/stores.mjs';
import { resolveSource } from '../core/credentials/resolver.mjs';
import { SecretBroker } from '../core/credentials/broker.mjs';

export async function cursorSafeStorageCases(check) {
  const password = 'synthetic-cursor-safe-storage-password';
  const jwt = [ {alg:'HS256',typ:'JWT'}, {sub:'synthetic-cursor-user',exp:1950000000} ]
    .map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).concat('synthetic-signature').join('.');
  const seal = (text, iterations=1003) => {
    const key=pbkdf2Sync(password,'saltysalt',iterations,16,'sha1');
    const cipher=createCipheriv('aes-128-cbc',key,Buffer.alloc(16,32));
    const data=Buffer.concat([Buffer.from('v10'),cipher.update(text),cipher.final()]);key.fill(0);
    return 'cursor-safe-storage:v1:'+data.toString('base64');
  };
  const envelope=seal(jwt);
  let reads=0;
  const read=()=>{reads++;return Buffer.from(password)};
  const plain=decodeCursorCredential(jwt,read);
  check('Cursor plaintext skips Keychain', reads===0 && Buffer.from(plain.bytes).toString()===jwt);
  const decoded=decodeCursorCredential(envelope,read);
  check('Cursor v1/v10 decrypts synthetic JWT', reads===1 && Buffer.from(decoded.bytes).toString()===jwt);
  check('Cursor decrypted JWT retains expiry', JSON.stringify(decoded.expiry)===JSON.stringify(plain.expiry));
  const rejects=(value,keyReader,reason)=>{try{decodeCursorCredential(value,keyReader);return false}catch(e){return e instanceof ReaderOutcome && e.reasonCode===reason && e.message===reason}};
  check('Cursor bad key is safely undecryptable', rejects(envelope,()=>Buffer.from('wrong-synthetic-key'),'credential-undecryptable'));
  check('Cursor Keychain denial is explicit', rejects(envelope,()=>{throw new Error('private exception omitted')},'keychain-access-denied'));
  check('Cursor empty Keychain secret is denied', rejects(envelope,()=>Buffer.alloc(0),'keychain-access-denied'));
  check('Cursor invalid plaintext after decrypt rejected', rejects(seal('not-a-jwt'),read,'credential-undecryptable'));
  check('Cursor malformed JWT JSON rejected', rejects(seal('eA.eA.signature'),read,'credential-undecryptable'));
  check('Cursor Linux iteration count not guessed on macOS', rejects(seal(jwt,1),read,'credential-undecryptable'));
  const before=reads;
  for (const value of ['cursor-safe-storage:v2:AAAA','cursor-safe-storage:v1:!bad!', 'cursor-safe-storage:v1:AAAA', envelope.slice(0,-4)]) {
    check('Cursor malformed/unknown envelope rejected before Keychain', rejects(value,read,'credential-undecryptable'));
  }
  check('Cursor bad envelopes never touch Keychain', reads===before);
  const keyBuffer=Buffer.from(password);decodeCursorCredential(envelope,()=>keyBuffer);
  check('Cursor temporary Keychain password zeroed', keyBuffer.every(b=>b===0));

  if (existsSync('/usr/bin/sqlite3')) {
    const dir=mkdtempSync(join(tmpdir(),'subsbar-cursor-synthetic-'));const path=join(dir,'state.vscdb');
    try {
      execFileSync('/usr/bin/sqlite3',[path,'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);']);
      const put=value=>execFileSync('/usr/bin/sqlite3',[path,`INSERT OR REPLACE INTO ItemTable VALUES ('cursorAuth/accessToken','${value}');`]);
      let keyReads=0;const stores=createCredentialStores({cursorKeyReader:()=>{keyReads++;return Buffer.from(password)}});
      put(envelope);
      check('Cursor discover encrypted DB never reads secret', stores.discover('cursor-state-db',{path}).status==='resolved' && keyReads===0);
      check('Cursor DB reader decrypts instead of returning envelope', Buffer.from(stores.resolve('cursor-state-db',{path}).bytes).toString()===jwt && keyReads===1);
      put(jwt);
      check('Cursor old DB reader remains plaintext compatible', Buffer.from(stores.resolve('cursor-state-db',{path}).bytes).toString()===jwt && keyReads===1);
      put(envelope);
      for (const [keyReader,code,reason] of [
        [()=>{throw new Error('private')},'permission-denied','keychain-access-denied'],
        [()=>Buffer.from('wrong'),'invalid','credential-undecryptable']
      ]) {
        const result=await resolveSource('cursor',{id:'synthetic'}, {id:'synthetic',reader:'cursor-state-db',implementationId:'cursor-state-db',kind:'file',path},
          {stateDir:join(dir,'state'),stores:createCredentialStores({cursorKeyReader:keyReader}),broker:new SecretBroker(),interaction:'user-connect'});
        check('Cursor resolver preserves safe error '+reason,result.status==='failed'&&result.code===code&&result.reasonCode===reason&&!result.lease);
      }
    } finally {rmSync(dir,{recursive:true,force:true})}
  }
  plain.bytes.fill(0);decoded.bytes.fill(0);
}
