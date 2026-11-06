'use strict';
// Serves index.html on http://localhost:8080
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT || 8080);
http.createServer((req, res) => {
  const file = path.join(__dirname, 'index.html');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`compare page: http://localhost:${PORT}`));
