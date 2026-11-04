// Feel Good — CORS wrapper for functions called from the app.
// The app now lives on GitHub Pages (a different site from these functions),
// so the browser needs these headers to allow the calls.
const ALLOWED_ORIGINS = [
  'https://trevco623.github.io',
  'https://feelgoodtrev.netlify.app',
  'https://feelgoodapp.netlify.app',
];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Prefer',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Vary': 'Origin',
  };
}

function withCors(handler) {
  return async (event, context) => {
    const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
    const cors = corsHeaders(origin);
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
    const res = (await handler(event, context)) || { statusCode: 204, body: '' };
    return { ...res, headers: { ...(res.headers || {}), ...cors } };
  };
}

module.exports = { withCors };
