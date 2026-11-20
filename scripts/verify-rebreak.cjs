// Read-only integration check: all edits are LSP overlays; ReBreak files are never written.
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(process.argv[2]||'../ReBreak/frontend');
const binary=path.resolve(process.argv[3]||'target/release/crossbreeze.exe');
const child=spawn(binary,[],{env:{...process.env,CROSSBREEZE_TRACE:'1'}});
let buffer=Buffer.alloc(0),id=0;const pending=new Map(),notifications=[],waiters=[];
let stderr='';child.stderr.on('data',d=>{stderr+=d});
child.stdout.on('data',d=>{buffer=Buffer.concat([buffer,d]);for(;;){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const size=+buffer.subarray(0,end).toString().match(/Content-Length: (\d+)/i)[1];if(buffer.length<end+4+size)return;const v=JSON.parse(buffer.subarray(end+4,end+4+size));buffer=buffer.subarray(end+4+size);if(pending.has(v.id)){pending.get(v.id)(v);pending.delete(v.id)}else{notifications.push(v);for(const wake of waiters.splice(0))wake()}}});
function send(method,params,request=true){const v={jsonrpc:'2.0',method,params};if(request)v.id=++id;const b=Buffer.from(JSON.stringify(v));const promise=request?new Promise(r=>pending.set(v.id,r)):undefined;child.stdin.write(`Content-Length: ${b.length}\r\n\r\n`);child.stdin.write(b);return promise;}
async function request(method,params){const v=await send(method,params);assert(!v.error,JSON.stringify(v));return v.result;}
async function diagnostic(uri,version){for(;;){const found=notifications.find(v=>v.method==='textDocument/publishDiagnostics'&&v.params.uri===uri&&v.params.version===version);if(found)return found.params.diagnostics;await new Promise(r=>waiters.push(r))}}
const timer=setTimeout(()=>{console.error('Integration check timed out',stderr);child.kill();process.exitCode=1},30000);
(async()=>{try{
const init=await request('initialize',{rootUri:pathToFileURL(root).href,capabilities:{}});
const cssPath=path.join(root,'src/pages/Dashboard/Dashboard.xcss'),tsPath=path.join(root,'src/pages/Dashboard/Dashboard.tsx');
const css=fs.readFileSync(cssPath,'utf8'),ts=fs.readFileSync(tsPath,'utf8'),cssUri=pathToFileURL(cssPath).href,tsUri=pathToFileURL(tsPath).href;
for(const [uri,text,languageId] of [[cssUri,css,'xcss'],[tsUri,ts,'typescriptreact']])send('textDocument/didOpen',{textDocument:{uri,text,languageId,version:1}},false);
assert((await diagnostic(cssUri,1)).some(d=>d.source==='CSS'&&d.message.includes('sdsdf')));
assert((await diagnostic(tsUri,1)).some(d=>d.code==='XC-008'),'Missing ReBreak angle-to-length error');
const legend=init.capabilities.semanticTokensProvider.legend.tokenTypes;
const cssTokens=await request('textDocument/semanticTokens/full',{textDocument:{uri:cssUri}});assert(cssTokens.data.length>0);
const tsTokens=await request('textDocument/semanticTokens/full',{textDocument:{uri:tsUri}});const types=new Set(tsTokens.data.filter((_,i)=>i%5===3).map(i=>legend[i]));for(const type of ['xcssImport','xcssClassMember','xcssProvidedVariable'])assert(types.has(type),`Missing ${type}`);
const warm=[];for(let i=0;i<20;i++){const start=performance.now();await request('textDocument/semanticTokens/full',{textDocument:{uri:tsUri}});warm.push(performance.now()-start)}
const fixed=ts.replace(/\bdeg\b/g,'px');let start=performance.now();send('textDocument/didChange',{textDocument:{uri:tsUri,version:2},contentChanges:[{text:fixed}]},false);assert(!(await diagnostic(tsUri,2)).some(d=>d.code==='XC-008'));const diagnosticMs=performance.now()-start;
send('textDocument/didChange',{textDocument:{uri:tsUri,version:3},contentChanges:[{text:fixed.replace('styles.dashboard','styles.missing')}]},false);assert((await diagnostic(tsUri,3)).some(d=>d.code==='XC-001'));
// Typing bursts must publish only the current state and leave the protocol responsive.
for(let v=4;v<=15;v++)send('textDocument/didChange',{textDocument:{uri:tsUri,version:v},contentChanges:[{text:v===15?fixed:ts}]},false);
assert(!(await diagnostic(tsUri,15)).some(d=>d.code==='XC-008'));
send('textDocument/didChange',{textDocument:{uri:cssUri,version:2},contentChanges:[{text:css+'\nbogus;'}]},false);assert((await diagnostic(cssUri,2)).some(d=>d.code==='XC-105'));
send('textDocument/didChange',{textDocument:{uri:cssUri,version:3},contentChanges:[{text:css}]},false);assert(!(await diagnostic(cssUri,3)).some(d=>d.code==='XC-105'));
warm.sort((a,b)=>a-b);console.log(JSON.stringify({root,binary,checks:'CSS and XCSS diagnostics, TS type checking, fixes, rapid edits, semantic token types',semanticP95Ms:warm[18],warmDiagnosticMs:diagnosticMs},null,2));console.log(stderr);
await request('shutdown',{});send('exit',{},false);
}catch(e){console.error(e,stderr);child.kill();process.exitCode=1}finally{clearTimeout(timer)}})();
