// Secure proxy for the moods table.
// Verifies the user's JWT server-side, then queries Supabase with the
// service role key — so RLS enforcement happens here, not in PostgREST.
// The service role key never reaches the browser.

const SUPABASE_URL = 'https://ebcftwjlexfrwarrckjx.supabase.co';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Prefer',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Service key not configured' }) };
  }

  // ── 1. Verify the caller's JWT ────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!jwt) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing token' }) };
  }

  let userId;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': SERVICE_KEY },
    });
    if (!userRes.ok) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }
    const userData = await userRes.json();
    userId = userData.id;
  } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Auth check failed' }) };
  }

  if (!userId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Could not identify user' }) };
  }

  // ── 2. Build the Supabase request ─────────────────────────────────────
  const method = event.httpMethod;
  const qp = { ...(event.queryStringParameters || {}) };

  // GET requests are always scoped to this user
  if (method === 'GET') qp['user_id'] = `eq.${userId}`;

  const qs = new URLSearchParams(qp).toString();
  const targetUrl = `${SUPABASE_URL}/rest/v1/moods${qs ? '?' + qs : ''}`;

  const reqHeaders = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const prefer = event.headers['prefer'] || event.headers['Prefer'];
  if (prefer) reqHeaders['Prefer'] = prefer;

  // Mutations: inject user_id into the body so rows are always owned
  let body;
  if (event.body && (method === 'POST' || method === 'PATCH')) {
    try {
      const parsed = JSON.parse(event.body);
      const withUser = Array.isArray(parsed)
        ? parsed.map(r => ({ ...r, user_id: userId }))
        : { ...parsed, user_id: userId };
      body = JSON.stringify(withUser);
    } catch {
      body = event.body;
    }
  }

  // ── 3. Forward to Supabase and relay the response ─────────────────────
  try {
    const supaRes = await fetch(targetUrl, { method, headers: reqHeaders, body });
    const resBody = await supaRes.text();
    return {
      statusCode: supaRes.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: resBody,
    };
  } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase request failed' }) };
  }
};

// Allow calls from the GitHub Pages app (see lib/cors.js)
exports.handler = require('./lib/cors').withCors(exports.handler);
