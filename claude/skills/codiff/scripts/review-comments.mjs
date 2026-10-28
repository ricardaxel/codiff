#!/usr/bin/env node

// Review comment handoff for the Codiff `codiff` skill. Codiff writes the open
// review comments of a repository to `<git dir>/codiff/review-comments.json`
// on the machine that holds it, including the host of a remote repository.
// This script lists them and reports handled comments back to Codiff. It only
// needs Node.js and Git, so it also works where Codiff itself is not installed.
//
// Usage:
//   node scripts/review-comments.mjs [list] [--repo <path>]
//   node scripts/review-comments.mjs resolve <comment-id> [--declined] [--reply <text>] [--repo <path>]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// Codiff labels the reply with the agent that handled the comment.
const agent = 'claude';
const commentIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

const fail = (message) => {
  process.stderr.write(`review-comments: ${message}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'list';
let repository = process.cwd();
let reply = '';
let declined = false;
const positional = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--repo') {
    repository = args[++index] || fail('expected a path after --repo.');
  } else if (arg === '--reply') {
    reply = args[++index] ?? fail('expected text after --reply.');
  } else if (arg === '--declined') {
    declined = true;
  } else {
    positional.push(arg);
  }
}

const git = spawnSync('git', ['-C', repository, 'rev-parse', '--absolute-git-dir'], {
  encoding: 'utf8',
});
if (git.error || git.status !== 0) {
  fail(`not a Git repository: ${repository}`);
}
const handoffDirectory = join(git.stdout.trim(), 'codiff');
const resolvedDirectory = join(handoffDirectory, 'resolved');

if (command === 'list') {
  const path = join(handoffDirectory, 'review-comments.json');
  let document = null;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Codiff removes the file when no comments are waiting.
  }
  const comments = (Array.isArray(document?.comments) ? document.comments : []).filter(
    (comment) =>
      typeof comment?.id === 'string' && !existsSync(join(resolvedDirectory, `${comment.id}.json`)),
  );
  if (comments.length === 0) {
    process.stdout.write(
      'No open Codiff review comments for this repository. Write comments in Codiff first; Codiff must stay open.\n',
    );
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify({ ...document, comments }, null, 2)}\n`);
  process.exit(0);
}

if (command === 'resolve') {
  const [id] = positional;
  if (!id || !commentIdPattern.test(id)) {
    fail('expected resolve <comment-id>.');
  }
  mkdirSync(resolvedDirectory, { recursive: true });
  const temporaryPath = join(resolvedDirectory, `.${id}.${process.pid}.tmp`);
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({
      agent,
      id,
      reply: reply.trim(),
      status: declined ? 'declined' : 'applied',
    })}\n`,
  );
  renameSync(temporaryPath, join(resolvedDirectory, `${id}.json`));
  process.stdout.write(`CODIFF_REVIEW_COMMENT_RESOLVED ${JSON.stringify({ id })}\n`);
  process.exit(0);
}

fail(`unknown command "${command}". Use list or resolve.`);
