import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseUrl } from '../src/parse-url.js';
import { formatPost } from '../src/format.js';
import { render } from '../src/modes.js';
import { NotFoundError, NetworkError, fetchStatus } from '../src/fetch.js';
import { createServer } from '../src/server.js';
const statuses = JSON.parse(await readFile(new URL('./fixtures/statuses.json', import.meta.url)));
const fake = { fetchStatus: async id => { const s = statuses.find(s => s.id === id); if (!s) throw new NotFoundError(); return s; }, fetchThread: async () => ({ thread: [statuses[3], statuses[1], statuses[0], statuses[2], statuses[1]] }) };
test('parse supported URL forms', () => {
 for (const host of ['x.com','twitter.com','mobile.twitter.com','www.x.com','fxtwitter.com','vxtwitter.com','fixupx.com','fixvx.com']) {
  assert.deepEqual(parseUrl(`https://${host}/jack/status/123/photo/1?foo=bar#hash`), {id:'123',user:'jack'});
 }
 assert.deepEqual(parseUrl('123'), {id:'123',user:null});
 assert.deepEqual(parseUrl('/jack/statuses/123'), {id:'123',user:'jack'});
 assert.deepEqual(parseUrl('x.com/i/web/status/123'), {id:'123',user:null});
 for (const input of ['',null,'https://evil.com/a/status/1','x.com/jack','abc','ftp://x.com/a/status/1','https://x.com/a/status/no','https://x.com@evil.com/a/status/1','https://x.com/a/status/1/garbage']) assert.throws(() => parseUrl(input));
});
test('format long text, media, UTC, metrics, and one-level quote', () => {
 const md = formatPost(statuses[1]);
 assert.match(md,/A longer note\nwith a second line/);
 assert.match(md,/- \[photo\]\(https:\/\/example.com\/photo.jpg\)/);
 assert.match(md,/\[video\]\(https:\/\/example.com\/best.mp4\)/);
 assert.match(md,/> second line/);
 assert.doesNotMatch(md,/Do not render|<sub>/);
 assert.match(formatPost(statuses[0]), /2026-10-14 17:23 UTC/);
 assert.match(formatPost(statuses[0]), /❤️ 0 · 👁 12/);
 assert.doesNotThrow(() => formatPost({id:'5'}));
});
test('ancestors root-first and missing-parent note', async () => {
 const md = await render('3','ancestors',fake);
 assert.ok(md.indexOf('Root') < md.indexOf('A longer note'));
 assert.ok(md.indexOf('A longer note') < md.indexOf('Other reply'));
 assert.match(md,/## Reply chain \(3 posts\)/);
 const missing = await render('1','ancestors',{fetchStatus: async id => { if(id === '99') throw new NotFoundError(); return {...statuses[0],replying_to:{status:'99'}}; }});
 assert.ok(missing.startsWith('_(parent 99 unavailable)_'));
});
test('thread filters authors, deduplicates, checks connectivity, and notes input author', async () => {
 const md = await render('3','thread',fake);
 assert.match(md,/## Thread by @alice/);
 assert.match(md,/input was by @bob/);
 assert.doesNotMatch(md,/Other reply|Alice replying via Bob/);
 assert.equal((md.match(/\[permalink\]/g)||[]).length,2);
 assert.ok(md.indexOf('Root') < md.indexOf('A longer note'));
});
test('HTTP routes, cache and errors', async t => {
 let calls=0;
 const server=createServer(async id => { calls++; if(id==='404') throw new NotFoundError('missing'); if(id==='502') throw new NetworkError('upstream'); return 'markdown'; });
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 t.after(() => new Promise(resolve => server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal(await (await fetch(base+'/health')).text(),'ok');
 for (const path of ['/md?url=1','/md/post?url=1']) { const r=await fetch(base+path); assert.equal(r.status,200); assert.match(r.headers.get('content-type'),/text\/markdown/); }
 assert.equal(calls,1);
 for(const [path,code] of [['/md?url=bad',400],['/md/no?url=1',400],['/md?url=404',404],['/md?url=502',502],['/other',404]]) assert.equal((await fetch(base+path)).status,code);
 assert.equal((await fetch(base+'/md',{method:'POST'})).status,405);
});
test('live FxTwitter post', async t => {
 if(process.env.XMD_SKIP_LIVE==='1') return t.skip('XMD_SKIP_LIVE=1');
 let status;
 try { status=await fetchStatus('2110421175528775685'); } catch(error) { return t.skip(`API unavailable: ${error.message}`); }
 assert.equal(status.id,'2110421175528775685');
 assert.equal(status.author.screen_name,'jack');
});

test('id length cap applies to bare IDs, URLs, and API requests', async () => {
 assert.equal(parseUrl('1'.repeat(25)).id.length,25);
 for (const input of ['1'.repeat(26), `x.com/a/status/${'1'.repeat(26)}`]) assert.throws(() => parseUrl(input));
 await assert.rejects(fetchStatus('../bad'), NotFoundError);
});

test('wildcard hosts are refused after normalization', async () => {
 const { normalizeHost } = await import('../src/server.js');
 for (const host of ['0.0.0.0','::','[::]','::0','[::0]','0:0:0:0:0:0:0:0','::ffff:0.0.0.0','[::ffff:0.0.0.0]','::ffff:0:0']) assert.throws(() => normalizeHost(host),host);
 assert.equal(normalizeHost('127.0.0.1'),'127.0.0.1');
 assert.equal(normalizeHost('[::1]'),'::1');
});

test('metadata and link destinations are sanitized', () => {
 const md=formatPost({id:'1',author:{name:'[Bad]\n# heading',screen_name:'a)\n[evil]'},media:{photos:[{url:'javascript:alert(1)'},{url:'https://example.com/a) b\\c'}]},quote:{author:{name:'[Q]\nname'},text:'hello',url:'data:text/html,boom'}});
 assert.match(md,/Bad heading/);
 assert.doesNotMatch(md,/javascript:|data:|\n# heading|\[Bad\]/);
 assert.match(md,/https:\/\/example.com\/a%29%20b%5Cc/);
 assert.match(md,/https:\/\/x.com\/aevil\/status\/1/);
});

test('thread falls back by author and excludes missing authors', async () => {
 const root={id:'1',author:{screen_name:'alice'},replying_to:null};
 const child={id:'2',text:'continuation',author:{screen_name:'alice'},replying_to:{status:'1'}};
 let conversations=0;
 const fetcher={fetchStatus:async()=>root,fetchThread:async()=>({thread:[root,{id:'3',author:{screen_name:'bob'},replying_to:{status:'1'}}]}),fetchConversation:async()=>{conversations++;return {thread:[child,{id:'4',text:'authorless',replying_to:{status:'1'}}],replies:[{...child,id:'5',text:'private reply list'}]};}};
 const md=await render('1','thread',fetcher);
 assert.equal(conversations,1);
 assert.match(md,/continuation/);
 assert.doesNotMatch(md,/authorless|private reply list/);
 await assert.rejects(render('1','thread',{...fetcher,fetchStatus:async()=>({...root,author:{}})}),NetworkError);
});

test('ancestor walk notes malformed parents and cycles', async () => {
 for (const [parent,note] of [['bad','malformed parent'],['1','cycle']]) {
  const md=await render('1','ancestors',{fetchStatus:async()=>({id:'1',replying_to:{status:parent}})});
  assert.match(md,new RegExp(note));
 }
});

test('server coalesces renders and returns 504 on deadline', async t => {
 let calls=0;
 const server=createServer(async id=>{calls++; if(id==='2') return new Promise(()=>{}); await new Promise(r=>setTimeout(r,20)); return 'shared';},{deadlineMs:100});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const responses=await Promise.all([fetch(base+'/md?url=1'),fetch(base+'/md?url=1')]);
 assert.deepEqual(await Promise.all(responses.map(r=>r.text())),['shared','shared']);
 assert.equal(calls,1);
 assert.equal((await fetch(base+'/md?url=2')).status,504);
});

test('API rejects redirects, oversized bodies, and maps upstream 400', async t => {
 const original=globalThis.fetch;
 t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async (_url,options)=>{
  assert.equal(options.redirect,'manual');
  assert.equal(options.headers['User-Agent'],'xmd/0.3 (+https://github.com/franklinjavier/xmd)');
  return new Response('',{status:400});
 };
 await assert.rejects(fetchStatus('1'),NotFoundError);
 globalThis.fetch=async()=>new Response('',{status:302,headers:{Location:'https://evil.example/'}});
 await assert.rejects(fetchStatus('1'),error=>{ assert.ok(error instanceof NetworkError); assert.equal(error.message,'Upstream redirect refused'); return true; });
 globalThis.fetch=async()=>({status:0,type:'opaqueredirect',ok:false,body:null});
 await assert.rejects(fetchStatus('1'),error=>{ assert.ok(error instanceof NetworkError); assert.equal(error.message,'Upstream redirect refused'); return true; });
 globalThis.fetch=async()=>new Response('x'.repeat(2*1024*1024+1));
 await assert.rejects(fetchStatus('1'),/exceeds 2 MB/);
 globalThis.fetch=async()=>new Response(JSON.stringify({code:400}));
 await assert.rejects(fetchStatus('1'),NotFoundError);
});
