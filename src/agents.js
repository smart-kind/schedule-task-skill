'use strict';
// agents.js — the coding-agent router (port of automation/coding-agent.sh).
// One profile per coding CLI (claude / kimi), each encapsulating the four things
// the runner must never see: invocation flags, session-resume flags, session-id
// extraction, and usage-limit detection. The CLI's stream-json goes to stdout
// verbatim (captured as attempt-<n>.jsonl by the caller) while we parse it
// line-by-line — far more rigorous than the bash-era text greps.
//
// invoke() returns a structured result (no exit-code guessing by the caller):
//   { rc, sessionId, resetEpoch, sentinelHit, stderr }
// Exit-code contract (unchanged): 0 = normal exit (sentinel decides completion);
// 75 = usage/session/rate limit (caller parks, then resumes); anything else is
// ambiguous (caller applies its retry policy).

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');

const CLAUDE_LIMIT_RE =
  /usage limit|rate limit|session limit|limit reached|hit your (usage|session) limit|resets? (at|[0-9])/i;
const KIMI_LIMIT_RE = /APIProviderRateLimitError|"status_code":429|rate limit/;
const EPOCH_RE = /\b\d{10}\b/;
const CLOCK_RE = /resets?\s+(\d{1,2})\s?(am|pm)/i;

function claudeArgs(mode, model, sessionId, prompt) {
  const args = ['-p', prompt, '--model', model, '--fallback-model', 'sonnet',
    '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
  if (mode === 'resume') args.push('--resume', sessionId);
  return args;
}

function kimiArgs(mode, model, sessionId, prompt) {
  const args = ['-p', prompt, '-m', model, '--output-format', 'stream-json'];
  if (mode === 'resume') args.push('-S', sessionId);
  return args;
}

// claude: the opening system event. kimi: the session.resume_hint meta event.
function extractSessionId(agent, jsonLines) {
  const want = agent === 'claude' ? 'system' : 'meta';
  for (const line of jsonLines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && obj.type === want && obj.session_id) return String(obj.session_id);
  }
  return null;
}

// 10-digit epoch OR a clock phrase like "resets 11am (UTC)" resolved to the
// today/tomorrow UTC instant. Returns 0 when nothing parseable.
function parseResetEpoch(text, nowSeconds) {
  const epMatch = EPOCH_RE.exec(text);
  if (epMatch) {
    const ep = Number(epMatch[0]);
    if (ep > nowSeconds && ep < nowSeconds + 700000) return ep;
  }
  const cl = CLOCK_RE.exec(text);
  if (!cl) return 0;
  let hour = Number(cl[1]);
  const meridiem = cl[2].toLowerCase();
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const now = new Date(nowSeconds * 1000);
  const cand = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0) / 1000;
  const epoch = cand <= nowSeconds ? cand + 86400 : cand;
  return epoch > nowSeconds && epoch < nowSeconds + 700000 ? epoch : 0;
}

/**
 * Run one CLI attempt. Writes the stream-json stdout verbatim to attemptFile.
 *
 * @param {object} opts
 *   agent        'claude' | 'kimi'
 *   mode         'fresh' | 'resume'
 *   model        model alias
 *   sessionId    session id (resume only)
 *   prompt       prompt text
 *   cwd          worktree dir
 *   attemptFile  path to append the raw stream to
 *   sentinel     TASK_DONE sentinel prefix, e.g. '[[TASK_DONE T260805-01'
 *   config       readConfig() result (claudeBin / kimiBin)
 * @returns {Promise<{rc:number, sessionId:string|null, resetEpoch:number,
 *          sentinelHit:boolean, stderr:string}>}
 */
function invoke({ agent, mode, model, sessionId, prompt, cwd, attemptFile, sentinel, config }) {
  const bin = agent === 'claude' ? config.claudeBin : config.kimiBin;
  const args = agent === 'claude'
    ? claudeArgs(mode, model, sessionId, prompt)
    : kimiArgs(mode, model, sessionId, prompt);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, HOME: process.env.HOME },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ rc: 127, sessionId: null, resetEpoch: 0, sentinelHit: false, stderr: String(err) });
      return;
    }

    let raw = '';          // full stdout text — limit/sentinel patterns live anywhere in it
    let stderr = '';
    const jsonLines = [];  // parsed for session-id extraction only
    const outStream = fs.createWriteStream(attemptFile, { flags: 'w' }); // one file per attempt

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      jsonLines.push(line);
    });
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      raw += text;
      outStream.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      outStream.end();
      rl.close();
      resolve({ rc: 127, sessionId: null, resetEpoch: 0, sentinelHit: false, stderr: String(err) });
    });
    child.on('close', (code) => {
      outStream.end();
      rl.close();
      const now = Math.floor(Date.now() / 1000);
      const sessionIdOut = extractSessionId(agent, jsonLines);
      const haystack = `${stderr}\n${raw}`;
      const limitHit = agent === 'claude' ? CLAUDE_LIMIT_RE.test(haystack) : KIMI_LIMIT_RE.test(haystack);
      const resetEpoch = limitHit && agent === 'claude' ? parseResetEpoch(haystack, now) : 0;
      resolve({
        rc: limitHit ? 75 : code,
        sessionId: sessionIdOut,
        resetEpoch,
        sentinelHit: Boolean(sentinel) && raw.includes(sentinel),
        stderr,
      });
    });
  });
}

module.exports = { invoke, parseResetEpoch, extractSessionId };
