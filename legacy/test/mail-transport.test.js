'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mail = require('../src/smtp');

test('mail transport preserves SMTP as the compatibility default', () => {
  const env = {
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_USER: 'board@example.test',
    SMTP_PASS: 'secret',
    SMTP_FROM: 'Board <board@example.test>',
  };
  const c = mail.config(env);
  assert.equal(c.transport, 'smtp');
  assert.equal(c.host, 'smtp.example.test');
  assert.equal(c.secure, 'starttls');
  assert.equal(mail.isConfigured(env), true);
});

test('mail transport supports Microsoft Graph with dedicated credentials', () => {
  const env = {
    MAIL_TRANSPORT: 'graph',
    MAIL_FROM: 'board@example.test',
    MAIL_TENANT_ID: 'tenant-id',
    MAIL_CLIENT_ID: 'client-id',
    MAIL_CLIENT_SECRET: 'client-secret',
  };
  const c = mail.config(env);
  assert.equal(c.transport, 'graph');
  assert.equal(c.host, 'graph.microsoft.com');
  assert.equal(c.port, 443);
  assert.equal(c.secure, 'oauth2');
  assert.equal(c.from, 'board@example.test');
  assert.equal(mail.isConfigured(env), true);
});

test('Graph transport can reuse the existing Entra application credentials', () => {
  const env = {
    MAIL_TRANSPORT: 'graph',
    MAIL_FROM: 'board@example.test',
    ENTRA_TENANT_ID: 'tenant-id',
    ENTRA_CLIENT_ID: 'client-id',
    ENTRA_CLIENT_SECRET: 'client-secret',
  };
  const c = mail.config(env);
  assert.equal(c.graph.tenant, 'tenant-id');
  assert.equal(c.graph.clientId, 'client-id');
  assert.equal(mail.isConfigured(env), true);
});

test('Graph transport is not considered configured without a sender', () => {
  const env = {
    MAIL_TRANSPORT: 'graph',
    ENTRA_TENANT_ID: 'tenant-id',
    ENTRA_CLIENT_ID: 'client-id',
    ENTRA_CLIENT_SECRET: 'client-secret',
  };
  assert.equal(mail.isConfigured(env), false);
});

test('mail subject and address helpers strip unsafe framing', () => {
  assert.equal(mail.cleanSubject('Hello\r\nBcc: nope@example.test'), 'Hello Bcc: nope@example.test');
  assert.equal(mail.bareAddress('Board <board@example.test>'), 'board@example.test');
});
