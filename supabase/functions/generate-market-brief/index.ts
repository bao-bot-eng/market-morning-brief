import { corsHeaders } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { requireValidSession } from "../_shared/session.ts";

const CATEGORY_ORDER = [
  "Macro / Rates",
  "Inflation / Economic Data",
  "Oil / Geopolitics",
  "Index Futures / Risk Sentiment",
  "Tech / Mega-cap",
  "Semis / AI",
  "Earnings / Events",
  "Sector Rotation",
];

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await requireValidSession(request);
    const env = getRequiredEnv();
    const body = await request.json().catch(() => ({}));
    const dates = {
      us_date: safeDate(body.us_date) || formatDateInTimeZone(new Date(), "America/New_York"),
      sydney_date: safeDate(body.sydney_date) || formatDateInTimeZone(new Date(), "Australia/Sydney"),
    };
    const includeNextEvents = body.include_next_events !== false;
    const forceRegenerate = Boolean(body.force_regenerate);

    const supabase = createServiceClient();
    await deleteOldBriefs(supabase);
    const previousQuestions = await getPreviousObservationQuestions(supabase, dates.us_date);

    if (!forceRegenerate) {
      const { data: existing, error: existingError } = await supabase
        .from("market_briefs")
        .select("id, generated_at, brief_json, markdown, title")
        .eq("us_date", dates.us_date)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingError) {
        return jsonResponse({ success: false, error: existingError.message }, 500);
      }

      if (existing) {
        return jsonResponse({
          success: false,
          code: "BRIEF_EXISTS",
          error: "A brief for this US date already exists. Open existing or regenerate?",
          existing_brief_id: existing.id,
          existing_generated_at: existing.generated_at,
        }, 409);
      }
    }

    const geminiPayload = buildGeminiRequest(dates, includeNextEvents, previousQuestions);
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload),
      },
    );

    if (!geminiResponse.ok) {
      const rawError = await geminiResponse.text();
      const lower = rawError.toLowerCase();
      const quota = lower.includes("quota") || lower.includes("rate limit") || geminiResponse.status === 429;
      return jsonResponse({
        success: false,
        error: quota ? "Gemini quota exceeded or rate limited. Please try later or check your Gemini billing/quota." : `Gemini request failed: ${rawError}`,
      }, 502);
    }

    const rawGemini = await geminiResponse.json();
    let parsed: Record<string, unknown>;
    try {
      parsed = parseGeminiJson(rawGemini);
    } catch (error) {
      return jsonResponse({
        success: false,
        error: "JSON parse failed. Gemini did not return valid structured JSON.",
        raw_response: rawGemini,
      }, 502);
    }

    const groundingUrls = extractGroundingUrls(rawGemini);
    const brief = normalizeBrief(parsed, dates, groundingUrls);
    const generatedAt = new Date().toISOString();
    brief.generated_at = generatedAt;
    const markdown = renderMarkdown(brief);
    const title = getText(brief.key_market_background?.[0], "theme") || `US Market Morning Brief ${dates.us_date}`;

    if (forceRegenerate) {
      const { error: deleteError } = await supabase.from("market_briefs").delete().eq("us_date", dates.us_date);
      if (deleteError) {
        return jsonResponse({ success: false, error: deleteError.message }, 500);
      }
    }

    const { data: inserted, error: insertError } = await supabase
      .from("market_briefs")
      .insert({
        us_date: dates.us_date,
        sydney_date: dates.sydney_date,
        generated_at: generatedAt,
        brief_json: brief,
        markdown,
        title,
      })
      .select("id, generated_at")
      .single();

    if (insertError || !inserted) {
      return jsonResponse({ success: false, error: insertError?.message || "Supabase insert failed." }, 500);
    }

    return jsonResponse({
      success: true,
      brief_id: inserted.id,
      generated_at: inserted.generated_at,
      brief_json: brief,
      markdown,
      warning: groundingUrls.length ? "" : "No reliable source links returned. Please verify manually.",
    });
  } catch (error) {
    return error instanceof Response ? withCors(error) : jsonResponse({
      success: false,
      error: error instanceof Error ? error.message : "Failed to generate brief.",
    }, 500);
  }
});

function getRequiredEnv() {
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  const geminiModel = Deno.env.get("GEMINI_MODEL");
  if (!geminiApiKey) {
    throw new Error("Gemini API key missing. Set GEMINI_API_KEY in Supabase secrets.");
  }
  if (!geminiModel) {
    throw new Error("Missing secret GEMINI_MODEL.");
  }
  return { geminiApiKey, geminiModel };
}

