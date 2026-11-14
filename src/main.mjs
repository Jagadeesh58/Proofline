const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 16)) {
  process.stderr.write(`This project needs Node 22.16 or later (found ${process.versions.node}). Please upgrade.\n`);
  process.exit(1);
}

const [{ createServer }, { config }] = await Promise.all([
  import('./http/server.mjs'),
  import('./config.mjs'),
]);

const logRuntimeError = (label, error) => {
  const message = String(error?.message || error || 'Unknown runtime error').replace(/[\r\n]+/g, ' ').slice(0, 300);
  process.stderr.write(`${label}: ${message}\n`);
};

const server = createServer();

const shutdown = (code = 1) => {
  try {
    server.close(() => process.exit(code));
  } catch {
    process.exit(code);
  }
  setTimeout(() => process.exit(code), 5000).unref();
};

process.on('unhandledRejection', (reason) => {
  logRuntimeError('Unhandled rejection', reason);
  shutdown(1);
});
process.on('uncaughtException', (error) => {
  logRuntimeError('Fatal uncaught exception; terminating process', error);
  shutdown(1);
});

server.listen(config.port, config.host, () => {
  process.stdout.write(`Proofline running at http://${config.host}:${config.port}\n`);
  const searchDesc = config.searchBackend === 'replay'
    ? 'synthetic replay corpus'
    : (config.tavilyKey ? 'Tavily configured' : 'Tavily missing');
  process.stdout.write(`Gemini: ${config.geminiKey ? 'configured' : 'missing'} | Search: ${searchDesc}\n`);
  if (config.host === '0.0.0.0') {
    process.stdout.write(
      'Warning: bound to all interfaces. Do not expose this demo publicly without authentication and TLS.\n'
    );
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
