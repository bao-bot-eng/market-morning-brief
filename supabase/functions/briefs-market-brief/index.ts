import { corsHeaders } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { requireValidSession } from "../_shared/session.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    await requireValidSession(request);
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "list");
    const supabase = createServiceClient();

    if (action === "list") {
      const { data, error } = await supabase
        .from("market_briefs")
        .select("id, us_date, sydney_date, generated_at, title")
        .order("generated_at", { ascending: false })
        .limit(20);

      if (error) {
        return jsonResponse({ success: false, error: error.message }, 500);
      }

      return jsonResponse({ success: true, items: data || [] });
    }

    if (action === "get") {
      const briefId = String(body.brief_id || "");
      if (!briefId) {
        return jsonResponse({ success: false, error: "Missing brief_id." }, 400);
      }

      const { data, error } = await supabase
        .from("market_briefs")
        .select("id, us_date, sydney_date, generated_at, brief_json, markdown, title")
        .eq("id", briefId)
        .single();

      if (error) {
        return jsonResponse({ success: false, error: error.message }, 404);
      }

      return jsonResponse({
        success: true,
        brief_id: data.id,
        generated_at: data.generated_at,
        brief_json: data.brief_json,
        markdown: data.markdown,
        title: data.title,
      });
    }

    if (action === "delete") {
      const briefId = String(body.brief_id || "");
      if (!briefId) {
        return jsonResponse({ success: false, error: "Missing brief_id." }, 400);
      }

      const { error } = await supabase.from("market_briefs").delete().eq("id", briefId);
      if (error) {
        return jsonResponse({ success: false, error: error.message }, 500);
      }

      return jsonResponse({ success: true });
    }

    return jsonResponse({ success: false, error: "Unknown history action." }, 400);
  } catch (error) {
    return error instanceof Response ? withCors(error) : jsonResponse({ success: false, error: String(error) }, 500);
  }
});

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
