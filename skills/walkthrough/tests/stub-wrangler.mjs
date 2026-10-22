#!/usr/bin/env node
/* A stand-in for wrangler, driven by STUB_SCENARIO. It never touches the network.
   Scenarios: absent | owned-tag | owned-message | foreign | auth-error | garbage
   Every invocation is appended to STUB_LOG (one JSON line) so tests can assert what was run. */
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, account: process.env.CLOUDFLARE_ACCOUNT_ID || null }) + '\n');
const scenario = process.env.STUB_SCENARIO || 'absent';
const slug = process.env.STUB_SLUG || 'fixture';
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
  if (scenario === 'auth-error') { console.error('✘ [ERROR] A request to the Cloudflare API failed.\n\n  Authentication error [code: 10000]\n'); process.exit(1); }
  if (scenario === 'garbage') { console.log('<html>502 Bad Gateway</html>'); process.exit(0); }
  const plain = [{ id: 'v1', annotations: { 'workers/triggered_by': 'upload' } }, { id: 'v2', annotations: { 'workers/triggered_by': 'version_upload' } }];
  let list = plain;
  if (scenario === 'owned-tag' && cmd === 'versions') list = [...plain, { id: 'v3', annotations: { 'workers/tag': `walkthrough:${slug}`, 'workers/message': 'operator-walkthrough' } }];
  if (scenario === 'owned-message' && cmd === 'deployments') list = [...plain, { id: 'd3', annotations: { 'workers/message': `operator-walkthrough walkthrough:${slug}` } }];
  if (scenario === 'other-tag' && cmd === 'versions') list = [...plain, { id: 'v3', annotations: { 'workers/tag': 'walkthrough:someone-else' } }];
  console.log(JSON.stringify(list, null, 2));
  process.exit(0);
}
console.error('stub-wrangler: unexpected args ' + args.join(' '));
process.exit(2);
