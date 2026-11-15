#!/usr/bin/env node
// Is the live backend running the expected code? Exit 0 when the live commit equals the expected
// commit, or when GitHub's compare shows no file differences between them (e.g. a pull request's head
// commit is live and main is the merge commit of that same pull request). Exit 1 otherwise (different
// code is live, or the comparison could not be made). Prints one line saying which case applied.
// Usage: node scripts/live-commit-matches.mjs <live-sha> <expected-sha>   (GITHUB_REPOSITORY, GH_TOKEN)
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
// 'identical', or main ahead of live only by commits that change no files (merge commits).
export function sameCode(compare) {
  return Boolean(compare) && ['identical', 'ahead'].includes(compare.status) && Array.isArray(compare.files) && compare.files.length === 0;
}

export async function liveCommitMatches(liveRaw, expectedRaw, { repo = process.env.GITHUB_REPOSITORY || 'Sigict/athlyrax-backend', token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '', fetchImpl = fetch } = {}) {
  const live = String(liveRaw || '').trim().toLowerCase(); const expected = String(expectedRaw || '').trim().toLowerCase();
  if (!SHA.test(live) || !SHA.test(expected)) return { ok: false, line: `COMMIT_CHECK invalid live=${live || 'missing'} expected=${expected || 'missing'}` };
  if (live === expected) return { ok: true, line: `COMMIT_CHECK exact ${live}` };
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/compare/${live}...${expected}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'athlyrax-production-health', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, line: `COMMIT_CHECK compare_failed http_${r.status} live=${live} expected=${expected}` };
    if (sameCode(body)) return { ok: true, line: `COMMIT_CHECK same_code live=${live} expected=${expected} (expected is ${body.ahead_by} commit(s) ahead with no file changes)` };
    return { ok: false, line: `COMMIT_CHECK different_code live=${live} expected=${expected} status=${body.status} files=${(body.files || []).length}` };
  } catch (error) { return { ok: false, line: `COMMIT_CHECK compare_error ${String(error?.message || error).slice(0, 120)}` }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await liveCommitMatches(process.argv[2], process.argv[3]);
  console.log(out.line);
  process.exit(out.ok ? 0 : 1);
}
