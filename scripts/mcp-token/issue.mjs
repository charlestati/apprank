#!/usr/bin/env node

// Issue an MCP credential.
//
// Deliberately a script that prints SQL rather than an HTTP endpoint. A
// token-minting route would be the most attractive thing on the origin to
// attack, and credentials here follow the same rule as everything else the
// operator configures: they are rows, applied with wrangler.
//
// The token is printed once. Only its SHA-256 goes in the database, because
// mcp_credential is an ordinary table: it is queried, dumped by
// `wrangler d1 export`, and rebuilt by scripts/rebuild-d1. BASIC_AUTH_ACCOUNTS
// can hold plaintext because a Worker secret is none of those things.
//
//   node scripts/mcp-token/issue.mjs --user admin --name laptop
//   node scripts/mcp-token/issue.mjs --user admin --name bob-ci --days 90 \
//     --scopes read:rankings,read:health

import { createHash, randomBytes } from "node:crypto";

function arg(flag, fallback) {
	const i = process.argv.indexOf(`--${flag}`);
	return i === -1 ? fallback : process.argv[i + 1];
}

const userId = arg("user");
const name = arg("name");
const days = Number(arg("days", "365"));
const scopes = arg("scopes", "read:all")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

if (!(userId && name)) {
	console.error(
		"usage: node scripts/mcp-token/issue.mjs --user <userId> --name <client-name>\n" +
			"                                       [--days 365] [--scopes read:all]\n\n" +
			"  --user must match tracked_app.user_id, the same durable identity as\n" +
			"            the userId in BASIC_AUTH_ACCOUNTS, not the username.\n" +
			"  --name    which client this is, so you can tell two credentials apart\n" +
			"            later and revoke the right one."
	);
	process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]{1,40}$/u.test(name)) {
	console.error("--name must be lowercase letters, digits and hyphens.");
	process.exit(1);
}
if (!(Number.isFinite(days) && days > 0)) {
	console.error("--days must be a positive number.");
	process.exit(1);
}

const id = randomBytes(6).toString("hex");
const secret = randomBytes(24).toString("base64url");
const token = `apprank_mcp_${id}_${secret}`;
const secretHash = createHash("sha256").update(secret).digest("hex");
const now = Date.now();
const expiresAt = now + days * 86_400_000;
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;

console.log(`
Token (copy it now, it is not stored and cannot be shown again):

  ${token}

Apply the credential (add --remote for the deployed database):

  cd apps/web && npx wrangler d1 execute apprank -c wrangler.local.jsonc --command "\\
INSERT INTO mcp_credential (id, user_id, name, secret_hash, scopes, created_at, expires_at) VALUES (\\
${quote(id)}, ${quote(userId)}, ${quote(name)}, ${quote(secretHash)}, ${quote(JSON.stringify(scopes))}, ${now}, ${expiresAt});"

Connect Claude Code (user scope, never a committed .mcp.json, this repo is public):

  claude mcp add --scope user --transport http apprank \\
    https://<your-app-url>/mcp \\
    --header "Authorization: Bearer ${token}"

Revoke it later:

  cd apps/web && npx wrangler d1 execute apprank -c wrangler.local.jsonc --command "\\
UPDATE mcp_credential SET revoked_at = unixepoch() * 1000 WHERE name = ${quote(name)};"
`);
