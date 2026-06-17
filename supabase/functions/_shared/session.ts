const encoder = new TextEncoder();

type SessionPayload = {
  sub: string;
  iat: number;
  exp: number;
};

export async function createSessionToken(username: string, secret: string, ttlSeconds = 60 * 60 * 12) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: SessionPayload = {
    sub: username,
    iat: now,
    exp: now + ttlSeconds,
  };

  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = await sign(unsigned, secret);
  return {
    token: `${unsigned}.${signature}`,
    expires_at: new Date(payload.exp * 1000).toISOString(),
  };
}

export async function requireValidSession(request: Request) {
  const secret = Deno.env.get("APP_SESSION_SECRET");
  if (!secret) {
    throw new Response(JSON.stringify({ success: false, error: "Missing secret APP_SESSION_SECRET." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!token) {
    throw new Response(JSON.stringify({ success: false, error: "Missing session token." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Response(JSON.stringify({ success: false, error: "Invalid session token." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const [header, payload, signature] = parts;
  const expected = await sign(`${header}.${payload}`, secret);
  if (!timingSafeEqual(signature, expected)) {
    throw new Response(JSON.stringify({ success: false, error: "Invalid session token." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const decoded = JSON.parse(base64UrlDecode(payload)) as SessionPayload;
  if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) {
    throw new Response(JSON.stringify({ success: false, error: "Session expired. Please log in again." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return decoded;
}

async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function base64UrlEncode(value: string) {
  return base64UrlEncodeBytes(encoder.encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}
