import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { renderConfig, syncConfig } from '/opt/plow/boot/config.js';
import { probeIdentity } from '/opt/plow/boot/probe-fixture.js';
import { startGateway } from '/opt/plow/boot/process.js';

process.env.PLOW_AGENT_TOKEN='probe-'+randomBytes(16).toString('hex');
process.env.OPENCLAW_GATEWAY_PASSWORD=randomBytes(32).toString('hex');
delete process.env.OPENCLAW_GATEWAY_TOKEN;
await mkdir('/var/lib/plow/workspace',{recursive:true});
await syncConfig(renderConfig(probeIdentity,'http://127.0.0.1:1'),'/var/lib/plow/openclaw.json','/etc/plow/openclaw');
const child=await startGateway(true);
let success=false;
const deadline=setTimeout(()=>{console.error('Plow Hours probe timed out');process.kill(process.pid,'SIGTERM');},120000);
let log='';
let checking=false;
const paths=['','/data','/app.js','/style.css','/plow-logo.svg','/fonts/dm-sans-latin.woff2','/fonts/dm-mono-400-latin.woff2','/fonts/epilogue-latin-500-normal.woff2'];
async function check() {
  const base='http://127.0.0.1:3000/hours';
  for (const path of paths) {
    const response=await fetch(base+path,{signal:AbortSignal.timeout(5000)});
    if (![401,403].includes(response.status)) throw new Error('Anonymous access: '+path+' '+response.status);
  }
  for (const ip of ['203.0.113.7','192.0.2.1']) {
    const headers={'x-plow-user':'mem_probe','x-forwarded-for':ip,'x-forwarded-proto':'https','x-forwarded-host':'probe.example'};
    for (const path of paths) {
      const response=await fetch(base+path,{headers,signal:AbortSignal.timeout(5000)});
      if (response.status!==200) throw new Error('Owner access: '+path+' '+response.status);
      if (path==='/data'&&!Array.isArray((await response.json()).contractors)) throw new Error('Missing timesheet data');
    }
    const response=await fetch(base+'/data',{method:'POST',headers,signal:AbortSignal.timeout(5000)});
    if (response.status!==405) throw new Error('Read-only route: '+response.status);
  }
  for (const user of ['mem_other_owner', 'mem_contractor', 'dev-owner']) {
    const response=await fetch(base+'/data',{headers:{'x-plow-user':user,'x-forwarded-for':'192.0.2.1'},signal:AbortSignal.timeout(5000)});
    if (![401,403].includes(response.status)) throw new Error('Wrong owner allowed: '+response.status);
  }
  success=true;
  console.log('PLOW_HOURS_PROBE_OK');
}
function observe(chunk) {
  process.stdout.write(chunk);
  log+=chunk.toString();
  if (!checking&&log.includes('[gateway] ready')&&log.includes('plow channel registered')) {
    checking=true;
    check().catch(error=>console.error(String(error))).finally(()=>{clearTimeout(deadline);process.kill(process.pid,'SIGTERM');});
  }
}
child.stdout.on('data',observe);
child.stderr.on('data',observe);
child.on('exit',code=>{clearTimeout(deadline);if(!success||code!==0)process.exitCode=1;});
