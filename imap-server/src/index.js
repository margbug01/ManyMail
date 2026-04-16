const tls = require('tls');
const net = require('net');
const fs = require('fs');
const { connect, close } = require('./mongo');
const ImapConnection = require('./connection');

const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993');
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';

async function main() {
  // Connect to MongoDB
  await connect();
  console.log('MongoDB connected');

  // TLS options
  let tlsOptions = null;
  if (TLS_CERT && TLS_KEY) {
    try {
      tlsOptions = {
        cert: fs.readFileSync(TLS_CERT),
        key: fs.readFileSync(TLS_KEY),
        minVersion: 'TLSv1.2',
      };
      console.log('TLS certificates loaded');
    } catch (err) {
      console.error(`Failed to load TLS certs: ${err.message}`);
    }
  }

  const onConnection = (socket) => {
    const addr = socket.remoteAddress || 'unknown';
    console.log(`[IMAP] Connection from ${addr}`);
    const conn = new ImapConnection(socket);
    conn.start();
  };

  if (tlsOptions) {
    // IMAPS — implicit TLS on port 993
    const server = tls.createServer(tlsOptions, onConnection);
    server.on('error', (err) => console.error(`TLS server error: ${err.message}`));
    server.listen(IMAP_PORT, '0.0.0.0', () => {
      console.log(`IMAP server (TLS) listening on port ${IMAP_PORT}`);
    });
  } else {
    // Plain IMAP — for development/testing without TLS
    console.warn('WARNING: No TLS certs configured — running plain IMAP (insecure)');
    const server = net.createServer(onConnection);
    server.on('error', (err) => console.error(`Server error: ${err.message}`));
    server.listen(IMAP_PORT, '0.0.0.0', () => {
      console.log(`IMAP server (plain) listening on port ${IMAP_PORT}`);
    });
  }

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
