import http from 'node:http';

/** Routes of the API. Add yours here (or switch to a framework when it grows). */
export function createApp() {
  return http.createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/health') return json(200, { ok: true });
    if (req.url === '/') return json(200, { name: '{{NAME}}' });
    return json(404, { error: 'not found' });
  });
}