async function deleteOldBriefs(supabase: ReturnType<typeof createServiceClient>) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  await supabase
    .from("market_briefs")
    .delete()
    .lt("generated_at", cutoff.toISOString());
}

async function getPreviousObservationQuestions(
  supabase: ReturnType<typeof createServiceClient>,
  currentUsDate: string,
) {
  const { data } = await supabase
    .from("market_briefs")
    .select("brief_json")
    .lt("us_date", currentUsDate)
    .order("us_date", { ascending: false })
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const questions = (data?.brief_json as Record<string, unknown> | undefined)?.observation_questions;
  return Array.isArray(questions) ? questions.slice(0, 5) : [];
}

function buildGeminiRequest(
  dates: { us_date: string; sydney_date: string },
  includeNextEvents: boolean,
  previousQuestions: unknown[],
) {
  const prompt = `
Prepare a bilingual English + Simplified Chinese US stock market morning brief for learning and market observation.
US date: ${dates.us_date}
Sydney date: ${dates.sydney_date}
Use Google Search grounding. Focus on today's US premarket context and, if requested, important events in the next 1-2 weeks.

Previous observation questions to follow up, if any:
${JSON.stringify(previousQuestions)}

Core assets: SPY, QQQ, SMH, NVDA, META, MSFT, AVGO, AMD.
Secondary assets: XLK, XLC, IWM, XLE, XLU, XLF, XLI, XLY, XLV.

Search intent examples to satisfy:
- Reuters Morning Bid US markets today
- CNBC stock futures today premarket
- MarketWatch premarket stock futures today
- Barron's premarket movers today
- US economic calendar this week CPI PPI PCE FOMC jobless claims
- earnings calendar next two weeks NVDA META MSFT AVGO AMD
- semiconductor stocks premarket NVDA AVGO AMD today
- mega cap tech premarket META MSFT NVDA today
- oil prices today US stock futures inflation Fed

Prefer high-quality sources: Reuters, CNBC, MarketWatch, Barron's, Investing.com, Nasdaq, official company IR pages, Federal Reserve official calendar.

Strict rules:
- Do not give buy, sell, or hold advice.
- Do not predict today's or tomorrow's price direction.
- Do not invent URLs or published times.
- If source is unclear, confidence must be "low".
- Do not force-fill empty categories, but do include important relevant items even when confidence is medium or low.
- If an item is important but still developing, include it with confidence "medium" or "low" and explain the uncertainty.
- Every news/event item must include do_not_overinterpret_en and do_not_overinterpret_zh.
- Keep English concise and beginner-friendly.
- Keep Chinese natural and useful for a Chinese-speaking learner.
- Return valid JSON only. No markdown fences.

Schema:
{
  "us_date": "${dates.us_date}",
  "sydney_date": "${dates.sydney_date}",
  "generated_at": "",
  "key_market_background": [
    {
      "theme_en": "",
      "theme_zh": "",
      "summary_en": "",
      "summary_zh": "",
      "related_assets": [],
      "confidence": "high | medium | low"
    }
  ],
  "hard_events_today": [
    {
      "event_en": "",
      "event_zh": "",
      "date": "",
      "time": "",
      "category": "",
      "related_assets": [],
      "source": "",
      "url": "",
      "notes_en": "",
      "notes_zh": ""
    }
  ],
  "categories": {
    "Macro / Rates": [],
    "Inflation / Economic Data": [],
    "Oil / Geopolitics": [],
    "Index Futures / Risk Sentiment": [],
    "Tech / Mega-cap": [],
    "Semis / AI": [],
    "Earnings / Events": [],
    "Sector Rotation": []
  },
  "next_1_2_weeks_watchlist": [
    {
      "date": "",
      "event_en": "",
      "event_zh": "",
      "category": "",
      "related_assets": [],
      "source": "",
      "url": "",
      "why_it_matters_en": "",
      "why_it_matters_zh": "",
      "do_not_overinterpret_en": "",
      "do_not_overinterpret_zh": ""
    }
  ],
  "previous_question_followups": [
    {
      "question_en": "",
      "question_zh": "",
      "answer_en": "",
      "answer_zh": "",
      "confidence": "high | medium | low"
    }
  ],
  "observation_questions": [
    { "en": "", "zh": "" }
  ],
  "not_trading_advice_en": "This brief is for market observation and learning only. It does not provide buy, sell, hold, or prediction advice.",
  "not_trading_advice_zh": "本简报仅用于市场观察和学习，不提供买入、卖出、持有或涨跌预测建议。"
}

Each item inside categories must contain:
{
  "title_en": "",
  "title_zh": "",
  "source": "",
  "published_time": "",
  "url": "",
  "category": "",
  "related_assets": [],
  "fact_en": "",
  "fact_zh": "",
  "summary_en": "",
  "summary_zh": "",
  "why_it_matters_en": "",
  "why_it_matters_zh": "",
  "do_not_overinterpret_en": "",
  "do_not_overinterpret_zh": "",
  "confidence": "high | medium | low"
}

Content volume:
- key_market_background: 3-5 most important items.
- categories: include every relevant, worth-reading item you find. Do not cap categories artificially, but keep each item concise.
- previous_question_followups: If previous questions are provided, answer them briefly using today's searched context. If there is not enough evidence, say what cannot be answered yet. If no previous questions are provided, return an empty array.
- observation_questions: 3-5 bilingual questions.
- ${includeNextEvents ? "Include next_1_2_weeks_watchlist." : "Use an empty next_1_2_weeks_watchlist array."}
`;

  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.25,
    },
  };
}

