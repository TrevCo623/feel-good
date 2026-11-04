// Feel Good — GET /.netlify/functions/oura-auth-start
//
// Called by the client (with the user's Supabase Authorization header) when
// they tap "Connect Oura". Verifies the session, mints a signed state, and
// returns the Oura authorize URL for the client to redirect/open.
//
// Oura OAuth2 authorize endpoint (confirmed against current Oura API v2 docs):
//   GET https://cloud.ouraring.com/oauth/authorize
//     ?response_type=code
//     &client_id=...
//     &redirect_uri=...        (must exactly match the URI registered in the Oura app)
//     &state=...
//     &scope=daily             (space-delimited if more scopes are added later)

const { verifyUser, AuthError } = require('./lib/verifyUser');
const { createState } = require('./lib/ouraState');

const OURA_AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';

// Matches the CORS block in moods.js.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Prefer',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  try {
    const user = await verifyUser(event.headers.authorization);

    const clientId = process.env.OURA_CLIENT_ID;
    const redirectUri = process.env.OURA_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: 'Oura integration is not configured (missing OURA_CLIENT_ID/OURA_REDIRECT_URI)' }),
      };
    }

    const state = createState(user.id);

    const url = new URL(OURA_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'daily');

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.toString() }),
    };
  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
    console.error('oura-auth-start error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error starting Oura connection' }) };
  }
};

// Allow calls from the GitHub Pages app (see lib/cors.js)
exports.handler = require('./lib/cors').withCors(exports.handler);
