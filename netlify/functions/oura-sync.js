// Feel Good — GET /.netlify/functions/oura-sync
//
// Called by the client (with the user's Supabase Authorization header) to
// pull fresh Oura data and cache it in health_metrics_daily. Verifies the
// JWT itself rather than relying on RLS (same proxy pattern as moods.js —
// see project memory "project_feelgood_auth_arch").
//
// IMPORTANT field-source notes (confirmed via current Oura API v2 docs —
// do NOT conflate these, it's an easy mistake):
//   - /v2/usercollection/daily_sleep    → SCORE only (0-100 + contributors).
//     Does NOT contain actual sleep duration.
//   - /v2/usercollection/sleep          → DETAILED sessions, one row per
//     sleep period (naps included). Actual duration lives here:
//     total_sleep_duration (seconds), efficiency (0-100), type
//     ("long_sleep" | "sleep" | "late_nap" | ...). Filter to type ===
//     'long_sleep' to get "last night's sleep" and ignore naps.
//   - /v2/usercollection/daily_readiness → score (0-100) = readiness_score.
//   - /v2/usercollection/daily_activity  → steps, active_calories (today's
//     activity summary; "yesterday's activity" from the check-in's point of
//     view, since Oura finalizes a day's activity data after it ends).
//
// Oura access tokens expire in ~24h. Refresh tokens are SINGLE-USE and
// ROTATE on every refresh — the new refresh_token from the response must be
// persisted immediately, or the next refresh will fail.

const { verifyUser, AuthError } = require('./lib/verifyUser');

const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const OURA_API_BASE = 'https://api.ouraring.com/v2/usercollection';

// Matches moods.js: the project URL is hardcoded there rather than read
// from an env var, so mirroring that here instead of introducing a
// SUPABASE_URL env var the rest of the app doesn't use.
const SUPABASE_URL = 'https://ebcftwjlexfrwarrckjx.supabase.co';

async function supabaseRest(path, { method = 'GET', body, extraHeaders = {} } = {}) {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase REST ${method} ${path} failed: ${res.status} ${text}`);
  }
  // Don't assume only 204 means "no body" — Supabase/PostgREST also returns
  // 201 Created with an EMPTY body for inserts/upserts (this POST included)
  // unless Prefer: return=representation is requested, which we don't need
  // here. Calling res.json() on that empty body throws "Unexpected end of
  // JSON input" — which was silently eating every successful sync (the Oura
  // API calls above this had already succeeded; only this write-back step
  // was broken). Read as text first and only parse if there's something to
  // parse, regardless of status code.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getConnection(userId) {
  const rows = await supabaseRest(
    `/rest/v1/health_connections?user_id=eq.${userId}&provider=eq.oura&select=*`
  );
  return rows && rows[0] ? rows[0] : null;
}

async function refreshOuraToken(connection) {
  const res = await fetch(OURA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: connection.refresh_token,
      client_id: process.env.OURA_CLIENT_ID,
      client_secret: process.env.OURA_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Oura token refresh failed: ${res.status} ${text}`);
  }
  const tokens = await res.json();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Persist the rotated refresh_token immediately — Oura refresh tokens are
  // single-use, so the old one is now dead.
  await supabaseRest(
    `/rest/v1/health_connections?user_id=eq.${connection.user_id}&provider=eq.oura`,
    {
      method: 'PATCH',
      body: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      },
    }
  );

  return { ...connection, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: expiresAt };
}

async function ouraGet(accessToken, endpoint, params) {
  const url = new URL(`${OURA_API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Oura API ${endpoint} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

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

    let connection = await getConnection(user.id);
    if (!connection) {
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connected: false }),
      };
    }

    // From here on, a stored connection exists — `connected` must stay true
    // no matter what happens below. A transient failure pulling fresh data
    // (Oura rate limit, a momentary API error, a brand-new connection with
    // no data yet) is a *sync* failure, not a *connection* failure, and
    // should never flip the client's "Oura connected" status back to false
    // (it was doing exactly that before this fix, via the outer 500 catch).
    try {
      // Refresh if within 5 minutes of expiry (or already expired).
      const expiresAt = new Date(connection.expires_at).getTime();
      if (expiresAt - Date.now() < 5 * 60 * 1000) {
        connection = await refreshOuraToken(connection);
      }

      // Pull a rolling 14-day window — cheap, and self-heals any gaps from
      // missed syncs without needing separate backfill logic.
      // end_date is pushed to TOMORROW: Oura treats end_date as exclusive
      // for the detailed /sleep endpoint, so ending "today" silently drops
      // last night's sleep (which Oura files under today's date).
      const end = new Date();
      end.setDate(end.getDate() + 1);
      const start = new Date();
      start.setDate(start.getDate() - 14);
      const params = { start_date: isoDate(start), end_date: isoDate(end) };

      const [readiness, activity, sleep] = await Promise.all([
        ouraGet(connection.access_token, 'daily_readiness', params),
        ouraGet(connection.access_token, 'daily_activity', params),
        ouraGet(connection.access_token, 'sleep', params),
      ]);

      const readinessByDay = new Map((readiness.data || []).map((r) => [r.day, r]));
      const activityByDay = new Map((activity.data || []).map((r) => [r.day, r]));

      // Detailed sleep is per-session; keep only the main overnight sleep
      // (type === 'long_sleep') and key by its day.
      const sleepByDay = new Map();
      for (const s of sleep.data || []) {
        if (s.type === 'long_sleep') sleepByDay.set(s.day, s);
      }

      const days = new Set([...readinessByDay.keys(), ...activityByDay.keys(), ...sleepByDay.keys()]);

      const rows = [...days].map((day) => {
        const r = readinessByDay.get(day);
        const a = activityByDay.get(day);
        const s = sleepByDay.get(day);
        return {
          user_id: user.id,
          date: day,
          source: 'oura',
          sleep_hours: s ? Math.round((s.total_sleep_duration / 3600) * 100) / 100 : null,
          sleep_efficiency: s ? s.efficiency : null,
          readiness_score: r ? r.score : null,
          steps: a ? a.steps : null,
          active_calories: a ? a.active_calories : null,
          raw: { readiness: r || null, activity: a || null, sleep: s || null },
          synced_at: new Date().toISOString(),
        };
      });

      if (rows.length) {
        await supabaseRest('/rest/v1/health_metrics_daily', {
          method: 'POST',
          body: rows,
          extraHeaders: { Prefer: 'resolution=merge-duplicates' },
        });
      }

      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connected: true, synced_days: rows.length, days: rows }),
      };
    } catch (syncErr) {
      // Log the real reason (check Netlify function logs for "oura-sync
      // sync failed" to see exactly what Oura/Supabase call broke), but
      // still report the connection as live. The client just won't have
      // fresh `days` data this round — it'll pick it up on the next call.
      console.error('oura-sync sync failed (connection still valid):', syncErr);
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connected: true, synced_days: 0, days: [], sync_error: syncErr.message }),
      };
    }
  } catch (err) {
    if (err instanceof AuthError) {
      return { statusCode: err.statusCode, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
    console.error('oura-sync error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error syncing Oura data' }) };
  }
};

// Allow calls from the GitHub Pages app (see lib/cors.js)
exports.handler = require('./lib/cors').withCors(exports.handler);
