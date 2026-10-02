// Drives the OAuth token endpoint over HTTP for verification.
// Subcommands:
//   exchange <base> <code> <verifier> <client_id> <redirect>   -> token JSON
//   refresh  <base> <refresh_token> [scope]                    -> token JSON
//   introspect <base> <secret> <token>                         -> introspection JSON
import process from 'node:process';

const [, , cmd, base, ...rest] = process.argv;

async function postForm(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

if (cmd === 'exchange') {
  const [code, verifier, clientId, redirect] = rest;
  const r = await postForm(`${base}/oauth/token`, {
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect,
  });
  console.log(JSON.stringify(r));
} else if (cmd === 'refresh') {
  const [refresh, scope] = rest;
  const body = { grant_type: 'refresh_token', refresh_token: refresh };
  if (scope) body.scope = scope;
  const r = await postForm(`${base}/oauth/token`, body);
  console.log(JSON.stringify(r));
} else if (cmd === 'introspect') {
  const [secret, token] = rest;
  const r = await postForm(`${base}/oauth/introspect`, { token }, { 'X-Introspection-Secret': secret });
  console.log(JSON.stringify(r));
} else if (cmd === 'revoke') {
  const [token] = rest;
  const r = await postForm(`${base}/oauth/revoke`, { token });
  console.log(JSON.stringify(r));
} else {
  console.log(JSON.stringify({ error: 'unknown command' }));
  process.exit(1);
}
