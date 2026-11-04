exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: "API key not configured" };

  let type, data;
  try {
    ({ type, data } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // What the person told us in the intro quiz (Settings). Shared by the
  // mantra, 3-day insight (+ its journal prompt) and profile synopsis.
  const list = (a) => (Array.isArray(a) ? a : a ? [a] : []).filter(Boolean);
  const aboutYou = (about = {}) => {
    const lines = [];
    if (list(about.traits).length) lines.push(`What they love about themselves: ${list(about.traits).join('; ')}`);
    if (list(about.insecurities).length) lines.push(`What they're afraid of / insecure about: ${list(about.insecurities).join('; ')}`);
    if (list(about.feelGood).length) lines.push(`What genuinely makes them feel good: ${list(about.feelGood).join('; ')}`);
    if (list(about.feelBad).length) lines.push(`What tends to bring them down: ${list(about.feelBad).join('; ')}`);
    if (list(about.supportStyle).length) lines.push(`On a hard day, what they need most: ${list(about.supportStyle).join('; ')}`);
    if (list(about.primaryGoal).length) lines.push(`What they want this app to help with: ${list(about.primaryGoal).join('; ')}`);
    return lines.length ? `About them, in their own words:\n${lines.map(l => `- ${l}`).join('\n')}` : '';
  };
  // Tone guidance from "what do you need most on a hard day".
  const toneFor = (about = {}) => {
    const s = list(about.supportStyle).join(' ').toLowerCase();
    const t = [];
    if (s.includes('reassurance')) t.push('be warm and encouraging');
    if (s.includes('space')) t.push("don't push advice or fixes — let feelings be what they are");
    if (s.includes('distraction')) t.push('keep it light and forward-looking rather than dwelling');
    if (s.includes('someone to talk')) t.push('write like a close friend who is really listening');
    if (s.includes('push')) t.push('a gentle nudge toward one small action is welcome');
    return t.length ? `Tone: ${t.join('; ')}.` : '';
  };

  const prompts = {
    affirmation: ({ traits = [], journalThemes = [], moodTrend = '', about = {} }) => `
Write ONE daily mantra for this person — a short phrase they can repeat to themselves through the day to steady or focus them. Roughly 3–10 words, one line, easy to remember and say. Grounded and real — not generic, not cheesy, no clichés.

Draw on their strengths as the foundation: ${list(traits).join(", ") || "not shared yet"}.
Use their emotional context to inform the tone — if they're struggling, lean into resilience; if they're doing well, lean into momentum. Where it fits, speak to what actually weighs on them (without naming the fear itself) or to what they said makes them feel good.
Recent mood context: ${moodTrend || "no recent data"}
Themes they've been reflecting on: ${list(journalThemes).slice(0, 5).join(", ") || "none yet"}
${aboutYou(about)}
${toneFor(about)}

Write only the mantra. No quotes, no labels, no explanation.`.trim(),

    // Last check-in step: which of their own mantras fits today (goes
    // first in the card deck as "Suggested for today").
    mantra_today: ({ mantras = [], moods = [], note = '', journal = '', about = {} }) => `
You're helping someone at the end of their daily check-in pick from a small set of their own mantras.

Their mantras (numbered):
${list(mantras).map((m, i) => `${i}. ${m}`).join('\n')}

Today's check-in:
- Moods: ${list(moods).join(', ') || 'not shared'}
- What's behind these feelings: ${String(note || '').slice(0, 800) || '(nothing written)'}
- Journal: ${String(journal || '').slice(0, 1500) || '(nothing written)'}
${aboutYou(about)}

Choose the number of the mantra that best speaks to what they're carrying today.

Reply in exactly this format and nothing else:
PICK: <number>`.trim(),

    // The one line under the mantra card at the very end — written AFTER
    // they've chosen their mantra, so it can be framed through it.
    mantra_line: ({ mantra = '', moods = [], note = '', journal = '' }) => `
Someone just finished their daily check-in and spent a minute repeating this mantra:
"${mantra}"

What they wrote today:
- Moods: ${list(moods).join(', ') || 'not shared'}
- What's behind these feelings: ${String(note || '').slice(0, 800) || '(nothing written)'}
- Journal: ${String(journal || '').slice(0, 1500) || '(nothing written)'}

Write ONE short sentence (about 20 words max) to show under their mantra. It should:
- name the feeling underneath what they wrote — the emotion, not a recap of events or details (at most one light nod to the situation)
- then frame that feeling through the sentiment of the mantra, so the mantra reads as their answer to it
- echo the mantra's idea in fresh words rather than repeating it word for word
- speak to them as "you"; warm and plain

No advice, no diagnosing, no therapy-speak, no exclamation marks, and never invent details they didn't write.
For example (illustration only — don't reuse its wording): with the mantra "I am growing. That counts." and a journal about being frustrated at how slow progress feels, a good line is: "That impatience is real — and it's coming from someone who's still moving forward."

If they wrote nothing in either field, reply with exactly: NONE
Otherwise reply with only the sentence.`.trim(),

    trend_tip: ({ recentMoods, moodDirection }) => `
Write one gentle, encouraging sentence about this person's recent mood trend. Warm and light — no advice, no heavy observations, nothing that would weigh on them. Just a soft, affirming note about where they are.

Mood trend: ${moodDirection}
Recent mood scores (0=lowest, 100=highest): ${recentMoods.join(", ")}

One sentence only. No preamble.`.trim(),

    physical_state: ({ activeCalories, steps, sleepHours, sleepEfficiency, readinessScore, pills = {}, moods = [], note = '' }) => `
Write a short physical-state briefing for someone starting their day, based on yesterday's activity, sleep, and readiness data from their Oura ring. Format your response as two parts on a single line separated by "|||":

Part 1 (before |||): A short overarching mindset for the day — 2-5 words, like a headline. Examples: "Go for it today", "Take it easy", "Prioritize rest", "Ease into it". Pick whichever actually fits the data below; vary the phrasing rather than reusing these examples verbatim every time.
Part 2 (after |||): A 3-5 sentence paragraph, in this order: (1) explain what the scores below actually say, in plain terms; (2) translate that into what it might mean for how they could feel today, physically and mentally; (3) give one concrete, grounded suggestion for how to work with that feeling today — specific to what the data shows, not generic advice. Address them directly as "you". Warm, direct, no fluff.

Yesterday's data:
Active calories: ${activeCalories != null ? Math.round(activeCalories) : "no data"}
Steps: ${steps != null ? Math.round(steps) : "no data"}
Sleep duration: ${sleepHours != null ? `${sleepHours.toFixed(1)} hours` : "no data"}
Sleep efficiency: ${sleepEfficiency != null ? `${Math.round(sleepEfficiency)}%` : "no data"}
Readiness score: ${readinessScore != null ? Math.round(readinessScore) : "no data"}

The app shows these ratings on cards right next to your text: Activity — ${pills.activity || "n/a"}, Sleep — ${pills.sleep || "n/a"}, Readiness — ${pills.readiness || "n/a"}. Your headline and paragraph must agree with them: never describe a "Low" metric as fine or a "Great" one as lacking. Use the same judgement in your own words.

${list(moods).length || (note && note.trim()) ? `
How they said they feel right now (from their check-in a moment ago):
Moods: ${list(moods).join(', ') || "not given"}
What's behind it, in their words: ${note && note.trim() ? `"${note.trim()}"` : "nothing written"}

Use this as context. ONLY when it's pretty obvious, add one or two sentences to the paragraph that help them see which parts of their mood seem to come from what they wrote about (what's happening, what's on their mind) versus which parts may be coming from their body (e.g. feeling flat or irritable after a short night, restless after a sedentary day). Reference what they actually wrote. If the link isn't clear, don't force it — skip this entirely and just give the physical briefing. Never diagnose, and never tell them their feelings aren't real.
` : ''}
Write only the two parts separated by |||. No labels, no quotes.`.trim(),

    // Happy Hour multi-select: group the short things they type into a
    // small set of reusable labels. Lines in, lines out ("index|label").
    // Happy Hour options: regroup the WHOLE history in one pass so synonyms
    // merge across everything and sentence fragments get dropped.
    happy_hour_groups: ({ items = [], previous = [] }) => `
These are short phrases a person has written over time in their daily self-care check-in, answering "What's one nice thing you can do for yourself today?". Their entries were split on commas and periods, so some phrases are only fragments of a longer sentence. Each line: number. phrase (times written) — the full entry it came from.

${items.map((it, i) => `${i}. ${it.text} (${it.count}×) — "${it.entry}"`).join('\n')}

Turn these into a clean set of tap-to-select options:
- Group phrases that mean the same activity under ONE label, including near-synonyms — e.g. "rest", "relax", "take it easy", "chill out" are a single option.
- Keep genuinely different activities separate, and don't invent vague catch-alls like "Self care".
- SKIP anything that isn't an activity on its own: fragments of a longer sentence ("do it anyway", "even if I don't feel like it"), feelings, reasons or filler. Use the full entry to tell. If a fragment is really part of an activity in the same entry, put it in that activity's group instead (e.g. "Workout, even if I don't feel like it, do it anyway" → all of it is "Work out").
- Labels: 1–4 words, max 30 characters, sentence case, in their own voice ("Walk the dog", "Cook dinner", "Call a friend").
- Aim for 12 labels or fewer in total.
${list(previous).length ? `- When one of these existing labels fits a group, reuse its exact wording: ${list(previous).join('; ')}\n` : ''}
Output one line per label in the form "Label: n, n, n" using the phrase numbers, then one final line "SKIP: n, n" for everything skipped. Every phrase number must appear exactly once. Nothing else.`.trim(),

    happy_hour_consolidate: ({ phrases = [], existing = [] }) => `
You're tidying up a list of short things a person has written in a self-care check-in ("What's one nice thing you can do for yourself today?"). They'll be shown as tap-to-select options, so similar things should share ONE label.

${list(existing).length ? `Labels already in use — reuse one of these whenever a phrase means the same thing:\n${list(existing).map(l => `- ${l}`).join('\n')}\n` : ''}
Phrases to label (index. phrase):
${phrases.map((ph, i) => `${i}. ${ph}`).join('\n')}

For each phrase, give a short label: 1–4 words, max 30 characters, sentence case, in the person's own style (e.g. "Walk the dog", "Cook dinner", "Call a friend"). Phrases that mean the same activity must get the identical label. Keep genuinely different activities separate — don't lump things into vague categories like "Self care" or "Relax".

Output one line per phrase, exactly "index|label", nothing else.`.trim(),

    // ── New typed insight prompts ─────────────────────────────────────────
    insight_3day: ({ days, usingFallback, baseline, avoid, about = {} }) => `
You're writing the Insights card on the home screen of someone's personal mood-tracking app. Look at how their last three days have moved and name the trend. Use "you/your". Format as two parts on one line separated by "|||":

Part 1 (before |||): One or two sentences (max ~40 words) naming the clearest trend across these days — is their mood lifting, dipping, holding steady, or swinging? What seems to be driving it, based on what they wrote? How does it compare to their usual? Be specific: reference actual moods, days, or things they wrote. Warm and direct, like a friend who's been paying attention — not clinical, and don't just list their moods back.
Part 2 (after |||): One short journal prompt that follows from that trend, starting with "What", "When", or "How".

Mood score scale: -2 (hardest) to +2 (best).
${usingFallback
  ? "They haven't checked in during the last three days, so these are their three most recent check-ins. Frame it as \"your last few check-ins\" and don't comment on the gap."
  : "If a day shows no check-in, just work with the days that have one — don't mention missing days."}

Days (oldest → newest):
${(days || []).map(d => {
  if (!d.checkedIn) return `- ${d.label}: no check-in`;
  let line = `- ${d.label}: ${d.moods.join(', ')} (score ${d.score})`;
  if (d.note) line += ` · what's behind it: "${d.note}"`;
  if (d.journal) line += ` · journal: "${d.journal}"`;
  if (d.happyHour) line += ` · happy hour: "${d.happyHour}"`;
  if (d.exercises && d.exercises.length) line += ` · exercises done: ${d.exercises.join(', ')}`;
  return line;
}).join('\n')}

