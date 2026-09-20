// The OAuth front door.
//
// Claude's custom connector speaks OAuth or nothing — no static tokens, no
// custom headers. And the discovery document it needs (RFC 9728) has to live
// at /.well-known/... on the MCP server's own origin, which on a Supabase
// project belongs to Supabase's API gateway and returns "requested path is
// invalid". That single fact is why this Worker exists: it owns its whole path
// space, so it can serve the discovery documents that Supabase cannot.
//
// What it does:
//
//   /.well-known/oauth-protected-resource   RFC 9728 — points at itself as AS
//   /.well-known/oauth-authorization-server RFC 8414 — endpoints and methods
//   POST /register                          RFC 7591 — Claude self-registers
//   GET  /authorize                         sends the human to Google
//   GET  /callback                          Google returns; mint our own code
//   POST /token                             code + PKCE  ->  access token
//   ALL  /mcp                               verify token, proxy to the hub
//
// What it deliberately does NOT do: touch the database. It holds no Postgres
// credentials. Storage goes through the Edge Function, which already has the
// service key, so the original rule survives — the service role key never
// leaves Supabase.
//
// The payoff beyond connectivity: x-hub-user stops being an assertion. Every
// request the hub sees now carries an address Google verified, not a header
// the caller typed. That was the standing caveat in every doc in this project.

export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // Signs our authorization state and our access tokens. Any long random
  // string; rotating it invalidates every issued token, which is the only
  // revocation this version has.
  TOKEN_SECRET: string;
  HUB_URL: string;    // https://<ref>.supabase.co/functions/v1/hub
  HUB_TOKEN: string;  // service-to-service only; no user ever sees it
  // Optional comma-separated allowlist, e.g. "ottimate.com". Empty means any
  // Google account, which is right for a personal install and wrong for a
  // company one.
  ALLOWED_DOMAINS?: string;
}

const ACCESS_TTL = 3600;            // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 30;  // 30 days
const CODE_TTL = 60;                // authorization codes are short on purpose

// ---------------------------------------------------------------------------
// small crypto helpers, all Web Crypto — no dependencies
// ---------------------------------------------------------------------------
const enc = new TextEncoder();

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const sha256 = async (s: string) => b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));

const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]);

