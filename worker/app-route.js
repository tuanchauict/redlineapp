// Puts the web app at `/app` on the landing page's hostname.
//
// Two Pages projects, `redline` (the landing page) and `redline-app` (the web app), can each take a
// hostname but cannot split one by path. So this Worker sits on the route `<hostname>/app*` and
// answers it from the web app's project, and everything else on the hostname goes on to the
// landing page as it did. Not deployed by any workflow: see `docs/building.md`, Publishing the web
// app, which also says why and gives the command.
//
// Three things it does that a bare proxy would not:
//
// - `/app` becomes `/app/`. The page loads its own files by relative URL (`./vendor/...`), and
//   from `/app` those resolve against `/`, where there is nothing. Pages makes the same
//   redirect for a directory, but the browser is talking to this Worker and never sees Pages'.
// - A redirect Pages sends is rewritten to stay under `/app`. Its `Location` is a path on its own
//   origin, and left alone it would leave the app for the landing page.
// - A path that merely starts with `app` (`/apple.png`, `/application`) is not the app's, and is
//   passed on untouched. The route has to be `app*` to catch `/app?x` as well as `/app/x`, so the
//   exact match is made here.
//
// `APP_ORIGIN` is the project's own `pages.dev` address, which is not always `<project>.pages.dev`
// -- the subdomain is global, so a taken name gets a suffix -- and so it is given at deploy time
// rather than guessed in the repository.

const PREFIX = '/app';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const inApp = url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`);
    if (!inApp) return fetch(request);

    if (!env.APP_ORIGIN) return new Response('APP_ORIGIN is not set', { status: 500 });
    const app = new URL(env.APP_ORIGIN);

    if (url.pathname === PREFIX) {
      return Response.redirect(`${url.origin}${PREFIX}/${url.search}`, 308);
    }

    // The path is assigned, not resolved against the origin: `/app//example.com` resolved as a
    // relative URL is another host, and assigned it is only an odd path on this one.
    const target = new URL(app);
    target.pathname = url.pathname.slice(PREFIX.length);
    target.search = url.search;

    const res = await fetch(new Request(target, request), { redirect: 'manual' });

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      const to = new URL(location, target);
      if (to.origin === app.origin) {
        const out = new Response(res.body, res);
        out.headers.set('location', `${PREFIX}${to.pathname}${to.search}${to.hash}`);
        return out;
      }
    }
    return res;
  },
};
