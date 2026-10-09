#!/usr/bin/env node
// Usage (owner runs it, with the service role and key in the shell environment, never in chat):
//   node scripts/rewrite-connector-tokens.mjs --mode seal            # dry run, counts only
//   node scripts/rewrite-connector-tokens.mjs --mode seal --apply
//   node scripts/rewrite-connector-tokens.mjs --mode unseal --apply  # rollback to plaintext
import { getAdminClient } from '../api/lib/supabaseAdmin.js';
import { rewriteTokens } from '../api/lib/tokenMigration.js';

const args = process.argv.slice(2);
const mode = args[args.indexOf('--mode') + 1];
const apply = args.includes('--apply');
if (!['seal', 'unseal'].includes(mode)) {
  console.error('usage: --mode seal|unseal [--apply]');
  process.exit(2);
}
const stats = await rewriteTokens({ admin: getAdminClient(), mode, apply });
console.log(JSON.stringify({ mode, apply, ...stats }));
process.exit(stats.failed || stats.conflicts ? 1 : 0);
