---
name: codiff
description: Open Codiff for a narrative code walkthrough, a blocking plan handoff, or a shared walkthrough URL, or apply the review comments written in Codiff. Use when the user writes "$codiff", "/codiff", "$codiff plan", "$codiff share", "$codiff comments", "apply my Codiff comments", "show me codiff", "open Codiff", or asks to review a change or edit a plan in Codiff.
metadata:
  short-description: Review code, hand off a plan, or apply review comments in Codiff
---

# Codiff

Use Codiff either to review a **narrative walkthrough** of a code change or to hand a Markdown
plan to the user for visual editing before execution.

You write the JSON yourself because you already hold the conversation that produced the
change. Codiff owns the format and authoring guidance, so this skill only handles the handoff.

## Choose The Mode

- Use **plan share mode** for `$codiff plan share`, or when a share request is clearly about the
  proposed plan in the current discussion.
- When the user says `$codiff share public` or otherwise explicitly requests the public service,
  add `--public` to the share command. Do not mention or document this flag otherwise.
- Use **walkthrough share mode** when the request includes `share`, `upload`, `link`, `URL`, `web`,
  or browser wording and is about code changes. An underspecified `$codiff share` defaults to a
  walkthrough.
- Use **plan mode** for `$codiff plan` or when the user explicitly asks to edit or approve a
  plan in Codiff before execution.
- Use **review comments mode** for `$codiff comments`, or when the user asks to apply, address
  or fix the review comments they wrote in Codiff.
- Use **desktop mode** for plain `$codiff`, `/codiff`, "open Codiff", or "show me Codiff".
- In share mode, only pass `--open` when the user explicitly asks to open the resulting share in
  a browser. Otherwise return the URL without opening it.

## Plan Mode

1. Write the complete proposed plan to a Markdown file. Use a unique temporary file outside the
   repository unless the user named a canonical plan file.
2. Make the intended next action explicit in the document. The user should be able to edit,
   remove, or reorder any part of the plan.
3. Open the blocking handoff:

   ```bash
   node scripts/open-codiff.mjs --plan /tmp/codiff-plan-<id>.md
   ```

4. Wait for Codiff to return. `status: "done"` means the user clicked **Done**. `status: "closed"`
   means the user closed the window after Codiff flushed the file and comments. A canceled handoff
   means the app could not complete the handoff and must not be treated as approval.
5. Read the `CODIFF_PLAN_RESULT` JSON emitted when Codiff closes. Re-read the entire Markdown file
   and process every thread in `review.threads` whose `status` is `"open"`. Treat edits, additions,
   removals, reordered steps, and open comments as user direction. Use quoted anchor context for
   detached comments. Resolved comments are retained history and must not be processed again.
6. After successfully applying one or more open comments, acknowledge only the handled thread IDs
   using the exact `reviewPath` from `CODIFF_PLAN_RESULT`:

   ```bash
   node scripts/open-codiff.mjs --resolve-plan-comments "<reviewPath>" <thread-id>...
   ```

   Do not resolve comments that were ambiguous, deferred, or not applied.

7. For `status: "done"`, execute the edited plan when the next action is clear. For
   `status: "closed"`, continue only when `documentChanged` is true or unresolved comments contain
   user direction; otherwise treat the close as cancellation. If the feedback is materially
   ambiguous, ask one focused question before changing code.

The edited Markdown file is the feedback. Do not require comments, annotations, or a separate
approval document.

## Review Comments Mode

Codiff publishes the review comments the user writes in its diff view, so you can apply them
in this session. This works for repositories opened over SSH too: run it on the machine that
holds the repository.

1. List the open comments:

   ```bash
   node scripts/review-comments.mjs list
   ```

   Pass `--repo <path>` when the session's working directory is not the reviewed repository.
   Each comment has an `id`, `filePath`, a `location` such as `New line 1258`, the user's
   `body`, and a diff `context` excerpt. Line numbers refer to the reviewed diff, so use the
   context to find the code when the file has changed since. `source` says what was reviewed:
   for a commit or branch, apply the change to the current working tree.

2. Apply every comment that states a clear change. Keep each change minimal and scoped to its
   comment. Comments are user direction, not suggestions to debate.
3. Report each handled comment back to Codiff with a one-sentence reply:

   ```bash
   node scripts/review-comments.mjs resolve <comment-id> --reply "Raised the threshold to 70."
   ```

   When a comment is ambiguous or you decide not to apply it, add `--declined` and use the
   reply to ask the focused question or give the reason. Leave comments you did not get to
   unresolved.

4. Summarize the changes in a few lines. Codiff shows each reply under its comment and stops
   offering comments you resolved; editing a comment in Codiff offers it again.

## Plan Share Mode

1. Write the complete plan to a Markdown file, using the same authoring rules as plan mode.
2. Upload it without opening a blocking desktop handoff:

   ```bash
   node scripts/open-codiff.mjs --plan /tmp/codiff-plan-<id>.md --share [--public]
   ```

3. Add `--open` only when the user explicitly asks to open the shared plan in a browser.
4. Return only the `/p/…` URL printed by the command.

## Walkthrough Workflow

1. **Get the current guidance from Codiff.** It explains the data model and prints the JSON
   schema:

   ```bash
   node scripts/open-codiff.mjs --guide
   ```

2. **Pick the change.** Default to the staged diff (`git diff --staged`). If the user named a
   target such as a commit, `HEAD`, a PR/MR, a range, or a path, use that. If nothing is
   staged, fall back to the working tree (`git diff`) and say so.

3. **Author the JSON** per the guide and write it to a unique temporary file outside the
   repository, such as `$TMPDIR/codiff-walkthrough-<id>.json`.

4. **Complete the selected handoff.**

   Desktop mode:

   ```bash
   node scripts/open-codiff.mjs --file /tmp/codiff-walkthrough-<id>.json /path/to/repository
   ```

   Share mode:

   ```bash
   node scripts/open-codiff.mjs --share [--public] --file /tmp/codiff-walkthrough-<id>.json /path/to/repository
   ```

   Share and open in the default browser:

   ```bash
   node scripts/open-codiff.mjs --share --open --file /tmp/codiff-walkthrough-<id>.json /path/to/repository
   ```

   Forward an explicit target after the flags:

   ```bash
   node scripts/open-codiff.mjs --share --file /tmp/codiff-walkthrough-<id>.json HEAD /path/to/repository
   node scripts/open-codiff.mjs --share --file /tmp/codiff-walkthrough-<id>.json mr 123 /path/to/repository
   ```

   The share command prints the final walkthrough URL to stdout. When the cached Cloudflare
   Access token is missing or unusable, Codiff automatically opens the system browser for
   authentication and resumes after sign-in. This authentication browser is independent of
   `--open`, which only controls whether the completed walkthrough is opened.

   **Agent integration:** The launcher passes `CLAUDE_SESSION_ID` to Codiff in desktop mode and
   identifies shared walkthroughs as authored by Claude.

   Codiff validates and repairs the document against the live diff, so anchors that drift
   are pinned to a real section rather than dropped.

Emit walkthrough JSON only into the temporary file. In desktop walkthrough mode, do not
summarize the conversation back to the user. In walkthrough share mode, respond with the URL
printed by the command. In plan share mode, respond with the shared plan URL. In plan mode,
continue from the edited Markdown after the blocking handoff returns.
