import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueFetch } from '../web/core/app-session.js';

test('catalogue requests share a short-lived ticket and renew once on expiry', async () => {
  let issued=0,expired=false;const calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/app/session'))return Response.json({token:'ticket-'+(++issued),expiresIn:300});
    assert.equal(init.cache,'no-store');assert.equal(init.credentials,'omit');
    if(expired && init.headers.Authorization==='Bearer ticket-1')return new Response('',{status:401});
    return Response.json({entries:[]});
  };
  await Promise.all([1,2,3].map(()=>catalogueFetch('https://helper.test','/sources/catalog',{headers:{Accept:'application/json'}})));
  assert.equal(issued,1);
  assert(calls.filter(c=>c.url.endsWith('/sources/catalog')).every(c=>c.init.headers.Authorization==='Bearer ticket-1'));
  expired=true;assert.equal((await catalogueFetch('https://helper.test','/sources/catalog',{})).status,200);assert.equal(issued,2);
});
test('rate limiting is surfaced without repeatedly minting tickets', async()=>{
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('{"error":"Too many requests"}',{status:429,headers:{'Retry-After':'300'}});};
  await assert.rejects(catalogueFetch('https://limited.test','/sources/catalog',{}),e=>e.helperStatus===429);
  assert.equal(calls,1);
});
