export const meta = {
  name: 'prototype-hub',
  description: 'Turn client conversations into clickable prototype options and a review hub, with an automated gate after every build and fix',
  phases: [
    { title: 'Brief', detail: 'read the sources; heard versus assumed, and what conflicts' },
    { title: 'Foundation', detail: 'shared made-up data and the look' },
    { title: 'Build', detail: 'one agent per option, then the automated gate' },
    { title: 'Critique and fix', detail: 'a skeptical reviewer on behavior and meaning, and every last fix re-checked' },
    { title: 'Hub', detail: 'write the content for the hub template' },
    { title: 'Audit', detail: 'every claim against the sources, then the final gate' },
  ],
}

/* Run with: Workflow({ scriptPath: "<skill>/template/workflow.js", args: {...} })
   args = the run's config (template/config.example.json) plus:
     out            absolute path of the folder new.mjs set up
     skillDir       absolute path of this skill
     deadlineEpoch  Unix seconds. Optional stages are skipped past this time, and the result says which */

const A = args || {}
for (const key of ['out', 'skillDir', 'client', 'sources', 'tracks', 'rules']) {
  if (A[key] === undefined) throw new Error(`Missing args.${key}. See the skill's Steps.`)
}
const OUT = A.out
const SKILL = A.skillDir
const OPTIONS_PER_TRACK = A.optionsPerTrack ?? 3
const CRITIC_ROUNDS = A.criticRounds ?? 1
const MAX_GATE_FIXES = 2
const DEVICES = (A.devices || ['desktop', 'ipadL', 'ipadP', 'phone']).join(' ')
const GATE = (flags = '') => `node "${SKILL}/scripts/check.mjs" "${OUT}" --json ${flags}`.trim()
const SHOT = `node "${SKILL}/scripts/shot.mjs" <absolute page path> <absolute out prefix> ${DEVICES}`
const WORK = `${OUT}/.work`

const CLIENT_RULES = A.rules.map(r => `- ${r}`).join('\n')
const RULES = `
THIS CLIENT'S RULES:
${CLIENT_RULES}

RULES FOR EVERY PROTOTYPE:
- Made-up data only. Never copy a real person, client, supplier or job from the sources onto a screen, even in a note, a label or a code comment, because viewers can read the source. If a note needs to refer to someone, use their role.
- shared/data.js is the only data source. Pages read it and never change it.
- Plain static HTML, CSS and classic (non-module) JavaScript. No build step, no npm, no CDN, no web fonts, no external requests. Must work opened straight from file:// and inside an iframe, using relative links only.
- Each page loads ../shared/theme.css, ../kit/kit.css and ../shared/proto.css (in that order), then ../shared/data.js, ../shared/domain.js if it exists, and ../shared/kit.js, and calls Kit.mountProtoLabel. That gives it the persistent prototype label and Reset demo. <html data-mode="light"> and <body data-kit>.
- The look is the Theme Core theme in shared/theme.css, never your own colours. Use the classes in shared/proto.css (btn, chip, card, badge-*, table, notice-*, topbar ...) and kit's bare HTML. Page CSS goes in one <style>, reads only theme vars (var(--primary), var(--card), var(--muted-foreground), var(--border), var(--tone-success-bg) ...) and sets no colour values, no :root tokens and no data-theme. --muted and --accent are surfaces, not text colours. No style="" attributes in the markup. Every <section> has an aria-label. Never edit anything in kit/.
- Really clickable. State changes on tap, and it stays in Kit.safeGet and Kit.safeSet. No dead buttons: a control that isn't built shouldn't be there.
- Works at every size in the device list without sideways page scroll. Touch targets at least 44px. Nothing depends on hover.
- Use the client's own words, in plain language. No lorem ipsum and no placeholder screens.
- Honest states matter more than the happy path: blank, missing, late, locked, offline.
- Anything not agreed with the client is labeled with Kit.ideaLabel(). Anything that would need someone's approval is labeled with Kit.onlyIfLabel(). Nothing is shown as sent or connected when it isn't. Anything AI-like is canned text through Kit.aiSample().
- Touch nothing outside ${OUT}. Send nothing to anyone. Don't commit. Don't use git stash, reset or checkout. Keep working files in ${WORK}.
`

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          shape: { type: 'string', enum: ['options', 'stages'], description: 'options = real alternatives to choose between. stages = one flow in parts; say so rather than inventing a false choice' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                slug: { type: 'string', description: 'kebab-case filename without extension' },
                name: { type: 'string' },
                concept: { type: 'string' },
                forWho: { type: 'string' },
                primaryDevice: { type: 'string', enum: ['desktop', 'ipadL', 'ipadP', 'phone'] },
                buildSpec: { type: 'string', description: 'Everything the builder needs, standing alone: screens, states, interactions, and which needs it answers, with sources' },
              },
              required: ['slug', 'name', 'concept', 'forWho', 'primaryDevice', 'buildSpec'],
            },
          },
        },
        required: ['key', 'title', 'shape', 'options'],
      },
    },
    dataNeeds: { type: 'string', description: 'What the shared made-up dataset must contain so every option works on the same records' },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'Where the sources disagree. These become open decisions, not silent choices' },
  },
  required: ['tracks', 'dataNeeds', 'conflicts'],
}

