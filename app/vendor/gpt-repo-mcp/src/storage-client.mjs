/** Private desktop bridge. No configurable host or credential in tool arguments. */
export async function storageCall(operation, input, options = {}) {
  const base = options.base ?? process.env.SECRET_TUNNEL_STORAGE_URL;
  const token = options.token ?? process.env.SECRET_TUNNEL_STORAGE_TOKEN;
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/?$/u.test(base || '') || !/^[a-f0-9]{64}$/u.test(token || ''))
    throw new Error('Storage desktop bridge is unavailable. Run the updated V3 app and reconnect MCP.');
  if (!['status','list','read','write','copy','job'].includes(operation)) throw new Error('Unsupported storage operation.');
  const response = await (options.fetch ?? globalThis.fetch)(`${base.replace(/\/$/u,'')}/${operation}`, {
    method:'POST', headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify(input), signal:AbortSignal.timeout(120000), redirect:'error',
  });
  let count=0;const chunks=[];
  if(!response.body)throw new Error('Storage bridge returned no body.');
  for await(const chunk of response.body){count+=chunk.length;if(count>2*1024*1024)throw new Error('Storage response exceeded its limit.');chunks.push(chunk);}
  let value;
  try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Storage bridge returned invalid JSON.');}
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Storage bridge returned an invalid result.');
  if(!response.ok || value.error)throw new Error(`${value.error?.code || 'storage_error'}: ${value.error?.message || 'Storage operation failed.'}`);
  return value;
}