${baseline
  ? `Their usual (previous ${baseline.count} check-ins): average score ${baseline.avgScore}; most common moods: ${baseline.topMoods.join(', ')}.`
  : ''}
${avoid ? `They just refreshed past this one, so take a clearly different angle: "${avoid}"` : ''}

${aboutYou(about)}
Use what they've told you about themselves to sharpen both parts: if the last few days line up with something they said makes them feel good or brings them down, name that connection. Shape the journal prompt around it and around what they want this app to help with.
${toneFor(about)}

Never say there's no data or not enough data — work with what's here. Only the two parts separated by |||. No labels, no quotes.`.trim(),

    profile_synopsis: ({ topMoods, goodPct, journals, notes, happyHours, mantras, mantraReflections, insights, traits, insecurities, about = {} }) => `
You're writing the personal synopsis at the top of someone's profile in their private mood-tracking app. Read everything below and write a comprehensive, honest picture of who they are, what matters to them, and what's been going on with them lately. Address them directly as "you".

Their data (newest first):
Most common moods: ${(topMoods || []).join(', ') || 'none yet'}
Share of logged days that felt good: ${goodPct}%
Journal entries:
${(journals || []).map(j => `- ${j}`).join('\n') || '- none yet'}
"What's behind these feelings" notes:
${(notes || []).map(n => `- ${n}`).join('\n') || '- none yet'}
Happy hours (what brought them joy that day):
${(happyHours || []).map(h => `- ${h}`).join('\n') || '- none yet'}
Recent mantras: ${(mantras || []).join(' | ') || 'none yet'}
What their mantras meant to them:
${(mantraReflections || []).map(r => `- ${r}`).join('\n') || '- none yet'}
Recent insights already shown to them: ${(insights || []).join(' | ') || 'none'}
Strengths they named: ${(traits || []).join('; ') || 'none'}
What pulls them down: ${(insecurities || []).join('; ') || 'none'}
${aboutYou({ feelGood: about.feelGood, feelBad: about.feelBad, supportStyle: about.supportStyle, primaryGoal: about.primaryGoal })}
Where their entries line up with (or contradict) what they told you makes them feel good or brings them down, say so — that's the most useful thing you can reflect back.
${toneFor(about)}