const BUILT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two plain sentences on what this option is' },
    clientSummary: { type: 'string', description: 'One plain sentence safe to show the client: no quotes, no internal reasoning' },
    answers: { type: 'array', items: { type: 'object', properties: { need: { type: 'string' }, source: { type: 'string' } }, required: ['need', 'source'] } },
    tradeoffs: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    knownGaps: { type: 'array', items: { type: 'string' } },
    demoTip: { type: 'string', description: 'The exact taps that show this option at its best, using the labels on screen' },
  },
  required: ['summary', 'clientSummary', 'answers', 'tradeoffs', 'questions', 'knownGaps', 'demoTip'],
}

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    epoch: { type: 'number' },
    failureCount: { type: 'number' },
    warningCount: { type: 'number' },
    failures: { type: 'array', items: { type: 'object' } },
    warnings: { type: 'array', items: { type: 'object' } },
  },
  required: ['ok', 'epoch', 'failureCount', 'failures'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          viewport: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['file', 'severity', 'problem', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    unresolved: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, problem: { type: 'string' }, whatISaw: { type: 'string' } }, required: ['file', 'problem', 'whatISaw'] } },
    newProblems: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, problem: { type: 'string' } }, required: ['file', 'problem'] } },
  },
  required: ['unresolved', 'newProblems'],
}

/* Run state. Nothing is dropped without saying so. */
const skipped = []
const marks = []
let lastEpoch = null

function mark(stage, gate) {
  if (gate && gate.epoch) { lastEpoch = gate.epoch; marks.push({ stage, epoch: gate.epoch }) }
}
function pastDeadline() {
  return !!(A.deadlineEpoch && lastEpoch && lastEpoch > A.deadlineEpoch)
}
function skip(what) {
  skipped.push(what)
  log(`Skipped: ${what}`)
}

/* The gate is a command, not a judgment. The agent only runs it and hands back the result. */
async function gate(label, pages, phaseName) {
  const flags = pages ? `--pages ${pages.join(',')}` : ''
  const result = await agent(`Run this command exactly once and return its JSON output in the schema. Don't fix anything, don't interpret it, and don't run anything else. The command exits 1 when there are failures; that's a normal result.

${GATE(flags)}`, { label: `gate:${label}`, phase: phaseName, schema: GATE_SCHEMA, effort: 'low' })
  if (!result) throw new Error(`The gate for ${label} returned nothing, so this run can't say whether the pages pass`)
  return result
}

/* Gate, fix, gate again. Stops at a ceiling and reports what's left instead of looping. */
async function gateAndFix(label, pages, phaseName) {
  let result = await gate(label, pages, phaseName)
  for (let i = 1; i <= MAX_GATE_FIXES && !result.ok; i++) {
    await agent(`The automated check found these failures in the prototype pages. Fix each one at its cause, then run the check yourself until it passes:

${GATE(pages ? `--pages ${pages.join(',')}` : '')}

Failures:
${JSON.stringify(result.failures, null, 1)}

Pages are in ${OUT}. Edit shared/ only if a failure is in shared/.

${RULES}

Return a short list of what you changed.`, { label: `gatefix:${label}:${i}`, phase: phaseName })
    result = await gate(`${label}:recheck${i}`, pages, phaseName)
  }
  mark(label, result)
  return result
}