function parseGeminiJson(rawGemini: Record<string, unknown>) {
  const content = (rawGemini.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.content as
    | Record<string, unknown>
    | undefined;
  const parts = (content?.parts as Array<Record<string, unknown>> | undefined) || [];
  const combined = parts.map((part) => String(part.text || "")).join("\n").trim();
  if (!combined) {
    throw new Error("Empty Gemini response.");
  }

  try {
    return JSON.parse(combined);
  } catch {
    const start = combined.indexOf("{");
    const end = combined.lastIndexOf("}");
    if (start < 0 || end < 0) {
      throw new Error("Gemini response does not contain JSON.");
    }
    return JSON.parse(combined.slice(start, end + 1));
  }
}

function extractGroundingUrls(rawGemini: Record<string, unknown>) {
  const candidates = (rawGemini.candidates as Array<Record<string, unknown>> | undefined) || [];
  const chunks =
    (candidates[0]?.groundingMetadata as Record<string, unknown> | undefined)?.groundingChunks as
      | Array<Record<string, unknown>>
      | undefined
    || [];

  return chunks
    .map((chunk) => (chunk.web as Record<string, unknown> | undefined)?.uri)
    .filter((value): value is string => typeof value === "string" && value.startsWith("http"));
}

function normalizeBrief(
  parsed: Record<string, unknown>,
  dates: { us_date: string; sydney_date: string },
  groundingUrls: string[],
) {
  const fallbackUrl = groundingUrls[0] || "";
  const rawCategories = parsed.categories as Record<string, unknown> | undefined;
  const categories = Object.fromEntries(CATEGORY_ORDER.map((category) => [
    category,
    normalizeNewsItems(rawCategories?.[category], category, fallbackUrl),
  ]));

  return {
    us_date: safeString(parsed.us_date) || dates.us_date,
    sydney_date: safeString(parsed.sydney_date) || dates.sydney_date,
    generated_at: safeString(parsed.generated_at),
    key_market_background: normalizeSummaries(parsed.key_market_background),
    hard_events_today: normalizeEvents(parsed.hard_events_today, fallbackUrl),
    categories,
    next_1_2_weeks_watchlist: normalizeWatchlist(parsed.next_1_2_weeks_watchlist, fallbackUrl),
    previous_question_followups: normalizeFollowUps(parsed.previous_question_followups),
    observation_questions: normalizeQuestions(parsed.observation_questions),
    not_trading_advice_en:
      safeString(parsed.not_trading_advice_en) ||
      "This brief is for market observation and learning only. It does not provide buy, sell, hold, or prediction advice.",
    not_trading_advice_zh:
      safeString(parsed.not_trading_advice_zh) ||
      "本简报仅用于市场观察和学习，不提供买入、卖出、持有或涨跌预测建议。",
  };
}

function normalizeSummaries(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      theme_en: safeString(record.theme_en || record.title_en || record.theme),
      theme_zh: safeString(record.theme_zh || record.title_zh),
      summary_en: safeString(record.summary_en || record.summary),
      summary_zh: safeString(record.summary_zh),
      related_assets: normalizeAssets(record.related_assets),
      confidence: normalizeConfidence(record.confidence),
    };
  }).filter((item) => item.theme_en || item.theme_zh);
}