Write:
1. "summary": 3–5 sentences (about 70–110 words). Weave the sources together — don't go source by source. Cover who they are and what they value, what's been weighing on them or lifting them lately, and the patterns connecting the two (e.g. what reliably brings them joy vs. what tends to drain them). Specific and concrete — name real things from their entries. Warm, perceptive, and direct, like a close friend who's been paying attention. No clinical language, no advice, no flattery, and never say there isn't enough data.
2. "themes": 4–6 recurring themes across all of it, each 1–3 words, specific rather than generic (not "life", "growth", "positivity").

Return ONLY raw JSON: {"summary": "...", "themes": ["...", "..."]}. No markdown code fences, no extra text.`.trim(),

    physical_emotional_trend: ({ pairedDays }) => `
You are looking for a connection between someone's physical readiness (from an Oura ring, 0-100 scale) and their emotional/mood score (-2 to +2 scale) on the same days.

Paired daily data (date: physical readiness score, emotional score):
${(pairedDays || []).map(d => `${d.date}: physical=${d.physical}, emotional=${d.emotional}`).join('\n') || 'not enough overlapping data'}

Write exactly 1 sentence, addressed directly to them ("you/your"), naming the clearest real pattern between their physical and emotional data — e.g. does low readiness track with harder emotional days, or are they independent? Be honest if the data doesn't show a strong pattern yet rather than inventing one. End with a brief grounding note so it doesn't read as deterministic (like "but you don't need to be 100% to have a good day").