phase('Brief')
const plan = await agent(`You're planning a prototype build for ${A.client}. The person running this wants real options to react to.

Purpose: ${A.purpose || 'Show the client what could be possible, based on what they actually asked for.'}

Read these first, in order:
${A.sources.map(s => `- ${s}`).join('\n')}
${A.notes ? `\nNotes from the person running this:\n${A.notes}\n` : ''}
Tracks to cover:
${A.tracks.map(t => `- ${t.key}: ${t.title}. ${t.ask || ''}`).join('\n')}

Plan up to ${OPTIONS_PER_TRACK} options per track. Each one must be buildable by one agent in about ten minutes as a clickable static page.
- Options must differ in how they work, not only in how they look. Name who each is for and which device it's best on.
- Don't force a choice that isn't real. If what the client described is one flow in parts, set the track's shape to "stages" and make each part one page.
- At least one option per track should show one set of records through different views by role, where that fits.
- Where the sources disagree, or where they name something the sources can't confirm, don't pick silently. List it in conflicts.

Write ${OUT}/BRIEF.md in plain language: what each track must answer, each option, what was left out and why, and a table of what was heard versus assumed, with sources. Then return the structured plan. Each buildSpec has to stand alone: the builder sees only the buildSpec, the rules and the shared files.

${RULES}`, { label: 'brief', phase: 'Brief', model: A.planModel || 'fable', schema: PLAN_SCHEMA })

if (!plan) throw new Error('The brief agent returned nothing')
const optionCount = plan.tracks.reduce((n, t) => n + t.options.length, 0)
log(`Brief: ${plan.tracks.length} tracks, ${optionCount} options, ${plan.conflicts.length} conflicts in the sources`)

phase('Foundation')
await agent(`Set up the shared foundation in ${OUT}/shared/. theme.css, proto.css and kit.js are already there, and the Theme Core kit is in ${OUT}/kit/. Read them, and ${OUT}/BRIEF.md.

1. Write shared/data.js: one global, window.PROTO_DATA = { meta: {...}, ... }, holding made-up records every option shares, so the same job or person reads the same everywhere. meta needs: slug ("${A.slug || 'demo'}"), prototypeLabel (${JSON.stringify(A.prototypeLabel || 'Prototype. Made-up data. Not connected to anything.')}), ideaLabel, onlyIfLabel, aiOffLabel and sourceLabel. It must cover: ${plan.dataNeeds}
2. If several pages will need the same client-specific logic, put it in shared/domain.js (classic script, loaded after data.js and before kit.js, extending window.PROTO_DOMAIN). Otherwise skip it.
3. Leave the look alone: it is the theme imported by shared/theme.css (config.theme), and no colours or tokens get added anywhere.${A.look ? ` If this note asks for something the theme can't give, say so in shared/README.md: ${A.look}` : ''}
4. Write shared/README.md: a short list of what's in the data, for the builders.

Make the names plainly fictional, and don't reuse any real name from the sources.

${RULES}

Return one paragraph on the data available.`, { label: 'foundation', phase: 'Foundation' })

async function buildOption(track, o) {
  const built = await agent(`Build this prototype as ${OUT}/${track.key}/${o.slug}.html.

Option: ${o.name}
Concept: ${o.concept}
For: ${o.forWho}
Best on: ${o.primaryDevice}

Spec:
${o.buildSpec}

Read ${OUT}/BRIEF.md for context, then ${OUT}/shared/README.md, data.js and kit.js, and proto.css (the classes to use). Use the shared data as it is.

Make it feel like a real tool someone would use, not a slide. Check your work:
1. ${SHOT} with a prefix under ${WORK}/shots/, then read the images and fix what looks wrong.
2. ${GATE(`--pages ${track.key}/${o.slug}.html`)} and fix every failure. Look at possibly-dead-control warnings too.

${RULES}

Return the structured summary. "answers" lists which of the client's needs this answers, each with its source. Be honest in knownGaps.`,
    { label: `build:${track.key}/${o.slug}`, phase: 'Build', schema: BUILT_SCHEMA })
  if (!built) { skip(`${track.key}/${o.slug}: the builder returned nothing, so this option wasn't built`); return null }
  return { ...o, track: track.key, built }
}