function normalizeEvents(value: unknown, fallbackUrl: string) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      event_en: safeString(record.event_en || record.title_en || record.event || record.title),
      event_zh: safeString(record.event_zh || record.title_zh),
      date: safeString(record.date || record.published_time),
      time: safeString(record.time),
      category: safeString(record.category) || "Earnings / Events",
      related_assets: normalizeAssets(record.related_assets),
      source: safeString(record.source),
      url: safeUrl(record.url, fallbackUrl),
      notes_en: safeString(record.notes_en || record.summary_en || record.notes),
      notes_zh: safeString(record.notes_zh || record.summary_zh),
    };
  }).filter((item) => item.event_en || item.event_zh);
}

function normalizeNewsItems(value: unknown, fallbackCategory: string, fallbackUrl: string) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      title_en: safeString(record.title_en || record.title),
      title_zh: safeString(record.title_zh),
      source: safeString(record.source),
      published_time: safeString(record.published_time),
      url: safeUrl(record.url, fallbackUrl),
      category: safeString(record.category) || fallbackCategory,
      related_assets: normalizeAssets(record.related_assets),
      fact_en: safeString(record.fact_en || record.fact),
      fact_zh: safeString(record.fact_zh),
      summary_en: safeString(record.summary_en || record.summary),
      summary_zh: safeString(record.summary_zh),
      why_it_matters_en: safeString(record.why_it_matters_en || record.why_it_matters),
      why_it_matters_zh: safeString(record.why_it_matters_zh),
      do_not_overinterpret_en: safeString(record.do_not_overinterpret_en || record.do_not_overinterpret),
      do_not_overinterpret_zh: safeString(record.do_not_overinterpret_zh),
      confidence: normalizeConfidence(record.confidence),
    };
  }).filter((item) => item.title_en || item.title_zh);
}

function normalizeWatchlist(value: unknown, fallbackUrl: string) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      date: safeString(record.date),
      event_en: safeString(record.event_en || record.title_en || record.event),
      event_zh: safeString(record.event_zh || record.title_zh),
      category: safeString(record.category) || "Earnings / Events",
      related_assets: normalizeAssets(record.related_assets),
      source: safeString(record.source),
      url: safeUrl(record.url, fallbackUrl),
      why_it_matters_en: safeString(record.why_it_matters_en || record.why_it_matters),
      why_it_matters_zh: safeString(record.why_it_matters_zh),
      do_not_overinterpret_en: safeString(record.do_not_overinterpret_en || record.do_not_overinterpret),
      do_not_overinterpret_zh: safeString(record.do_not_overinterpret_zh),
    };
  }).filter((item) => item.event_en || item.event_zh);
}

function normalizeFollowUps(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      question_en: safeString(record.question_en || record.en),
      question_zh: safeString(record.question_zh || record.zh),
      answer_en: safeString(record.answer_en || record.follow_up_en),
      answer_zh: safeString(record.answer_zh || record.follow_up_zh),
      confidence: normalizeConfidence(record.confidence),
    };
  }).filter((item) => item.question_en || item.question_zh || item.answer_en || item.answer_zh).slice(0, 5);
}

function normalizeQuestions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") {
      return { en: item, zh: "" };
    }
    const record = asRecord(item);
    return {
      en: safeString(record.en || record.question_en),
      zh: safeString(record.zh || record.question_zh),
    };
  }).filter((item) => item.en || item.zh).slice(0, 5);
}

