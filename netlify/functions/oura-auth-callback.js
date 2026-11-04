// Feel Good — GET /.netlify/functions/oura-auth-callback
//
// Oura redirects the user's browser here after they approve (or deny)
// access, as a plain GET with ?code=...&state=... (or ?error=...). No
// Authorization header is available at this point — the signed `state`
// (see lib/ouraState.js) is what ties this request back to a Supabase user.
//
// Flow:
//   1. Verify `state` → recover { uid }.
//   2. Exchange `code` for tokens:
//        POST https://api.ouraring.com/oauth/token
//        Content-Type: application/x-www-form-urlencoded
//        grant_type=authorization_code
//        code=...
//        redirect_uri=...       (must match the authorize request exactly)
//        client_id=...
//        client_secret=...
//      Response: { access_token, token_type, expires_in, refresh_token, scope }
//   3. Upsert into health_connections via Supabase service-role REST call
//      (service-role bypasses RLS; health_connections intentionally has no
//      policies — see supabase-schema.sql).
//   4. 302-redirect the browser back into the app with a status flag so the
//      UI can show "Oura connected" / "Oura connection failed".

const { verifyState } = require('./lib/ouraState');

const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';

// Where to send the user back to after connecting. Falls back to the real
// deployed site if APP_RETURN_URL isn't set in Netlify's env vars.
const APP_RETURN_URL = process.env.APP_RETURN_URL || 'https://trevco623.github.io/feel-good/';

function redirect(status, extraParams = {}) {
  const url = new URL(APP_RETURN_URL);
  url.searchParams.set('oura', status);
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
  return {
    statusCode: 302,
    headers: { Location: url.toString() },
    body: '',
  };
}

exports.handler = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  if (error) {
    // User denied access, or Oura reported an error (e.g. access_denied).
    return redirect('error', { reason: error });
  }
  if (!code || !state) {
    return redirect('error', { reason: 'missing_code_or_state' });
  }

  let uid;
  try {
    ({ uid } = verifyState(state));
  } catch (err) {
    console.error('oura-auth-callback state error:', err.message);
    return redirect('error', { reason: 'invalid_state' });
  }

  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  const redirectUri = process.env.OURA_REDIRECT_URI;
  // Matches moods.js: the project URL is hardcoded there rather than read
  // from an env var.
  const supabaseUrl = 'https://ebcftwjlexfrwarrckjx.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!clientId || !clientSecret || !redirectUri || !serviceKey) {
    console.error('oura-auth-callback missing required env vars');
    return redirect('error', { reason: 'server_not_configured' });
  }

  try {
    // ---- Exchange code for tokens ----
    const tokenRes = await fetch(OURA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => '');
      console.error('oura-auth-callback token exchange failed:', tokenRes.status, errBody);
      return redirect('error', { reason: 'token_exchange_failed' });
    }

    const tokens = await tokenRes.json();
    // { access_token, token_type, expires_in, refresh_token, scope }
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // ---- Upsert into health_connections (service-role, bypasses RLS) ----
    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/health_connections`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify([
        {
          user_id: uid,
          provider: 'oura',
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: expiresAt,
          scope: tokens.scope || 'daily',
          updated_at: new Date().toISOString(),
        },
      ]),
    });

    if (!upsertRes.ok) {
      const errBody = await upsertRes.text().catch(() => '');
      console.error('oura-auth-callback Supabase upsert failed:', upsertRes.status, errBody);
      return redirect('error', { reason: 'storage_failed' });
    }

    return redirect('connected');
  } catch (err) {
    console.error('oura-auth-callback error:', err);
    return redirect('error', { reason: 'unexpected_error' });
  }
};