async function critiqueTrack(track, pages) {
  const files = pages.map(p => `${OUT}/${p}`)
  let lastFixed = []
  let rounds = 0
  for (let round = 1; round <= CRITIC_ROUNDS; round++) {
    if (round > 1 && pastDeadline()) { skip(`${track.key}: critique round ${round} (past the time limit)`); break }
    rounds = round
    const critique = await agent(`You're a skeptical reviewer of prototypes for "${track.title}" at ${A.client}. Round ${round}. Don't edit files.

Pages:
${files.join('\n')}

Context: ${OUT}/BRIEF.md and:
${A.sources.slice(0, 3).map(s => `- ${s}`).join('\n')}

An automated check already covers banned names, external requests, sideways scroll, console errors and missing files, so don't spend time there. Your job is what it can't see. Use ${SHOT} with a prefix under ${WORK}/shots/critic-${track.key}-r${round}-, and click through the main flow on each page. For clicks, write a short script in ${WORK}/ using "${SKILL}/scripts/_cdp.mjs", then delete it.

Find real problems:
- A button that claims something the page doesn't do, or a state that contradicts itself.
- Doesn't answer what the client asked for, per the brief. Would the client be confused in the first ten seconds?
- Options that are really the same thing with different paint.
- Anything stated as settled that the sources left open. Anything invented and presented as fact.
- A breach of these rules, which is always high severity:
${RULES}

Report only what you actually saw. high = breaks the demo, misleads, or breaks a rule. medium = a clear usability or fidelity problem. low = polish.`,
      { label: `critic:${track.key}:r${round}`, phase: 'Critique and fix', schema: FINDINGS_SCHEMA })
    const worth = (critique?.findings || []).filter(f => f.severity !== 'low')
    const lows = (critique?.findings || []).filter(f => f.severity === 'low').length
    log(`${track.key} round ${round}: ${worth.filter(f => f.severity === 'high').length} high, ${worth.filter(f => f.severity === 'medium').length} medium, ${lows} low (lows aren't fixed)`)
    if (!worth.length) { lastFixed = []; break }

    await agent(`Fix these findings in the "${track.title}" pages. Edit only those pages, not shared/, unless a shared file truly needs a change, and then keep it strictly additive. Check each fix with ${SHOT} and with:
${GATE(`--pages ${pages.join(',')}`)}

Findings:
${JSON.stringify(worth, null, 1)}

${RULES}

Return a short list of what you fixed and anything you couldn't.`,
      { label: `fix:${track.key}:r${round}`, phase: 'Critique and fix' })
    lastFixed = worth
    await gateAndFix(`${track.key}:r${round}`, pages, 'Critique and fix')
  }
  if (CRITIC_ROUNDS === 0) skip(`${track.key}: critique (criticRounds is 0, so only the automated gate looked at these pages)`)

  /* A fix nobody re-checks is a guess. */
  if (lastFixed.length) {
    const verified = await agent(`These findings were just fixed in the "${track.title}" pages. Check each one by actually doing what it describes, and look for anything the fixes broke nearby. Don't edit anything.

Pages:
${files.join('\n')}

Findings that were fixed:
${JSON.stringify(lastFixed, null, 1)}

Use ${SHOT} with a prefix under ${WORK}/shots/verify-${track.key}-, and a short script using "${SKILL}/scripts/_cdp.mjs" for clicks (delete it afterwards). Report only what you saw.`,
      { label: `verify:${track.key}`, phase: 'Critique and fix', schema: VERIFY_SCHEMA })
    return { rounds, unresolved: verified?.unresolved || [], newProblems: verified?.newProblems || [], verified: !!verified }
  }
  return { rounds, unresolved: [], newProblems: [], verified: true }
}

