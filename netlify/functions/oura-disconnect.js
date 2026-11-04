// Feel Good — POST /.netlify/functions/oura-disconnect
//
// Called by the client (with the user's Supabase Authorization header) when
// they tap "Disconnect" on the Oura card in the physical health detail page.
// Deletes their row from health_connections via the service-role key (same
// proxy pattern as oura-sync.js / moods.js — see project memory
// "project_feelgood_auth_arch"; health_connections has RLS enabled with no
// policies, so only this service-role path can touch it).
//
// Deliberately does NOT touch health_metrics_daily — past synced days stay
// in history even after disconnecting, same as disconnecting a bank account
// doesn't erase past transactions.

const { verifyUser, AuthError } = require('./lib/verifyUser');

const SUPABASE_URL = 'https://ebcftwjlexfrwarrckjx.supabase.co';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Prefer',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  try {
    const user = await verifyUser(event.headers.authorization);
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/health_connections?user_id=eq.${user.id}&provider=eq.oura`,
      {
        method: 'DELETE',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('oura-disconnect failed:', res.status, text);
      return {
        statusCode: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to disconnect Oura' }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ disconnected: true }),
    };
  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
    console.error('oura-disconnect error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error disconnecting Oura' }) };
  }
};

// Allow calls from the GitHub Pages app (see lib/cors.js)
exports.handler = require('./lib/cors').withCors(exports.handler);
