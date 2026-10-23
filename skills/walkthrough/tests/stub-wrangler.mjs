#!/usr/bin/env node
/* A stand-in for wrangler, driven by environment variables. It never touches the network.
   STUB_SCENARIO: absent | owned-tag | owned-message | foreign | auth-error | garbage |
                  mixed-versions-array (versions list is an array, deployments says not found) |
                  mixed-deployments-array (the reverse) | warning-prefix (owned, with a [WARNING] line before the JSON)
   STUB_TAG:      the exact tag the "owned" scenarios carry
   STUB_ACCOUNTS: comma-separated account ids printed by `whoami`
   Every invocation is appended to STUB_LOG (one JSON line) so tests can assert what was run. */
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, account: process.env.CLOUDFLARE_ACCOUNT_ID || null }) + '\n');
const scenario = process.env.STUB_SCENARIO || 'absent';
const tag = process.env.STUB_TAG || 'walkthrough:fixture:00000000';
const [cmd, sub] = args;

if (cmd === 'whoami') {
  console.log('Account Name | Account ID\n' + (process.env.STUB_ACCOUNTS || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').split(',').map((a) => `Acct | ${a}`).join('\n'));
  process.exit(0);
}
if (cmd === 'deploy') {
  console.log('Uploaded wt-stub\nDeployed wt-stub triggers\n  https://wt-stub.example-sub.workers.dev');
  process.exit(0);
}
if (cmd === 'versions' || cmd === 'deployments') {
  const notFound = () => {
    console.error('✘ [ERROR] A request to the Cloudflare API (/accounts/x/workers/scripts/n/' + cmd + ') failed.\n\n  This Worker does not exist on your account. [code: 10007]\n');
    process.exit(1);
  };
  if (scenario === 'absent') notFound();
  if (scenario === 'mixed-versions-array' && cmd === 'deployments') notFound();
  if (scenario === 'mixed-deployments-array' && cmd === 'versions') notFound();
  if (scenario === 'auth-error') { console.error('✘ [ERROR] A request to the Cloudflare API failed.\n\n  Authentication error [code: 10000]\n'); process.exit(1); }
  if (scenario === 'garbage') { console.log('<html>502 Bad Gateway</html>'); process.exit(0); }
  const plain = [{ id: 'v1', annotations: { 'workers/triggered_by': 'upload' } }, { id: 'v2', annotations: { 'workers/triggered_by': 'version_upload' } }];
  let list = plain;
  if ((scenario === 'owned-tag' || scenario === 'warning-prefix') && cmd === 'versions') list = [...plain, { id: 'v3', annotations: { 'workers/tag': tag, 'workers/message': 'operator-walkthrough' } }];
  if (scenario === 'owned-message' && cmd === 'deployments') list = [...plain, { id: 'd3', annotations: { 'workers/message': `operator-walkthrough ${tag}` } }];
  if (scenario === 'other-tag' && cmd === 'versions') list = [...plain, { id: 'v3', annotations: { 'workers/tag': 'walkthrough:someone-else:12345678' } }];
  if (scenario === 'old-style-tag' && cmd === 'versions') list = [...plain, { id: 'v3', annotations: { 'workers/tag': tag.split(':').slice(0, 2).join(':') } }];
  if (scenario === 'warning-prefix') console.log('[WARNING] wrangler update available\nrun npm i -g wrangler');
  console.log(JSON.stringify(list, null, 2));
  process.exit(0);
}
console.error('stub-wrangler: unexpected args ' + args.join(' '));
process.exit(2);
