// Optional git baseline: compare the file against a committed revision, and
// seed a document's history from the commits that touched it.
//
// Every call goes through the platform's spawn (see ./platform.js), because git
// is the host's to find — it is on a PATH the webview knows nothing about. The
// two calls that used to be synchronous are not any more, which is why opening
// a document is now something to await.

// A record separator no commit subject can contain, so one line per commit
// stays one line per commit.
const SEP = '\x1f';

const TIMEOUT_MS = 15000;

/** The git reader for one host. */
export function createGit(platform) {
  /** stdout, or null if git said no — which it does for anything untracked. */
  const git = async (args, cwd) => {
    const r = await platform.spawn('git', args, { cwd, timeout: TIMEOUT_MS });
    return r.code === 0 ? r.stdout : null;
  };

  return {
    /** { root, relPath } when the file is tracked by git, otherwise null. */
    async info(absPath) {
      const cwd = platform.dirname(absPath);
      // Ask git for the repo-relative path rather than deriving it from the
      // toplevel: on macOS the two can disagree when the path crosses a symlink
      // (/var vs /private/var), and a relative path then escapes the repo.
      const rel = (
        await git(
          ['ls-files', '--full-name', '--error-unmatch', '--', platform.basename(absPath)],
          cwd,
        )
      )
        ?.split('\n')[0]
        .trim();
      if (!rel) return null;
      const root = (await git(['rev-parse', '--show-toplevel'], cwd))?.trim();
      return root ? { root, relPath: rel } : null;
    },

    /** Contents of the file at `rev`, or null if it does not exist there. */
    show(info, rev) {
      if (!info) return Promise.resolve(null);
      return git(['show', `${rev}:${info.relPath}`], info.root);
    },

    /**
     * The commits that touched this file, newest first:
     * `{ sha, ts, subject, relPath }`.
     *
     * `--follow` keeps the trail across renames, which means the file had a
     * different name in the older commits — so `--name-only` comes along to say
     * what that name was, and the caller reads each version by the name it had.
     *
     * Returns an empty list for everything that could go wrong: a document must
     * open whether or not git is installed, the repo is healthy, or the history
     * is reachable.
     */
    async log(info, limit = 50) {
      if (!info) return [];
      const out = await git(
        [
          'log',
          `--max-count=${limit}`,
          '--follow',
          '--name-only',
          `--format=%x00%H${SEP}%at${SEP}%s`,
          '--',
          info.relPath,
        ],
        info.root,
      );
      if (out == null) return [];

      return out
        .split('\0')
        .slice(1) // the split leaves an empty head before the first commit
        .map((chunk) => {
          const lines = chunk.split('\n').filter((l) => l !== '');
          const [sha, at, subject = ''] = (lines.shift() ?? '').split(SEP);
          return {
            sha,
            ts: Number(at) * 1000,
            subject,
            // A merge shows no file names, so fall back to the name it has now.
            relPath: lines.at(-1) ?? info.relPath,
          };
        })
        .filter((c) => c.sha && Number.isFinite(c.ts) && c.ts > 0);
    },

    /** The file's contents in one commit, under the name it had there. */
    showAt(info, sha, relPath = info?.relPath) {
      if (!info) return Promise.resolve(null);
      return git(['show', `${sha}:${relPath}`], info.root);
    },
  };
}
