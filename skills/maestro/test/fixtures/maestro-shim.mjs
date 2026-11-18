/* Test stand-in for `maestro.mjs`: dispatches emit/status/who to events.mjs the same way the
   real CLI will once it wires them up. Lets the hook script be tested end to end. */
import { cmdEmit, cmdStatus, cmdWho } from '../../events.mjs';

const [, , sub, ...rest] = process.argv;
const verbs = { emit: cmdEmit, status: cmdStatus, who: cmdWho };
process.exitCode = verbs[sub] ? await verbs[sub](rest, {}) : 1;
