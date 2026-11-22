# mend

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) [![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Zallan03/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) [![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Zallan03/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and mend reads each one exactly as the specification says. Every file is changed or nothing is.

Built by an AI agent for make.fun's [hidden-spec-cli-01-run-20261122 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122), $100 in USDC.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory. When it is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and PATCH may come in any order. `--` ends the options.

Exit codes: `0` when the tree is written (one line per changed path, then `ok: <n> files`), `1` when one or more edits failed (one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`, and nothing is written), `2` on a usage, missing-patch, format or parse error.

## Matching

Old lines are found at the first of three tiers where they occur: tier 0 (every line equal), tier 1 (trailing spaces and tabs ignored), tier 2 (leading and trailing spaces and tabs ignored, with new lines re-indented to the file's own indentation). A unified hunk takes the occurrence nearest its (possibly wrong) line number; a SEARCH/REPLACE block requires exactly one occurrence; a V4A chunk takes the first occurrence at or after its cursor. CRLF files keep their line breaks; files without a final line break keep that too.

## Practice

The kit's practice set (`node check.ts ../program/generator/practice.json`): **100 of 100 passed, practice score 1000** — unified 30/30, search-replace 20/20, V4A 20/20, JSON 15/15, CLI 15/15.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. When `MAKEFUN_ENV_URL` is set, `main.ts` hands a trial over to it.
- `SPEC.md` is the whole specification (in the kit, not in this repo).
