// Feel Good — shared JWT verification helper for Oura integration functions.
// Mirrors the pattern already used in netlify/functions/moods.js (verified
// directly against that file): call GET {SUPABASE_URL}/auth/v1/user with the
// user's bearer token, using the service-role key as the `apikey` header
// (this app has no anon key). SUPABASE_URL is hardcoded, matching moods.js —
// there is no SUPABASE_URL env var anywhere in this app.

const SUPABASE_URL = 'https://ebcftwjlexfrwarrckjx.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

class AuthError extends Error {
  constructor(message, statusCode = 401) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

async function verifyUser(authorizationHeader) {
  if (!authorizationHeader) throw new AuthError('Missing Authorization header');
  if (!SERVICE_KEY) throw new AuthError('SUPABASE_SERVICE_KEY is not configured', 500);

  const token = authorizationHeader.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length)
    : authorizationHeader;
  if (!token) throw new AuthError('Empty bearer token');

  // moods.js passes the service key (not an anon key) as `apikey` on this call
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_KEY },
  });
  if (!res.ok) throw new AuthError('Invalid or expired session', 401);

  const user = await res.json();
  if (!user || !user.id) throw new AuthError('Could not resolve user from token', 401);
  return user;
}

module.exports = { verifyUser, AuthError };
