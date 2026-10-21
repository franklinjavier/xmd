import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { render } from '../src/modes.js';
import { fetchConversation } from '../src/fetch.js';
import { createServer } from '../src/server.js';
const load = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url)));
const conversation = await load('conversation');

test('replies filters descendants, sorts, deduplicates, and collects references', async () => {
 let calls=0;
 const md=await render('10','replies',{fetchConversation:async()=>{calls++; return conversation;},fetchStatus:async()=>assert.fail('status should come from conversation')});
 assert.equal(calls,1);
 assert.ok(md.indexOf('Linked post') < md.indexOf('Earlier descendant'));
 assert.ok(md.indexOf('Earlier descendant') < md.indexOf('Later descendant'));
 assert.doesNotMatch(md,/Ancestor|excluded|javascript:/);
 const [body,refs]=md.split('## References');
 assert.doesNotMatch(body,/<sub>|\[permalink\]|❤️|👁/);
 assert.match(body,/### 1\/3 · Alice Name \(@alice\)/);
 assert.match(body,/https:\/\/example.com\/a%29%20b.jpg/);
 assert.match(body,/> second line/);
 assert.match(refs,/1\. @alice — &lt;https:\/\/x.com\/alice\/status\/10> · ❤️ 5/);
 assert.match(refs,/2\. @bob — &lt;https:\/\/x.com\/bob\/status\/11> · 👁 42/);
 assert.match(refs,/3\. @carol — &lt;https:\/\/x.com\/carol\/status\/12>/);
 assert.match(md,/more replies may exist/);
});

test('replies falls back to status and notes empty replies', async () => {
 let calls=0;
 const md=await render('10','replies',{fetchConversation:async()=>({thread:[],replies:[]}),fetchStatus:async id=>{calls++; assert.equal(id,'10');return conversation.status;}});
 assert.equal(calls,1);
 assert.match(md,/no replies returned/);
 assert.doesNotMatch(md,/more replies may exist/);
 assert.match(md,/1\. @alice/);
});

test('legacy modes retain byte-identical Markdown', async () => {
 const posts=await load('statuses');
 const expected=await load('legacy-markdown');
 const fetcher={fetchStatus:async id=>posts.find(s=>s.id===id),fetchThread:async()=>({thread:posts}),fetchConversation:async()=>({thread:posts})};
 for(const mode of ['post','ancestors','thread']) assert.equal(await render('2',mode,fetcher),expected[mode]);
});

test('HTTP accepts both replies routes and rejects bad modes', async t => {
 const server=createServer((id,mode)=>render(id,mode,{fetchConversation:async()=>conversation}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const path of ['/md?mode=replies&url=10','/md/replies?url=10']) {
  const response=await fetch(base+path);
  assert.equal(response.status,200);
  assert.match(await response.text(),/## References/);
 }
 assert.equal((await fetch(base+'/md?mode=bad&url=10')).status,400);
});

test('live replies conversation', async t => {
 if(process.env.XMD_LIVE!=='1') return t.skip('Set XMD_LIVE=1');
 const id='2110642522355638381';
 const data=await fetchConversation(id);
 assert.equal(data.status.id,id);
 assert.ok(data.replies.length>0);
 const md=await render(id,'replies',{fetchConversation:async()=>data});
 assert.match(md,/## References/);
 assert.match(md,/1\. @jack/);
 assert.ok((md.match(/^### /gm)||[]).length>1);
});
