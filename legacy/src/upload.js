'use strict';

// Multipart/form-data parsing and attachment file storage — no dependencies.
// Files live on the data volume next to the database (survives deploys);
// names are sanitized, extensions allowlisted, and reads are prefix-checked
// so a stored path can never escape the upload root.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DB_PATH } = require('./db');

const UPLOAD_DIR = path.join(path.dirname(DB_PATH), 'uploads');
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const ALLOWED_EXT = new Set(Object.keys(MIME_BY_EXT));

// Parse a multipart/form-data request body. Resolves to
// { fields, files: [{ field, filename, contentType, data }], tooLarge? }.
function parseMultipart(req) {
  return new Promise((resolve) => {
    const ct = req.headers['content-type'] || '';
    const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!m) return resolve({ fields: {}, files: [] });
    const boundary = '--' + (m[1] || m[2]).trim();
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) {
        req.destroy();
        resolve({ fields: {}, files: [], tooLarge: true });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(splitParts(Buffer.concat(chunks), boundary)); }
      catch { resolve({ fields: {}, files: [] }); }
    });
    req.on('error', () => resolve({ fields: {}, files: [] }));
  });
}

function splitParts(buf, boundary) {
  const fields = {};
  const files = [];
  const delim = Buffer.from(boundary);
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    const next = buf.indexOf(delim, pos + delim.length);
    if (next === -1) break;
    let part = buf.subarray(pos + delim.length, next);
    if (part.subarray(0, 2).toString() === '--') break; // closing delimiter
    // Strip the CRLF after the boundary line and the CRLF before the next one.
    part = part.subarray(2, part.length - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const data = part.subarray(headerEnd + 4);
      const nameM = headers.match(/\bname="([^"]*)"/i);
      const fileM = headers.match(/\bfilename="([^"]*)"/i);
      const ctM = headers.match(/Content-Type:\s*([^\r\n]+)/i);
      const name = nameM ? nameM[1] : '';
      if (fileM && fileM[1]) {
        files.push({
          field: name, filename: fileM[1],
          contentType: ctM ? ctM[1].trim() : 'application/octet-stream',
          data,
        });
      } else if (name) {
        const value = data.toString('utf8');
        if (name in fields) {
          if (Array.isArray(fields[name])) fields[name].push(value);
          else fields[name] = [fields[name], value];
        } else fields[name] = value;
      }
    }
    pos = next;
  }
  return { fields, files };
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file'));
  const clean = base.replace(/[^a-zA-Z0-9._ ()-]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || 'file';
}

// Persist an uploaded file under UPLOAD_DIR/<subdir>/. Returns
// { rel, name, size, contentType } or { error }.
function saveUpload(subdir, file) {
  const name = sanitizeFilename(file.filename);
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return { error: `File type ".${ext || '?'}" is not allowed (use: ${[...ALLOWED_EXT].join(', ')}).` };
  }
  if (!file.data || !file.data.length) return { error: 'The uploaded file is empty.' };
  const rel = path.join(subdir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${name}`);
  const abs = path.join(UPLOAD_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, file.data);
  return { rel, name, size: file.data.length, contentType: MIME_BY_EXT[ext] };
}

// Resolve a stored relative path to an absolute one inside the upload root,
// or null if it escapes the root or no longer exists.
function uploadPath(rel) {
  const abs = path.resolve(UPLOAD_DIR, String(rel || ''));
  if (!abs.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

function removeUpload(rel) {
  const abs = uploadPath(rel);
  if (abs) { try { fs.unlinkSync(abs); } catch (_) { /* already gone */ } }
}

module.exports = { parseMultipart, saveUpload, uploadPath, removeUpload, UPLOAD_DIR, MAX_UPLOAD_BYTES };