async function runTrack(track) {
  const built = (await parallel(track.options.map(o => () => buildOption(track, o)))).filter(Boolean)
  if (!built.length) { skip(`${track.key}: nothing was built`); return null }
  const pages = built.map(b => `${track.key}/${b.slug}.html`)
  const gated = await gateAndFix(`${track.key}:build`, pages, 'Build')
  const review = await critiqueTrack(track, pages)
  return { key: track.key, title: track.title, shape: track.shape, options: built, gated: gated.ok, review }
}

phase('Build')
const tracks = (await pipeline(plan.tracks, t => runTrack(t))).filter(Boolean)
if (!tracks.length) throw new Error('No track was built')

phase('Hub')
const manifest = tracks.map(t => ({
  key: t.key, title: t.title, shape: t.shape,
  options: t.options.map(o => ({ slug: o.slug, name: o.name, concept: o.concept, forWho: o.forWho, primaryDevice: o.primaryDevice, file: `${t.key}/${o.slug}.html`, ...o.built })),
  unresolved: t.review.unresolved, newProblems: t.review.newProblems,
}))
await agent(`Write ${OUT}/hub-data.js, the content for the review hub. Don't touch index.html: it's a finished template that reads this file. Follow the shape in ${SKILL}/template/hub-data.example.js exactly.

The hub is internal, for the person running this to review on desktop and iPad before anyone at ${A.client} sees it. It may name people and quote them, and it must say it stays internal.

Manifest of what was built:
${JSON.stringify(manifest, null, 1)}

Conflicts in the sources, each of which must appear in decisions:
${JSON.stringify(plan.conflicts, null, 1)}

- meta: client ${JSON.stringify(A.client)}, title ${JSON.stringify(A.title || A.client)}, slug ${JSON.stringify(A.slug || 'demo')}, devices [${(A.devices || ['desktop', 'ipadL', 'ipadP', 'phone']).map(d => `"${d}"`).join(', ')}], and an intro that says what this is and what's next.
- Copy each track's shape from the manifest. For shape "stages", say plainly in the note that it's one flow in parts rather than a choice, and set each option's "part" field ("Part 1").
- Anything in unresolved or newProblems goes in that option's gaps, plainly, and also in openFindings as { slug, problem }. Each one blocks the sign-off until the reviewer accepts it as a known gap.
- checklist: things to do before showing this to the client, each one a thing a person can tick off. Don't list a real-device check: the hub adds one.
- decisions: what's still open, who answers it, and why it matters, grouped by track. "who" is only the person or role, in a few words, spelled the same way every time, because the client's agenda groups by that exact text. Put any explanation in "why".
- Every claim needs a source from BRIEF.md. If you can't source it, call it assumed.

Then run this and fix what it finds in hub-data.js:
${GATE()}

Return a short summary.`, { label: 'hub-data', phase: 'Hub' })

phase('Audit')
const audit = await agent(`Audit ${OUT} for accuracy and fix what you find. You're the last check before this is reviewed. The automated check handles names and technical faults, so spend your time on truth.

1. Check every quote and claim in hub-data.js and BRIEF.md against the sources:
${A.sources.map(s => `- ${s}`).join('\n')}
Fix anything misattributed, and mark assumptions as assumed.
2. Check what the prototype pages state as fact against the same sources, including anything that says where a value comes from, or says a process works a certain way.
3. Try each option's demoTip. Fix any that doesn't work as written.
4. Read the rules and look for breaches a word search couldn't catch:
${RULES}

Return, in plain sentences, what you found and fixed, and anything left that the reviewer should know.`, { label: 'audit', phase: 'Audit' })

const finalGate = await gateAndFix('final', null, 'Audit')

return {
  brief: `${OUT}/BRIEF.md`,
  hub: `${OUT}/index.html`,
  passedFinalGate: finalGate.ok,
  finalFailures: finalGate.failures,
  warnings: finalGate.warnings || [],
  conflicts: plan.conflicts,
  unresolved: tracks.flatMap(t => [...t.review.unresolved, ...t.review.newProblems]),
  unverifiedTracks: tracks.filter(t => !t.review.verified).map(t => t.key),
  skipped,
  stageMarks: marks,
  pastDeadline: pastDeadline(),
  audit,
}
