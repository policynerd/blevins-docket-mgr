'use strict';

// Minimal SMTP client — no dependencies. Supports implicit TLS (port 465)
// and STARTTLS (587/25), AUTH PLAIN/LOGIN, one message per connection.
// Configured entirely from the environment; see isConfigured().
const net = require('node:net');
const tls = require('node:tls');

function config(env = process.env) {
  return {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
    // 'implicit' (TLS from byte one, port 465) or 'starttls' (default).
    secure: (env.SMTP_SECURE || (String(env.SMTP_PORT) === '465' ? 'implicit' : 'starttls')).toLowerCase(),
  };
}

function isConfigured(env = process.env) {
  const c = config(env);
  return !!(c.host && c.from);
}

// Speak just enough SMTP to hand one message to a relay. Resolves on the
// server accepting DATA; rejects with the first permanent error.
function sendMail({ to, subject, text }, env = process.env) {
  const c = config(env);
  if (!isConfigured(env)) return Promise.reject(new Error('SMTP is not configured'));

  return new Promise((resolve, reject) => {
    let socket;
    let buffer = '';
    let done = false;
    const steps = [];
    let step = 0;

    const fail = (err) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) { /* closed */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = () => {
      if (done) return;
      done = true;
      try { socket.end(); } catch (_) { /* closed */ }
      resolve();
    };
    const write = (line) => socket.write(line + '\r\n');

    // The message itself, dot-stuffed per RFC 5321.
    const body = [
      `From: ${c.from}`,
      `To: ${to}`,
      `Subject: ${subject.replace(/[\r\n]+/g, ' ')}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${c.host}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      String(text || ''),
    ].join('\r\n').replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');

    function buildSteps(afterTls) {
      steps.length = 0;
      steps.push({ expect: /^250/, send: null }); // EHLO response consumed by onReply
      if (!afterTls && c.secure === 'starttls') {
        steps.push({ expect: /^220/, send: 'STARTTLS', onDone: upgradeTls });
      }
      if (c.user && c.pass) {
        steps.push({
          expect: /^235/,
          send: 'AUTH PLAIN ' + Buffer.from(`\u0000${c.user}\u0000${c.pass}`).toString('base64'),
        });
      }
      steps.push({ expect: /^250/, send: `MAIL FROM:<${c.from.replace(/^.*<|>.*$/g, '')}>` });
      steps.push({ expect: /^250/, send: `RCPT TO:<${to}>` });
      steps.push({ expect: /^354/, send: 'DATA' });
      steps.push({ expect: /^250/, send: body + '\r\n.', onDone: succeed });
      step = 0;
    }

    function upgradeTls() {
      const plain = socket;
      plain.removeAllListeners('data');
      socket = tls.connect({ socket: plain, host: c.host, servername: c.host }, () => {
        buffer = '';
        buildSteps(true);
        write(`EHLO ${c.host}`);
      });
      socket.on('data', onData);
      socket.on('error', fail);
    }

    function onReply(line) {
      const s = steps[step];
      if (!s) return;
      if (!s.expect.test(line)) return fail(new Error(`SMTP: expected ${s.expect}, got "${line.slice(0, 120)}"`));
      step += 1;
      if (s.onDone) return s.onDone();
      const next = steps[step];
      if (next && next.send != null) write(next.send);
    }

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        // Multi-line replies: intermediate lines look like "250-..."; act on the final "250 ...".
        if (/^\d{3}-/.test(line)) continue;
        if (step === -1) {
          // Greeting: expect 220, then EHLO.
          if (!/^220/.test(line)) return fail(new Error(`SMTP greeting failed: ${line.slice(0, 120)}`));
          step = 0;
          buildSteps(c.secure === 'implicit');
          write(`EHLO ${c.host}`);
        } else {
          onReply(line);
        }
      }
    }

    step = -1;
    if (c.secure === 'implicit') {
      socket = tls.connect({ host: c.host, port: c.port, servername: c.host }, () => {});
    } else {
      socket = net.connect({ host: c.host, port: c.port });
    }
    socket.setTimeout(20000, () => fail(new Error('SMTP timeout')));
    socket.on('data', onData);
    socket.on('error', fail);
  });
}

module.exports = { sendMail, isConfigured, config };
