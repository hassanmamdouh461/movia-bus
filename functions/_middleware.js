/* Hostname routing for one Pages project that answers on several names:
   how.<domain>/  ->  the "how it works" page (/demo-live/). Every other host and every other path goes on unchanged.
   _routes.json limits this function to "/" and "/api/*", so static files are still served directly by Pages. */
export async function onRequest({ request, next, env }) {
  const url = new URL(request.url);
  if (url.pathname === '/' && url.hostname.split('.')[0] === 'how') {
    const page = await env.ASSETS.fetch(new Request(new URL('/demo-live/', url), request));
    return page;
  }
  return next();
}