Write only the 1 sentence. No labels, no preamble, no sign-off.`.trim(),

    physical_emotional_trend_long: ({ pairedDays }) => `
You are looking for a connection between someone's physical readiness (from an Oura ring, 0-100 scale) and their emotional/mood score (-2 to +2 scale) on the same days, across as much paired history as you're given. This is the expanded version of a one-sentence summary they've already seen — go deeper.

Paired daily data (date: physical readiness score, emotional score), oldest first:
${(pairedDays || []).map(d => `${d.date}: physical=${d.physical}, emotional=${d.emotional}`).join('\n') || 'not enough overlapping data'}

Write a short analysis, 3-5 sentences, addressed directly to them ("you/your"): name the clearest real pattern (or genuine lack of one) between their physical and emotional data, point to a specific stretch or example in the data where it shows up most clearly, and note anything that runs against the obvious assumption (e.g. good sleep not always meaning a good mood, or a rough physical day they still felt good on). Be honest if the data doesn't show a strong pattern yet rather than inventing one — say so plainly instead. Close with a brief grounding note so it doesn't read as deterministic (like "but you don't need to be 100% to have a good day").

Write only the analysis, as plain prose — no headers, no bullet points, no labels, no preamble.`.trim(),
  };

  const prompt = prompts[type]?.(data);
  if (!prompt) return { statusCode: 400, body: `Unknown type: ${type}` };

  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: type === 'happy_hour_consolidate' ? 900 : type === 'happy_hour_groups' ? 1000 : 450,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    return { statusCode: 504, body: `Claude request timed out or failed: ${e.message}` };
  }

  if (!response.ok) {
    const err = await response.text();
    return { statusCode: 502, body: `Anthropic error: ${err}` };
  }

  const result = await response.json();
  const text = result.content?.[0]?.text?.trim();

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  };
};

// Allow calls from the GitHub Pages app (see lib/cors.js)
exports.handler = require('./lib/cors').withCors(exports.handler);
