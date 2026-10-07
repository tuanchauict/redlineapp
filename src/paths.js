// Paths as a person reads them rather than as the filesystem writes them.
//
// The rule itself lives in ./platform.js, where both hosts can reach it. This
// is the node convenience: the home directory is already known here, so it need
// not be passed in. Two copies of the rule would be one copy too many — a
// window title and a document's own subtitle disagreeing about where a file is
// would look like a bug in the reader, because it would be one.
import os from 'node:os';
import { homeRelative as rel } from './platform.js';

/**
 * A directory the way a title bar should show it: `~` for home, everything
 * else left exactly as it is.
 */
export function homeRelative(p) {
  return rel(p, os.homedir());
}
