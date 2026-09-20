# Deploying the OAuth gateway

The Worker that lets a non-engineer paste a URL into Claude and sign in with
Google. Everything else is already deployed and tested; this is the last piece.

Nothing here has been run end to end. The pieces are verified — PKCE against
the RFC 7636 test vector, JWT forgery and tampering rejected, all five storage
functions exercised including code replay — but the browser redirect loop needs
a browser, so the final check is yours.

---

## Why this exists at all

Claude's custom connector supports OAuth or nothing. No static tokens, no
custom headers. And RFC 9728 says the discovery document must live at
`/.well-known/oauth-protected-resource` on the MCP server's own origin — which
on a Supabase project belongs to Supabase's API gateway:

```
GET https://<ref>.supabase.co/.well-known/oauth-protected-resource
    404  {"error":"requested path is invalid"}
```

No amount of code inside the Edge Function fixes that. The Worker owns its
whole path space, so it can serve what Supabase cannot.

---

## 1. A Google OAuth client

Google Cloud Console → **APIs & Services → Credentials → Create credentials →
OAuth client ID → Web application**.

Add **one** authorised redirect URI. You will not know the Worker's hostname
until step 3, so either deploy first and come back, or set a custom route now:

```
https://<your-worker-host>/callback
```

Keep the client ID and secret. Do not put them in any file — they go in as
Worker secrets in step 4.

**On the consent screen:** an "External" app that is unverified shows a warning
screen and caps at 100 users. Fine for a pilot. If the hub is for one Workspace
domain, choose **Internal** instead — no warning, no cap, and only that domain
can sign in.

## 2. Set HUB_TOKEN on Supabase

Still required. The Worker uses it to reach the Edge Function; users never see
it. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Supabase dashboard → **Project Settings → Edge Functions → Secrets** → add
`HUB_TOKEN`.

## 3. Deploy the Worker

```bash
cd projects/skill-atlas/gateway
npx wrangler login
npx wrangler deploy
```

That prints the hostname, something like
`https://skill-atlas-gateway.<your-subdomain>.workers.dev`. Go back to step 1
and set the redirect URI to `<that host>/callback`.

## 4. Set the Worker's secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put HUB_TOKEN
npx wrangler secret put TOKEN_SECRET
```

`TOKEN_SECRET` signs the access tokens — generate it the same way as
`HUB_TOKEN`, and make it different. Rotating it invalidates every issued token,
which is the only revocation this version has.

`HUB_URL` is already set in `wrangler.toml`. Set `ALLOWED_DOMAINS` there too if
this hub belongs to a company rather than to you.

## 5. Check it before involving Claude

```bash
curl -s https://<host>/.well-known/oauth-protected-resource
curl -s https://<host>/.well-known/oauth-authorization-server
```

Both must return JSON. The first must name the second in
`authorization_servers`. If either 404s, the connector will fail with no useful
error, so do not skip this.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<host>/mcp
```

Expect **401** with a `WWW-Authenticate: Bearer resource_metadata="..."` header.
That header is how Claude discovers where to authenticate; without it a 401 is
a dead end.

## 6. Connect Claude

Customize → Connectors → **+** → Add custom connector → `https://<host>/mcp`.
Claude registers itself, sends you to Google, and comes back connected. Then
ask it to list what it can do — nine tools means the whole chain works.

---

## What to look at when a step fails

| symptom | where it is |
|---|---|
| "Could not connect" immediately | discovery — re-run the two curls in step 5 |
| Google says `redirect_uri_mismatch` | step 1 URI does not exactly match `<host>/callback` |
| "Sign-in expired" | the state JWT is over 10 minutes old; just retry |
| Connects, but every tool errors | `HUB_TOKEN` differs between Supabase and the Worker |
| `record_work` says "No such person" | `oauth_upsert_person` did not run — check Worker logs at `/callback` |

`npx wrangler tail` streams live logs while you click through.

---

## Known limits, carried deliberately

**No token revocation.** Access tokens are signed, not stored, so nothing can
invalidate one before it expires except rotating `TOKEN_SECRET`, which
invalidates everyone's. Access tokens last an hour, refresh tokens thirty days.
Storing token hashes would fix it and costs a database round trip on every
call; worth doing when there is a reason to revoke one person.

**Open client registration.** Anyone can POST to `/register`. The spec allows
it and Claude depends on it, and a registered client can still do nothing
without sending a real human through Google first. The thing being protected is
the sign-in, not the client record.

**The Worker is the whole trust boundary.** It holds `HUB_TOKEN`, so anything
that compromises it reaches the hub as any user. That is the same shape as any
gateway, and it is why the Worker holds no database credential — the blast
radius stops at the Edge Function's own surface.
