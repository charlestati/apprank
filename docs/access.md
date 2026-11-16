# Access control

The Worker gates the whole origin, the page as well as the API. It accepts one
of two browser credentials:

- **Cloudflare Access** (recommended). Access signs people in through an
  identity provider or a one-time code sent by email, and the session lasts as
  long as you set it to (up to a month). There is no password to type or for a
  password manager to fill, and signing out is a link.
- **HTTP Basic**. A browser credential prompt checked against accounts in a
  secret. It needs no Zero Trust setup, but the browser forgets the credentials
  when it closes and there is no way to sign out.

When Access is configured, Basic is not consulted at all, so a password left in
`BASIC_AUTH_ACCOUNTS` stops working the moment you switch. When neither is
configured the Worker serves nothing (503), so a fresh deployment is never
accidentally public.

One route is public on purpose: `GET /api/health`, so an uptime check works
without credentials. It names no app and no keyword. `/mcp`, when enabled,
accepts neither browser credential and has its own bearer-token gate, described
in [MCP](mcp.md).

## Cloudflare Access

Access is free for up to 50 users. It runs in front of the Worker; the Worker
then checks every request itself, verifying the signed token Access attaches
(`Cf-Access-Jwt-Assertion`) against your team's published keys, the
application's audience tag and the token's expiry. A request that reached the
Worker without passing through Access is refused, whatever headers it carries.

### 1. Turn Access on for the Worker

In the Cloudflare dashboard, open **Workers & Pages → apprank-web → Settings →
Domains & Routes**, and enable **Cloudflare Access** on the `workers.dev` route.
That creates an Access application for the hostname and shows its **Audience
(AUD) tag** and the JWKS URL, which starts with your team domain
(`https://<team>.cloudflareaccess.com`).

Then, in **Zero Trust → Access → Applications**, open that application and:

- set the **policy** to the people allowed in, for example an _Emails_ rule
  listing each operator, and
- raise the **session duration** (a month is the maximum), which is what stops
  the frequent sign-ins.

### 2. Tell the Worker

```sh
cd apps/web
npx wrangler secret put ACCESS_TEAM_DOMAIN -c wrangler.local.jsonc  # https://<team>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD         -c wrangler.local.jsonc  # the AUD tag
npx wrangler secret put ACCESS_USERS       -c wrangler.local.jsonc
# [
#   { "email": "you@example.com",       "userId": "admin" },
#   { "email": "colleague@example.com", "userId": "colleague" }
# ]
```

All three must be set. With only some of them the Worker answers 503 until the
rest arrive, rather than guessing whether you meant Access or Basic.

`userId` is what ties a person to their data (`tracked_app.user_id`). When
moving from Basic, give each person the `userId` their Basic account had, and
they keep their apps. Leave it out and it defaults to the email.

Someone the Access policy lets in but `ACCESS_USERS` does not list gets a 403.
The policy decides who may sign in; `ACCESS_USERS` decides whose data they see.

Once Access works, delete the old secret:
`npx wrangler secret delete BASIC_AUTH_ACCOUNTS -c wrangler.local.jsonc`.

### Signing out

Visit `/cdn-cgi/access/logout` on the Worker's hostname.

### MCP and uptime checks behind Access

Access protects the whole `workers.dev` hostname, so it also stands in front of
`/mcp` and `/api/health`, and redirects any client that is not a signed-in
browser to its login page. The Worker's own rules for those two paths do not
change, but the request has to get past Access first. Two ways round it:

- **A custom domain.** Access applications on a hostname in one of your zones
  can be scoped to a path. Add one for `/mcp` and one for `/api/health`, each
  with a _Bypass_ policy, and the bearer gate and the public probe work as
  before.
- **A service token.** Create one under **Zero Trust → Access → Service
  credentials**, add a _Service Auth_ policy that includes it to the
  application, and have the client send `CF-Access-Client-Id` and
  `CF-Access-Client-Secret` alongside its own credentials. This works for MCP
  clients that let you set request headers (Claude Code does, in its MCP server
  configuration) and for most uptime monitors.

## HTTP Basic

Accounts live in one secret, as JSON:

```sh
cd apps/web
npx wrangler secret put BASIC_AUTH_ACCOUNTS
# [
#   { "username": "you",       "password": "…", "userId": "admin" },
#   { "username": "colleague", "password": "…", "userId": "colleague" }
# ]
```

Generate passwords with `openssl rand -base64 24`. `userId` is what ties an
account to its data (`tracked_app.user_id`); leave it out and it defaults to the
username.

Two known limits of Basic auth, both deliberate trades: there is no sign-out
short of closing the browser, and rotating a password means updating the secret.

Passwords are compared as SHA-256 digests in constant time. That is deliberate
rather than an oversight: a KDF would be the most expensive thing in the request
on the free tier's 10 ms CPU budget, and these are machine-generated
high-entropy secrets, so there is no offline brute-force to slow down.

## Ownership

Ownership is a second, separate check, the same under either credential: a
request for an app or keyword you do not track answers **404, not 403**, because
a 403 would confirm that the id exists. Crawled observations are deliberately
shared, since two operators tracking one keyword in one storefront produce one
fetch, so ownership gates access to a pair's data rather than the data itself.
It is checked per storefront: tracking a keyword in France does not open another
operator's pair for the same keyword in Germany. First-party App Store Connect
analytics is the exception: it is scoped per app and answers only for apps you
track.
