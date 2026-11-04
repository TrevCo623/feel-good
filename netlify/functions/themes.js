exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let entries;
  try {
    ({ entries } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  if (!entries || entries.length === 0) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ themes: [] }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: "API key not configured" };
  }

  const journalText = entries
    .map((e, i) => `Entry ${i + 1}:\n${e.text}`)
    .join("\n\n---\n\n");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: `Read these personal journal entries and identify 6-8 meaningful themes the person has been reflecting on. Return ONLY a valid JSON array of short theme labels (2-4 words, title case). Focus on real themes — emotions, relationships, decisions, aspirations — not generic words. Examples of good themes: ["Making Things", "Work Frustration", "Time With Emily", "Feeling Behind", "What I Want"]. Bad examples: ["good", "make", "feels"]. Here are the entries:\n\n${journalText}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    return { statusCode: 502, body: `Anthropic error: ${err}` };
  }

  const data = await response.json();
  const raw = data.content[0].text.trim();

  let themes;
  try {
    // Handle cases where Claude wraps in ```json ... ```
    const match = raw.match(/\[[\s\S]*\]/);
    themes = JSON.parse(match ? match[0] : raw);
  } catch {
    return { statusCode: 500, body: "Failed to parse themes from model response" };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ themes }),
  };
};

// Allow calls from the GitHub Pages app (see lib/cors.js)
exports.handler = require('./lib/cors').withCors(exports.handler);