// Minimal JWT. Used for our access tokens and for the state we hand Google, so
// neither needs a database row.
async function signJWT(payload: Record<string, unknown>, secret: string, ttl: number) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttl };
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const data = `${head}.${b64url(enc.encode(JSON.stringify(body)))}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

async function verifyJWT(token: string, secret: string): Promise<any | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret),
    b64urlDecode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}

const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

// ---------------------------------------------------------------------------
// talking to the hub
// ---------------------------------------------------------------------------
async function hub(env: Env, verb: string, body: unknown) {
  const res = await fetch(`${env.HUB_URL}/${verb}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.HUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`hub ${verb}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

// A page rather than raw JSON, because these are the only two responses in the
// whole system a non-technical person will ever see with their own eyes.
const page = (title: string, message: string, status = 400) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<div style="font:15px/1.6 system-ui,sans-serif;max-width:44ch;margin:15vh auto;padding:0 24px">` +
    `<h1 style="font-size:19px;margin:0 0 12px">${title}</h1>` +
    `<p style="color:#555;margin:0">${message}</p></div>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

// ---------------------------------------------------------------------------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = url.origin;
    const path = url.pathname.replace(/\/$/, "") || "/";

    // -----------------------------------------------------------------------
    // discovery
    //
    // Matched by prefix, not equality. RFC 9728 forms the URI by inserting the
    // well-known segment before the resource path, so a client looking for
    // https://host/mcp asks for /.well-known/oauth-protected-resource/mcp —
    // while others ask for the bare path. Serving both costs nothing and
    // guessing wrong costs a connection that fails with no useful error.
    // -----------------------------------------------------------------------
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      return json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["mcp"],
        bearer_methods_supported: ["header"],
      });
    }

    if (path.startsWith("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        scopes_supported: ["mcp"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        // PKCE only. There is no client secret in this flow, which is correct
        // for a public client and removes a secret that would otherwise have
        // to live in someone's connector settings.
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }

    // -----------------------------------------------------------------------
    // RFC 7591 registration
    // -----------------------------------------------------------------------
    if (path === "/register" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return oauthError("invalid_request", "Body must be JSON."); }

      const redirects: string[] = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
      if (!redirects.length) {
        return oauthError("invalid_redirect_uri", "At least one redirect_uri is required.");
      }
      // Every redirect must be https, or a token can be handed to a listener on
      // the wire. localhost is allowed because desktop clients legitimately use
      // it and it never leaves the machine.
      for (const r of redirects) {
        try {
          const u = new URL(r);
          const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
          if (u.protocol !== "https:" && !local) {
            return oauthError("invalid_redirect_uri", `${r} is not https.`);
          }
        } catch {
          return oauthError("invalid_redirect_uri", `${r} is not a URL.`);
        }
      }

      const client_id = randomToken();
      const out = await hub(env, "oauth_register_client", {
        client_id,
        secret_hash: null,
        redirect_uris: redirects,
        name: String(body?.client_name ?? "MCP client").slice(0, 120),
      });
      if (out?.ok === false) return oauthError("invalid_request", out.message ?? "Could not register.");

      return json({
        client_id,
        redirect_uris: redirects,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(Date.now() / 1000),
      }, 201);
    }

    // -----------------------------------------------------------------------
    // /authorize — hand the human to Google
    // -----------------------------------------------------------------------
    if (path === "/authorize" && req.method === "GET") {
      const q = url.searchParams;
      const client_id = q.get("client_id") ?? "";
      const redirect_uri = q.get("redirect_uri") ?? "";
      const challenge = q.get("code_challenge") ?? "";
      const method = q.get("code_challenge_method") ?? "S256";

      if (q.get("response_type") !== "code") {
        return oauthError("unsupported_response_type", "Only response_type=code is supported.");
      }
      // PKCE is mandatory here, not optional. Without a secret it is the only
      // thing binding the code to the client that asked for it.
      if (!challenge || method !== "S256") {
        return oauthError("invalid_request", "code_challenge with S256 is required.");
      }

      const client = await hub(env, "oauth_get_client", { client_id });
      if (!client?.client_id) return oauthError("invalid_client", "Unknown client_id.");
      // Compared against what was registered, never merely parsed. An open
      // redirect here would hand authorization codes to whoever asked.
      if (!client.redirect_uris.includes(redirect_uri)) {
        return oauthError("invalid_request", "redirect_uri does not match this client's registration.");
      }

      // Everything needed after Google returns, signed so it survives the round
      // trip without a database row and cannot be edited in the browser.
      const state = await signJWT(
        { client_id, redirect_uri, challenge, method, cs: q.get("state") ?? "", scope: q.get("scope") ?? "mcp" },
        env.TOKEN_SECRET, 600,
      );

      const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      g.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      g.searchParams.set("redirect_uri", `${origin}/callback`);
      g.searchParams.set("response_type", "code");
      g.searchParams.set("scope", "openid email profile");
      g.searchParams.set("state", state);
      g.searchParams.set("prompt", "select_account");
      return Response.redirect(g.toString(), 302);
    }

    // -----------------------------------------------------------------------
    // /callback — Google is done; mint our own code
    // -----------------------------------------------------------------------
    if (path === "/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") ?? "";
      if (url.searchParams.get("error")) {
        return page("Sign-in cancelled", "You can close this tab and try connecting again.");
      }
      if (!code) return page("Sign-in failed", "Google did not return an authorization code.");

      const st = await verifyJWT(state, env.TOKEN_SECRET);
      if (!st) return page("Sign-in expired", "That sign-in took too long. Start again from Claude.");

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${origin}/callback`,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) return page("Sign-in failed", "Google would not exchange the sign-in code.");

      const tok: any = await tokenRes.json();
      // The id_token comes straight from Google over TLS in a response to our
      // own request, so reading its claims without re-verifying the signature
      // is sound. It would NOT be if this token arrived from the browser.
      const claims = tok.id_token
        ? JSON.parse(new TextDecoder().decode(b64urlDecode(tok.id_token.split(".")[1])))
        : null;

      const email = String(claims?.email ?? "").toLowerCase();
      if (!email || claims?.email_verified === false) {
        return page("Sign-in failed", "That Google account has no verified email address.");
      }

      const allowed = (env.ALLOWED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
      if (allowed.length && !allowed.includes(email.split("@")[1])) {
        return page("Not your hub",
          `This hub is limited to ${allowed.join(", ")}. You signed in as ${email}.`, 403);
      }

      // First sign-in creates the person row; without one, record_work refuses.
      await hub(env, "oauth_upsert_person", { email, name: String(claims?.name ?? "") });

      const ourCode = randomToken();
      await hub(env, "oauth_store_code", {
        code_hash: await sha256(ourCode),
        client_id: st.client_id,
        redirect_uri: st.redirect_uri,
        challenge: st.challenge,
        method: st.method,
        email,
        scope: st.scope,
        ttl_seconds: CODE_TTL,
      });

      const back = new URL(st.redirect_uri);
      back.searchParams.set("code", ourCode);
      if (st.cs) back.searchParams.set("state", st.cs);
      return Response.redirect(back.toString(), 302);
    }

    // -----------------------------------------------------------------------
    // /token
    // -----------------------------------------------------------------------
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const grant = form.get("grant_type");

      if (grant === "refresh_token") {
        const claims = await verifyJWT(form.get("refresh_token") ?? "", env.TOKEN_SECRET);
        if (!claims || claims.typ !== "refresh") {
          return oauthError("invalid_grant", "That refresh token is not valid.");
        }
        return json({
          access_token: await signJWT({ sub: claims.sub, cid: claims.cid, typ: "access" }, env.TOKEN_SECRET, ACCESS_TTL),
          token_type: "Bearer",
          expires_in: ACCESS_TTL,
          refresh_token: await signJWT({ sub: claims.sub, cid: claims.cid, typ: "refresh" }, env.TOKEN_SECRET, REFRESH_TTL),
          scope: "mcp",
        });
      }

      if (grant !== "authorization_code") {
        return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
      }

      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      if (!code || !verifier) return oauthError("invalid_request", "code and code_verifier are required.");

      // Single-use is enforced by the UPDATE inside this function, not by a
      // read followed by a write, so two simultaneous redemptions cannot both
      // succeed.
      const row = await hub(env, "oauth_consume_code", { code_hash: await sha256(code) });
      if (row?.ok === false) return oauthError("invalid_grant", row.message ?? "Bad code.");

      if (form.get("client_id") && form.get("client_id") !== row.client_id) {
        return oauthError("invalid_grant", "That code was issued to a different client.");
      }
      if (form.get("redirect_uri") && form.get("redirect_uri") !== row.redirect_uri) {
        return oauthError("invalid_grant", "redirect_uri does not match the one used to get this code.");
      }
      // PKCE. The whole point: proves the caller redeeming the code is the one
      // that requested it.
      if ((await sha256(verifier)) !== row.code_challenge) {
        return oauthError("invalid_grant", "code_verifier does not match the challenge.");
      }

      return json({
        access_token: await signJWT({ sub: row.email, cid: row.client_id, typ: "access" }, env.TOKEN_SECRET, ACCESS_TTL),
        token_type: "Bearer",
        expires_in: ACCESS_TTL,
        refresh_token: await signJWT({ sub: row.email, cid: row.client_id, typ: "refresh" }, env.TOKEN_SECRET, REFRESH_TTL),
        scope: row.scope ?? "mcp",
      });
    }

    // -----------------------------------------------------------------------
    // /mcp — the actual protected resource
    // -----------------------------------------------------------------------
    if (path === "/mcp") {
      // The header that makes discovery work. A 401 without it is a dead end:
      // the client has no way to learn where to authenticate.
      const challenge = {
        "WWW-Authenticate":
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      };

      const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!bearer) return json({ error: "unauthorized" }, 401, challenge);

      const claims = await verifyJWT(bearer, env.TOKEN_SECRET);
      if (!claims || claims.typ !== "access" || !claims.sub) {
        return json({ error: "invalid_token" }, 401, challenge);
      }

      // The point of the whole exercise. x-hub-user is now an address Google
      // verified, injected by us — not a header the caller chose.
      const res = await fetch(env.HUB_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.HUB_TOKEN}`,
          "Content-Type": "application/json",
          "x-hub-user": claims.sub,
        },
        body: await req.text(),
      });
      return new Response(res.body, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/") {
      return page("Skill Atlas hub",
        "This is the connector endpoint. Add it to Claude as a custom connector using the /mcp path.", 200);
    }

    return json({ error: "not_found" }, 404);
  },
};
