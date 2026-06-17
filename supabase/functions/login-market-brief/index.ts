import { corsHeaders } from "../_shared/cors.ts";
import { createSessionToken } from "../_shared/session.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const appUsername = Deno.env.get("APP_USERNAME");
    const appPassword = Deno.env.get("APP_PASSWORD");
    const sessionSecret = Deno.env.get("APP_SESSION_SECRET");
    if (!appUsername || !appPassword || !sessionSecret) {
      return jsonResponse({ success: false, error: "Missing APP_USERNAME, APP_PASSWORD, or APP_SESSION_SECRET." }, 500);
    }

    const body = await request.json().catch(() => ({}));
    const username = String(body.username || "");
    const password = String(body.password || "");

    if (username !== appUsername || password !== appPassword) {
      return jsonResponse({ success: false, error: "Invalid username or password" }, 401);
    }

    const session = await createSessionToken(username, sessionSecret);
    return jsonResponse({ success: true, ...session });
  } catch (error) {
    return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Login failed." }, 500);
  }
});

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
