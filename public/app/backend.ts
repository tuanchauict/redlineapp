// The page's one backend.
//
// Everything the page asks of what is behind it goes through here -- see
// public/backend.ts, which is also where the choice between a server and a reader
// held in the page is made. The id is read per call rather than passed in,
// because it is assigned by the other side and can change under the page.
//
// A module of its own, under every viewmodel, so that each can ask what it needs of it without
// main.ts handing it down. The await is the module's: whatever imports this waits for the backend
// to be built before it runs.
import { createBackend } from '../backend.js';
import { state } from './state.js';

export const backend = await createBackend({ docId: () => state.docId });