function renderMarkdown(brief: Record<string, any>) {
  const lines = [
    "# US Market Morning Brief",
    `US Date: ${brief.us_date}`,
    `Sydney Date: ${brief.sydney_date}`,
    `Generated At: ${brief.generated_at || ""}`,
    "",
    "## 1. Today's Key Market Background / 今日重点背景",
    ...brief.key_market_background.flatMap((item: Record<string, unknown>) => [
      `- ${getText(item, "theme")}`,
      `  - EN: ${safeString(item.summary_en)}`,
      `  - 中文: ${safeString(item.summary_zh)}`,
      `  - Assets: ${normalizeAssets(item.related_assets).join(", ") || "-"}`,
      `  - Confidence: ${item.confidence}`,
    ]),
    "",
    "## 2. Hard Events Today / 今日硬事件",
    ...markdownEvents(brief.hard_events_today),
    "",
    "## 3. News by Category / 分类新闻",
  ];

  for (const category of CATEGORY_ORDER) {
    lines.push(`### ${category}`);
    lines.push(...markdownNews(brief.categories[category] || []));
    lines.push("");
  }

  lines.push("## 4. Next 1-2 Weeks Watchlist / 未来 1-2 周观察");
  lines.push(...markdownEvents(brief.next_1_2_weeks_watchlist));
  lines.push("");
  lines.push("## 5. Previous Question Follow-up / 昨日问题回看");
  lines.push(...markdownFollowUps(brief.previous_question_followups || []));
  lines.push("");
  lines.push("## 6. Today's Observation Questions / 今日观察问题");
  for (const question of brief.observation_questions || []) {
    lines.push(`- EN: ${safeString(question.en)}`);
    if (question.zh) lines.push(`  中文: ${safeString(question.zh)}`);
  }
  lines.push("");
  lines.push("## 7. Not Trading Advice / 非交易建议");
  lines.push(`- EN: ${brief.not_trading_advice_en}`);
  lines.push(`- 中文: ${brief.not_trading_advice_zh}`);
  return lines.join("\n");
}

function markdownFollowUps(items: Array<Record<string, unknown>>) {
  if (!items.length) return ["- None."];
  return items.flatMap((item) => [
    `- ${getText(item, "question")}`,
    `${safeString(item.answer_en) ? `  - EN: ${safeString(item.answer_en)}` : "  - EN: -"}`,
    `${safeString(item.answer_zh) ? `  - 中文: ${safeString(item.answer_zh)}` : "  - 中文: -"}`,
    `  - Confidence: ${safeString(item.confidence) || "medium"}`,
  ]);
}

function markdownNews(items: Array<Record<string, unknown>>) {
  if (!items.length) return ["- None."];
  return items.flatMap((item) => [
    `- ${getText(item, "title")}`,
    `  - Source: ${safeString(item.source)}${item.url ? ` (${item.url})` : ""}`,
    `  - Time: ${safeString(item.published_time) || "-"}`,
    `  - Assets: ${normalizeAssets(item.related_assets).join(", ") || "-"}`,
    `  - Fact EN: ${safeString(item.fact_en)}`,
    `  - 事实中文: ${safeString(item.fact_zh)}`,
    `  - Why EN: ${safeString(item.why_it_matters_en)}`,
    `  - 重要性中文: ${safeString(item.why_it_matters_zh)}`,
    `  - Do not over-interpret EN: ${safeString(item.do_not_overinterpret_en)}`,
    `  - 不要过度解读: ${safeString(item.do_not_overinterpret_zh)}`,
  ]);
}

function markdownEvents(items: Array<Record<string, unknown>>) {
  if (!items.length) return ["- None."];
  return items.flatMap((item) => [
    `- ${getText(item, "event")}`,
    `  - Date/time: ${safeString(item.date)} ${safeString(item.time)}`,
    `  - Source: ${safeString(item.source)}${item.url ? ` (${item.url})` : ""}`,
    `  - Assets: ${normalizeAssets(item.related_assets).join(", ") || "-"}`,
    `  - EN: ${safeString(item.notes_en || item.why_it_matters_en)}`,
    `  - 中文: ${safeString(item.notes_zh || item.why_it_matters_zh)}`,
  ]);
}

function getText(record: Record<string, unknown> | undefined, key: string) {
  if (!record) return "";
  const en = safeString(record[`${key}_en`]);
  const zh = safeString(record[`${key}_zh`]);
  return zh && en ? `${en} / ${zh}` : en || zh;
}

function safeDate(value: unknown) {
  const text = safeString(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function formatDateInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeAssets(value: unknown) {
  return Array.isArray(value) ? value.map((item) => safeString(item)).filter(Boolean) : [];
}

function normalizeConfidence(value: unknown) {
  const text = safeString(value).toLowerCase();
  return text === "high" || text === "medium" || text === "low" ? text : "medium";
}

function safeUrl(value: unknown, fallbackUrl: string) {
  const text = safeString(value);
  if (text.startsWith("https://") || text.startsWith("http://")) return text;
  return fallbackUrl;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function safeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function withCors(response: Response) {
  return new Response(response.body, {
    status: response.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
