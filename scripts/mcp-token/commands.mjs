// The wrangler commands issue.mjs prints, kept apart so they can be run in a
// test. The operator pastes them into a shell, so what matters is the SQL the
// shell hands wrangler, not the text on screen: a --command in double quotes
// let the shell strip the JSON's own quotes, stored the scope list as
// [read:all], and JSON.parse in apps/web/src/mcp/auth.ts then granted the
// credential nothing.

/** A SQL string literal. */
const sql = (v) => `'${String(v).replaceAll("'", "''")}'`;

/**
 * One shell word that arrives byte for byte. Inside single quotes the shell
 * interprets nothing, so the only character to handle is the single quote
 * itself, which SQL literals are full of.
 */
const shell = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;

const execute = (statement) =>
	`cd apps/web && npx wrangler d1 execute apprank -c wrangler.local.jsonc --command \\\n    ${shell(statement)}`;

function insertStatement({
	expiresAt,
	id,
	name,
	now,
	scopes,
	secretHash,
	userId,
}) {
	return `INSERT INTO mcp_credential (id, user_id, name, secret_hash, scopes, created_at, expires_at) VALUES (${sql(id)}, ${sql(userId)}, ${sql(name)}, ${sql(secretHash)}, ${sql(JSON.stringify(scopes))}, ${now}, ${expiresAt});`;
}

/**
 * By id, never by name: a name only tells one user's clients apart, so two
 * users can each have a "laptop", and revoking by name would cut off both.
 */
function revokeStatement(id) {
	return `UPDATE mcp_credential SET revoked_at = unixepoch() * 1000 WHERE id = ${sql(id)};`;
}

export const insertCommand = (credential) =>
	execute(insertStatement(credential));

export const revokeCommand = (id) => execute(revokeStatement(id));
