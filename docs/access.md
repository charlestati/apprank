# Access control

The Worker gates the whole origin with HTTP Basic. An unauthenticated visitor
gets a 401 and a browser credential prompt — not the page, not the API. With no
accounts configured it serves nothing at all (503), so a fresh deployment is
never accidentally public.

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
username. Set it to `admin` to inherit rows created by the seed template.

Ownership is a second, separate check: a request for an app or keyword you do
not track answers **404, not 403**, because a 403 would confirm that the id
exists. Crawled observations are deliberately shared — two operators tracking
one keyword produce one fetch — so ownership gates access to a pair's data
rather than the data itself. First-party App Store Connect analytics is the
exception: it is scoped per app and answers only for apps you track.

Two known limits of Basic auth, both deliberate trades: there is no sign-out
short of closing the browser, and rotating a password means updating the secret.
In exchange the Worker is 84 KiB instead of 1.9 MB, with no session tables to
maintain. If you want real sign-out, single sign-on, or self-service accounts,
put Cloudflare Access in front of the Worker route — the `userId` plumbing stays
exactly as it is.

Passwords are compared as SHA-256 digests in constant time. That is deliberate
rather than an oversight: a KDF would be the most expensive thing in the request
on the free tier's 10 ms CPU budget, and these are machine-generated
high-entropy secrets, so there is no offline brute-force to slow down.
