import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile), image = process.env.PLOW_HOURS_TEST_IMAGE ?? 'ghcr.io/enzotironi/plow-hours:check';
const suffix = randomBytes(6).toString('hex'), upstream = `hours-boundary-${suffix}`, proxy = `${upstream}-proxy`, evaluator = `${upstream}-eval`;
const docker = async (...args) => (await exec('docker', args, { timeout: 30000 })).stdout.trim();
try {
  await docker('run', '-d', '--rm', '--name', upstream, '--network', 'none', '--entrypoint', 'node', image, '-e',
    `require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({user:req.headers['x-plow-user'],forwarded:req.headers['x-forwarded-for']}));}).listen(3000,'127.0.0.1')`);
  await docker('run', '-d', '--rm', '--name', proxy, '--network', `container:${upstream}`, '-v', `${resolve('dev/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    'caddy:2@sha256:14a9c00d4e833ebc2b65d36515b37bde3b73f0b323a2663aaafc88953d8c4e3f');
  await delay(1500);
  const proxyCases = await docker('exec', upstream, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import http from 'node:http';
    const request=(host,origin,path='/hours/data')=>new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:3001,path,headers:{host,...(origin===undefined?{}:{origin}),'x-plow-user':'forged-user','x-forwarded-for':'attacker','x-forwarded-host':'localhost'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end(); });
    let count=0;
    for(const host of ['localhost:3331','LOCALHOST:3331','127.0.0.1:3331']) for(const origin of [undefined,'http://localhost:3331','http://127.0.0.1:3331']) {
      const r=await request(host,origin);assert.equal(r.status,200);const data=JSON.parse(r.body);assert.equal(data.user,'dev-owner');assert.equal(data.forwarded,'192.0.2.1');count++; }
    for(const host of ['rebind.example:3331','localhost.attacker.example:3331','attacker.localhost:3331','2130706433:3331','localhost.:3331']) for(const origin of [undefined,'http://localhost:3331']) { assert.equal((await request(host,origin)).status,403);count++; }
    for(const origin of ['https://attacker.example','null']) { assert.equal((await request('localhost:3331',origin)).status,403);count++; }
    assert.equal((await request('localhost:3331',undefined,'http://rebind.example:3331/hours/data')).status,403);count++;
    console.log(JSON.stringify({proxy_cases:count,passed:true}));`);
  assert.equal(JSON.parse(proxyCases).passed, true); console.log(proxyCases);
  await docker('run', '-d', '--name', evaluator, '-e', 'PLOW_AGENT_TOKEN=fixture-network-only', '-e', 'EVAL_PHASE=network_only', '-e', 'EVAL_OUTPUT=/tmp/hours-network-evidence',
    '-v', `${resolve('evals')}:/evals:ro`, '--entrypoint', 'node', image, '/evals/conversation.mjs');
  for (let i = 0; i < 30; i++) { if ((await docker('logs', evaluator)).includes('EVAL_BOUNDARY_READY')) break; await delay(250); }
  const evaluatorCases = await docker('exec', evaluator, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import {networkInterfaces} from 'node:os';
    const ip=Object.values(networkInterfaces()).flat().find(i=>i.family==='IPv4'&&!i.internal).address;
    const r=await fetch('http://127.0.0.1:49519/v1/agents/me');assert.equal(r.status,200);assert.equal((await r.json()).agent.name,'Ours');
    await assert.rejects(()=>fetch('http://'+ip+':49519/v1/agents/me',{signal:AbortSignal.timeout(2000)}));
    const socket=new WebSocket('ws://127.0.0.1:49519/v1/ws');await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.close();
    const remote=new WebSocket('ws://'+ip+':49519/v1/ws');await new Promise((resolve,reject)=>{remote.addEventListener('error',resolve,{once:true});remote.addEventListener('open',()=>reject(new Error('Network WebSocket accepted')),{once:true});});remote.close();
    console.log(JSON.stringify({evaluator_cases:4,passed:true,model_requests:0}));`);
  assert.equal(JSON.parse(evaluatorCases).passed, true); console.log(evaluatorCases);
} finally {
  for (const name of [proxy, evaluator, upstream]) await docker('rm', '-f', name).catch(() => {});
}
