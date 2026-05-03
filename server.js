const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const root = __dirname;
const port = 4173;
const host = '127.0.0.1';
const appUrl = `http://${host}:${port}`;
const shouldOpen = process.argv.includes('--open');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4173');
  let filePath = path.join(root, decodeURIComponent(url.pathname));
  if (url.pathname === '/') filePath = path.join(root, 'index.html');
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(resolved)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`MotoRoute Studio is already running at ${appUrl}`);
    if (shouldOpen) openBrowser(appUrl);
    return;
  }
  console.error(error.message);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`MotoRoute Studio: ${appUrl}`);
  if (shouldOpen) openBrowser(appUrl);
});

function openBrowser(url) {
  exec(`start "" "${url}"`, { shell: 'cmd.exe' });
}
