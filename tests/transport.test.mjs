/**
 * Tests for the REAL HTTPS transport (httpsRequester) — the code that owns
 * timeouts, response caps and JSON parsing — run against a local TLS server
 * with a self-signed certificate. No external network is touched.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let tlsServer;
let keyPem;
let certPem;
let port;
let cleanupCerts = () => {};
let previousTlsSetting;

const { httpsRequester } = await import('../api/lib/circle.js');

const REQUEST_OPTIONS = () => ({
  hostname: '127.0.0.1',
  port,
  path: '/v1/faucet/drips',
  method: 'POST'
});

function startTlsServer(handler) {
  return new Promise((resolve, reject) => {
    tlsServer = https.createServer({ key: keyPem, cert: certPem }, handler);
    tlsServer.on('error', reject);
    tlsServer.listen(0, '127.0.0.1', () => resolve(tlsServer.address().port));
  });
}

before(async () => {
  // Generate a throwaway self-signed cert with openssl. If openssl is not
  // available, this before-hook throws and the FILE fails loudly — that is
  // deliberate (silent skips hid the real-transport coverage).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-tls-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
      '-days', '2', '-nodes', '-subj', '/CN=localhost'
    ], { stdio: 'ignore' });
  } catch {
    cleanupCerts = () => fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('openssl-unavailable');
  }
  keyPem = fs.readFileSync(key);
  certPem = fs.readFileSync(cert);
  cleanupCerts = () => fs.rmSync(dir, { recursive: true, force: true });

  previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
});

after(() => {
  if (tlsServer && typeof tlsServer.close === 'function') tlsServer.close();
  cleanupCerts();
  if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
});

const withServer = async (handler, fn) => {
  port = await startTlsServer(handler);
  try {
    return await fn();
  } finally {
    await new Promise((r) => tlsServer.close(r));
  }
};

test('parses a JSON response', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transactionId: 'tx-1' }));
    },
    async () => {
      const r = await httpsRequester('KEY', { address: '0x1' }, 2000, REQUEST_OPTIONS());
      assert.equal(r.statusCode, 200);
      assert.equal(r.data.transactionId, 'tx-1');
    }
  );
});

test('resolves (not rejects) a non-2xx JSON response', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, message: 'forbidden' }));
    },
    async () => {
      const r = await httpsRequester('KEY', {}, 2000, REQUEST_OPTIONS());
      assert.equal(r.statusCode, 403);
      assert.equal(r.data.message, 'forbidden');
    }
  );
});

test('handles a non-JSON (gateway HTML) body without throwing', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html>bad gateway</html>');
    },
    async () => {
      const r = await httpsRequester('KEY', {}, 2000, REQUEST_OPTIONS());
      assert.equal(r.statusCode, 502);
      assert.equal(r.data.error, 'Invalid JSON response');
    }
  );
});

test('L1: rejects when the response exceeds 512KB (previously hung forever)', async () => {
  const big = 'x'.repeat(600 * 1024);
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Length': String(big.length) });
      res.end(big);
    },
    async () => {
      const start = Date.now();
      await assert.rejects(
        () => httpsRequester('KEY', {}, 5000, REQUEST_OPTIONS()),
        /Response too large/
      );
      assert.ok(Date.now() - start < 4000, 'must reject promptly, not hang');
    }
  );
});

test('L1: rejects on timeout against a black-holed server', async () => {
  await withServer(
    () => { /* never respond */ },
    async () => {
      const start = Date.now();
      await assert.rejects(
        () => httpsRequester('KEY', {}, 300, REQUEST_OPTIONS()),
        /timed out/
      );
      assert.ok(Date.now() - start < 2000);
    }
  );
});
