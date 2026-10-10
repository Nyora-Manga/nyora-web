// In-memory, short-lived catalogue tickets. The signing key stays on the server.
const sessions = new Map();
async function ticket(base, signal, refresh = false) {
  if (refresh) sessions.delete(base);
  const cached = sessions.get(base);
  if (cached?.pending) return cached.pending;
  if (cached?.expires > Date.now() + 15_000) return cached.token;
  const pending = (async () => {
    const response = await fetch(base + '/app/session', {method:'POST', cache:'no-store', credentials:'omit', signal});
    if (!response.ok) { const error=new Error('App session HTTP '+response.status); error.helperStatus=response.status; error.nodeFault=response.status>=500; error.response=response; throw error; }
    const data = await response.json();
    if (typeof data.token !== 'string' || !data.token || !(data.expiresIn > 0 && data.expiresIn <= 300)) throw new Error('Invalid app session response');
    sessions.set(base,{token:data.token, expires:Date.now()+data.expiresIn*1000});
    return data.token;
  })();
  sessions.set(base,{pending});
  try { return await pending; } catch(error) { sessions.delete(base); throw error; }
}
export async function catalogueFetch(base, path, init) {
  const send = async refresh => fetch(base+path,{...init,cache:'no-store',credentials:'omit',headers:{...init.headers,Authorization:'Bearer '+await ticket(base,init.signal,refresh)}});
  const response=await send(false);
  return response.status===401 ? send(true) : response;
}
