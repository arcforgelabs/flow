import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import express from 'express';
import inject from 'light-my-request';
import { createAgentGate } from '../server/agents/gate.js';
import { rateLimit } from '../server/rate-limit.js';
import { agentLimits } from '../server/agents/settings.js';
import { createMcpVerifier } from '../server/agents/auth.js';
import { TEST_PUBLISHABLE_KEY } from './support/clerk.js';
import { freshDatabase, skipWithoutDatabase, testDatabaseUrl } from './support/db.js';
import { openDatabase } from '../server/db/index.js';
const resource='https://flow.example.test/mcp';
const quiet={error(){},warn(){}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn) { for(let n=0;n<200;n++) { if(await fn()) return; await sleep(10); } throw new Error('Fixture did not reach boundary'); }
test('limits stay finite and cannot disable or enlarge a hard ceiling',()=>{
  for(const value of [0,-1,Infinity,NaN,1.5,15001]) assert.throws(()=>agentLimits({deadlineMs:value}));
  assert.throws(()=>agentLimits({fleet:4})); assert.throws(()=>agentLimits({unknown:1}));
  assert.equal(agentLimits().deadlineMs,15000);
});
test('production Clerk verifier cancellation terminates bounded workers and permits fresh verification',async()=>{
  const verify=createMcpVerifier({keys:{publishableKey:TEST_PUBLISHABLE_KEY,secretKey:'sk_test_synthetic'},resource});
  for(let round=0;round<2;round++){
    const controller=new AbortController();
    const pending=Array.from({length:3},()=>verify('Bearer oat_synthetic',{signal:controller.signal}));
    assert.equal(await verify('Bearer oat_synthetic',{signal:controller.signal}),null);
    controller.abort();
    assert.deepEqual(await Promise.all(pending),[null,null,null]);
  }
});
describe('agent gate lifecycle and host share',{skip:skipWithoutDatabase},()=>{
  let setup,pool,db,grants,person,org;
  before(async()=>{
    setup=await freshDatabase(); await setup.close();
    db=openDatabase({url:testDatabaseUrl,max:10});pool=db.pool;
    org=(await pool.query("INSERT INTO organisations(name) VALUES ('Synthetic') RETURNING id")).rows[0].id;
    person=(await pool.query("INSERT INTO people(email,role,status,clerk_user_id) VALUES ('gate@example.test','owner','active','user_gate') RETURNING id")).rows[0].id;
    grants=(await pool.query("INSERT INTO agent_grants(person_id,client_id,app_name,resource,organisation_id) SELECT $1,c,'Synthetic',$2,$3 FROM unnest(ARRAY['a','b']) c RETURNING id,client_id",[person,resource,org])).rows;
  });
  after(async()=>db?.close());
  const verify=async token=>token==='invalid'?null:{clientId:token,extra:{userId:'user_gate'}};
  function app(handler,limits={},verifier=verify) {
    const a=express(),gate=createAgentGate({pool,resource,verify:verifier,limits,log:quiet});
    a.post('/',rateLimit({limit:120,windowMs:60000}),gate.handle(handler));return a;
  }
  const call=(a,token='a')=>inject(a,{method:'POST',url:'/',headers:{authorization:token}});
  async function reset(){await until(()=>pool.totalCount===pool.idleCount);await pool.query('UPDATE agent_grants SET paused_at=NULL,failure_count=0,failure_day=NULL');}
  test('the production address ceiling rejects excess invalid tokens before verification',async()=>{
    let verified=0;
    const a=app(async(_req,res)=>res.json({ok:true}),{},async()=>{verified++;return null;});
    for(let n=0;n<120;n++)assert.equal((await call(a,'invalid')).statusCode,401);
    const limited=await call(a,'invalid');assert.equal(limited.statusCode,429);
    assert.equal(limited.json().code,'rate_limited');assert.ok(limited.headers['retry-after']);
    assert.equal(verified,120,'address refusals must not reach verification or database admission');
  });
  test('two per grant, three collectively, and all seven human connections remain available',async()=>{
    let entered=0,release;const held=new Promise(r=>release=r);
    const a=app(async(req,res)=>{entered++;await held;req.agent.check();res.json({ok:true});});
    const first=call(a),second=call(a);await until(()=>entered===2);
    const perGrant=await call(a);assert.equal(perGrant.statusCode,429);assert.equal(perGrant.json().code,'agent_concurrency');
    await until(()=>pool.totalCount===pool.idleCount+2);
    const third=call(a,'b');await until(()=>entered===3);
    const fourth=await call(a,'b');assert.equal(fourth.statusCode,429);assert.equal(fourth.json().code,'agent_capacity');
    const humans=await Promise.all(Array.from({length:7},()=>pool.connect()));
    assert.equal(humans.length,7);assert.equal(pool.totalCount,10);
    for(const c of humans) {assert.equal((await c.query('SELECT 1 AS n')).rows[0].n,1);c.release();}
    release();await Promise.all([first,second,third]);await reset();
  });
  test('15-second verification deadline frees admission and never admits a late identity',async()=>{
    let resolveLate,entered=0;
    const a=app(async(_req,res)=>{entered++;res.json({ok:true});},{},token=>token==='slow'?new Promise(r=>resolveLate=r):verify(token));
    const slow=call(a,'slow');const begin=Date.now();
    assert.equal((await slow).statusCode,408);assert.ok(Date.now()-begin>=14900);
    assert.equal((await call(a)).statusCode,200);
    resolveLate(await verify('a'));await sleep(30);assert.equal(entered,1);await reset();
  });
  test('SQL timeout destroys the leased client, audits 408 and recovers capacity without null-client races',async()=>{
    const a=app(async(req,res)=>{req.agent.record('flow_health_read');await req.agent.client.query('SELECT pg_sleep(3)');req.agent.check();res.json({ok:true});},{deadlineMs:100});
    assert.equal((await call(a)).statusCode,408);
    await until(async()=>Boolean((await pool.query("SELECT 1 FROM agent_audit WHERE tool='flow_health_read' AND status=408")).rowCount));
    const good=app(async(_req,res)=>res.json({ok:true}));assert.equal((await call(good)).statusCode,200);await reset();
  });
  test('blocked acquisition is bounded, retains its lease and rejects after expiry',async()=>{
    const humans=await Promise.all(Array.from({length:10},()=>pool.connect()));
    const a=app(async(_req,res)=>res.json({ok:true}),{deadlineMs:50});
    try {
      const result=await call(a);assert.equal(result.statusCode,408);
      await sleep(1100);
    } finally { for(const c of humans)c.release(); }
    assert.equal((await call(a)).statusCode,200);await reset();
  });
  test('only MCP acquisition times out; ordinary callers keep waiting and late agent slots recover',async()=>{
    const humans=await Promise.all(Array.from({length:10},()=>pool.connect()));
    let entered=0,ordinaryState='waiting',ordinaryClient;
    const a=app(async(_req,res)=>{entered++;res.json({ok:true});});
    const ordinary=pool.connect().then(client=>{ordinaryState='acquired';ordinaryClient=client;},()=>{ordinaryState='failed';});
    try {
      const started=Date.now();
      const results=await Promise.all([call(a),call(a),call(a,'b')]);
      assert.ok(Date.now()-started<2000);
      assert.ok(results.every(result=>result.statusCode===503));
      await sleep(150);
      assert.equal(ordinaryState,'waiting','ordinary pool callers must not inherit the agent one-second timeout');
      assert.equal((await call(a)).json().code,'agent_capacity','late acquisitions retain the bounded three leases');
      assert.equal(entered,0);
    } finally {
      for(const c of humans)c.release();
      await ordinary;ordinaryClient?.release();
    }
    await until(()=>pool.totalCount===pool.idleCount);
    assert.equal((await call(a)).statusCode,200);assert.equal(entered,1);await reset();
  });
  test('library minute/day headers, invalid tokens spend no budget, refusals pause across restart and retention is bounded',async()=>{
    const g=grants.find(x=>x.client_id==='a');
    await pool.query("INSERT INTO agent_audit(grant_id,person_id,tool,status,row_count,duration_ms,created_at) VALUES ($1,$2,'protocol',200,0,1,now()-interval '36 days'),($1,$2,'protocol',200,0,1,now()-interval '34 days')",[g.id,person]);
    const a=app(async(_req,res)=>res.json({ok:true}),{minute:2,day:3});
    for(let n=0;n<4;n++)assert.equal((await call(a,'invalid')).statusCode,401);
    assert.equal((await call(a)).statusCode,200);assert.equal((await call(a)).statusCode,200);
    const limited=await call(a);assert.equal(limited.statusCode,429);assert.match(String(limited.headers.ratelimit),/agent-minute/);assert.ok(limited.headers['ratelimit-policy']);assert.ok(limited.headers['retry-after']);
    for(let n=0;n<19;n++) { await until(()=>pool.totalCount===pool.idleCount); assert.equal((await call(a)).statusCode,429); }
    await until(async()=>Boolean((await pool.query('SELECT paused_at FROM agent_grants WHERE id=$1',[g.id])).rows[0].paused_at));
    const restarted=app(async(_req,res)=>res.json({ok:true}));assert.equal((await call(restarted)).statusCode,403);
    const ages=await pool.query("SELECT count(*)::int n FROM agent_audit WHERE created_at < now()-interval '35 days'");assert.equal(ages.rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM agent_audit WHERE created_at < now()-interval '33 days'")).rows[0].n,1);
    await reset();
    const daily=app(async(_req,res)=>res.json({ok:true}),{minute:10,day:1});
    assert.equal((await call(daily)).statusCode,200);const day=await call(daily);assert.equal(day.statusCode,429);assert.match(String(day.headers.ratelimit),/agent-day/);await reset();
  });
});
