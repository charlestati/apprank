# Credentials

Nothing personal lives in the repository. Every credential is a Worker secret,
and the apps to collect for come from the `tracked_app` table rather than from
configuration.

| Name                                                            | Lives on                                               | Purpose                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASIC_AUTH_ACCOUNTS`                                           | web Worker                                             | The wall in front of the whole origin. A JSON array of accounts, listed in [access control](access.md). Without it the Worker serves nothing at all, deliberately: it fails closed rather than open |
| `ADMIN_TOKEN`                                                   | collector Worker, `.dev.vars`, GitHub                  | Gates `POST /admin/run?job=…`, the collector's only public route. Not a debug convenience: every collection run drives the collector through it, so no token means no collection                    |
| `ASC_ISSUER_ID`, `ASC_KEY_ID`, `ASC_PRIVATE_KEY`                | collector Worker                                       | App Store Connect analytics. Optional; the daily job skips them quietly when absent                                                                                                                 |
| `ADS_CLIENT_ID`, `ADS_TEAM_ID`, `ADS_KEY_ID`, `ADS_PRIVATE_KEY` | collector Worker                                       | Apple Ads search-term popularity, the only official source of search volume. Optional in the same way                                                                                               |
| `MCP_ENABLED`                                                   | web `wrangler.local.jsonc` (a var, not a secret)       | Off unless set to `true`. The MCP endpoint at `/mcp` is opt-in: without it the route 404s and nothing is published                                                                                  |
| `COLLECTION_MODE`                                               | collector `wrangler.local.jsonc` (a var, not a secret) | `all` by default. Set it to `credentialed` on a deployment whose egress Apple rejects, which is every Cloudflare Worker                                                                             |

```sh
cd apps/collector   # or apps/web
npx wrangler secret put <NAME> -c wrangler.local.jsonc
```

`wrangler secret put` publishes a new Worker version by itself, so **no deploy
is needed** and the value takes effect immediately. Reading a secret back is
impossible by design, so rotation always means overwriting, never comparing.

## Rotating

Most secrets live in one place, so `wrangler secret put` is the whole procedure.
Two are exceptions.

**`ADMIN_TOKEN` lives in three places and all of them must match**, because it
is both sides of the same check: `wrangler dev` reads `.dev.vars` to tell the
Worker what to expect, and `scripts/local-refresh/refresh.sh` reads the same
file to build its `Authorization` header.

```sh
openssl rand -base64 24                              # generate

cd apps/collector
npx wrangler secret put ADMIN_TOKEN -c wrangler.local.jsonc   # 1. deployed Worker
printf 'ADMIN_TOKEN=%s\n' 'THE_NEW_VALUE' > .dev.vars        # 2. local runs
#                                    3. GitHub → Settings → Secrets → Actions
```

Do them in that order. Between the first and the last, workflow runs will 401,
so rotate outside the collection window. Verify with the old value (expect
`401`) and the new one against `?job=cadence`, which recomputes from data
already held and costs no Apple traffic.

**`BASIC_AUTH_ACCOUNTS` carries identity, not just a password.** The `userId`
field is what `tracked_app.user_id` and every ownership check compare against,
so passwords rotate freely but changing a `userId` re-points that person at a
different set of apps. They will sign in successfully and see an empty
dashboard, because a resource you do not own answers 404 rather than an error.

## App Store Connect key

Needs the **Admin** role, and keeps needing it: the collector creates report
requests (`POST /v1/analyticsReportRequests`) and re-creates them when Apple
kills one with `stoppedDueToInactivity`. Apple's own documentation is explicit
that "an Admin role is required to request a new Analytics Report type for the
first time"; Sales and Reports or Finance can only download what already exists.
Note what that grants: an ASC **Team Key** with Admin is account-wide.

1. App Store Connect → **Users and Access → Integrations → App Store Connect API
   → Team Keys**
2. **+**, name it, Access = **Admin**
3. Download the `.p8`. **Once only**, Apple never shows it again
4. Copy the **Key ID** (that row) and the **Issuer ID** (top of the page)

```sh
cd apps/collector
npx wrangler secret put ASC_ISSUER_ID -c wrangler.local.jsonc
npx wrangler secret put ASC_KEY_ID    -c wrangler.local.jsonc
npx wrangler secret put ASC_PRIVATE_KEY -c wrangler.local.jsonc < ~/Downloads/AuthKey_XXXXXXXXXX.p8
```

The `.p8` is already PKCS#8, so it feeds `ASC_PRIVATE_KEY` verbatim, BEGIN and
END lines included.

Set this early. The first poll fires a `ONE_TIME_SNAPSHOT` that captures every
day App Store Connect still retains, and that window shrinks daily.

## Apple Ads key

Two traps here, either of which will cost you an evening.

**An Account Admin cannot mint API credentials.** The public-key field only
appears for a user holding an API role. Create one first: Apple Ads → **Account
Settings → User Management → Add Users**, role **API Account Manager** (Apple's
recommended choice) or **API Account Read Only**, which is enough here since
this only reads. It needs its own Apple Account, a different address from the
admin's, then sign in **as that user**.

**The key must be PKCS#8.** `openssl ecparam -genkey` emits SEC1
(`BEGIN EC PRIVATE KEY`), and `packages/core/src/apple/jwt.ts` imports as
`pkcs8`. Skip the conversion and every Ads call fails at key import, before
Apple is ever contacted.

```sh
openssl ecparam -genkey -name prime256v1 -noout -out ads-ec.pem
openssl pkcs8 -topk8 -nocrypt -in ads-ec.pem -out ads-private-key.pem   # required
openssl ec -in ads-private-key.pem -pubout -out ads-public-key.pem
rm ads-ec.pem
```

Paste `ads-public-key.pem` (BEGIN and END included) into **Account Settings →
API**. Apple returns a **clientId**, **teamId** and **keyId**.

```sh
cd apps/collector
npx wrangler secret put ADS_CLIENT_ID -c wrangler.local.jsonc
npx wrangler secret put ADS_TEAM_ID   -c wrangler.local.jsonc
npx wrangler secret put ADS_KEY_ID    -c wrangler.local.jsonc
npx wrangler secret put ADS_PRIVATE_KEY -c wrangler.local.jsonc < ads-private-key.pem
```

The public half is never deployed. Apple keeps it and verifies your signature
against it. No ad account id is needed either: the collector discovers it
through `GET /v1/acls`, one of only two endpoints that work without the
`X-AP-Context` header, and caches it.

## Verifying either credential

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<collector>.workers.dev/admin/run?job=asc"
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<collector>.workers.dev/admin/run?job=ads"
```

`job=ads` verifies without writing: it fetches, archives the response to R2 and
stops. Add `&write=1` for the full pull.
