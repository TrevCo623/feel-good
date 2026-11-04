// Feel Good — signed OAuth `state` param for the Oura connect flow.
//
// Oura's redirect back to oura-auth-callback.js is a plain top-level browser
// GET with no Authorization header, so there's no direct way to know which
// Supabase user initiated the connection. Instead, oura-auth-start.js mints
// a `state` value that's HMAC-signed with a server-only secret and encodes
// the user id + an expiry; oura-auth-callback.js verifies the signature and
// expiry before trusting the embedded user id.
//
// No new dependency — uses Node's built-in `crypto`.

const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getSecret() {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error('OAUTH_STATE_SECRET is not configured');
  return secret;
}

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

function createState(uid, ttlMs = DEFAULT_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const payload = `${uid}.${exp}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyState(state) {
  const decoded = Buffer.from(state, 'base64url').toString('utf8');
  const parts = decoded.split('.');
  if (parts.length !== 3) throw new Error('Malformed state');
  const [uid, expStr, sig] = parts;
  const payload = `${uid}.${expStr}`;
  const expectedSig = sign(payload);

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid state signature');
  }

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) throw new Error('State expired');

  return { uid };
}

module.exports = { createState, verifyState };
