'use strict';

const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');

const FILE_SERVICE_BASE = (process.env.FILE_SERVICE_BASE || 'http://files.jivo.in:8000').replace(/\/+$/, '');

const COMPANY_FILE_IDS = {
  JIVO_OIL_HANADB: '1',
  JIVO_BEVERAGES_HANADB: '2',
  JIVO_BEREAGE_HANADB: '2',
  JIVO_BEVERAGE_HANADB: '2',
  JIVO_MART_HANADB: '3',
};

const MIME_MAP = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
};

function normalizeCompanyDB(companyDB) {
  return String(companyDB || '').trim().toUpperCase();
}

function getFileServiceCompanyId(companyDB) {
  return COMPANY_FILE_IDS[normalizeCompanyDB(companyDB)] || null;
}

function getMimeType(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function contentDispositionFilename(fileName) {
  return String(fileName || 'attachment')
    .replace(/[\r\n]/g, ' ')
    .replace(/"/g, '\\"');
}

function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function entryBaseName(entryName) {
  return String(entryName || '').split(/[\\/]/).pop();
}

function pickZipEntry(zip, requestedFileName) {
  const entries = zip.getEntries().filter(entry => !entry.isDirectory);
  if (!entries.length) return null;

  const requested = path.basename(String(requestedFileName || '')).toLowerCase();
  return entries.find(entry => entryBaseName(entry.entryName).toLowerCase() === requested) ||
    entries.find(entry => String(entry.entryName || '').toLowerCase() === requested) ||
    entries[0];
}

function compressedVariant(fileName) {
  const name = String(fileName || '');
  if (/_compressed(\.[^.]+)?$/i.test(name)) return null; // already compressed
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}_compressed`;
  return `${name.slice(0, dot)}_compressed${name.slice(dot)}`;
}

async function requestFileService(fileName, companyId) {
  const url = `${FILE_SERVICE_BASE}/files/${encodeURIComponent(fileName)}?company=${encodeURIComponent(companyId)}`;
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { Accept: 'application/json' },
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
    });
    return { response, url };
  } catch (err) {
    const status = err.response?.status;
    // The file service returns a JSON body like {"detail":"..."} describing the
    // real failure; surface it instead of the opaque HTTP code.
    let detail = '';
    try {
      const raw = err.response?.data;
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : (typeof raw === 'string' ? raw : JSON.stringify(raw || ''));
      detail = JSON.parse(text)?.detail || '';
    } catch (_) { /* body not JSON — ignore */ }

    // The file server encodes the download filename as latin-1; names with
    // characters outside that range (em-dash "—", curly quotes, …) make it 500.
    // The file exists but cannot be served until the file server is patched.
    if (/latin-1|codec can't encode|not in range\(256\)/i.test(detail)) {
      const e = new Error(`This attachment can't be opened: its filename contains a character the file server cannot handle (${detail.replace(/^Error processing file:\s*/i, '')}). Rename the attachment in SAP without special characters, or patch the file server.`);
      e.status = status;
      e.unencodableName = true;
      throw e;
    }

    const e = new Error(status
      ? `File service returned HTTP ${status}${detail ? ': ' + detail : ''}`
      : `File service request failed: ${err.message}`);
    e.status = status;
    throw e;
  }
}

async function fetchFileFromArchive(fileName, companyDB) {
  if (!fileName) throw new Error('Attachment filename is missing');

  const companyId = getFileServiceCompanyId(companyDB);
  if (!companyId) throw new Error(`No file-service company id mapped for ${companyDB || 'unknown company'}`);

  let response, url;
  try {
    ({ response, url } = await requestFileService(fileName, companyId));
  } catch (err) {
    // Some originals are only archived in their compressed form (e.g. "2858.pdf"
    // missing but "2858_compressed.pdf" present). Fall back to that variant on 404.
    const fallback = err.status === 404 ? compressedVariant(fileName) : null;
    if (!fallback) throw err;
    console.warn(`[FILE-SVC] ${fileName} not found, retrying compressed variant ${fallback}`);
    ({ response, url } = await requestFileService(fallback, companyId));
    fileName = fallback;
  }

  const archiveBuffer = Buffer.from(response.data || []);
  const responseType = String(response.headers?.['content-type'] || '').toLowerCase();

  if (!responseType.includes('zip') && !looksLikeZip(archiveBuffer)) {
    return {
      data: archiveBuffer,
      fileName,
      contentType: responseType || getMimeType(fileName),
      sourceUrl: url,
      companyId,
    };
  }

  let zip;
  try {
    zip = new AdmZip(archiveBuffer);
  } catch (err) {
    throw new Error(`Could not read file-service ZIP: ${err.message}`);
  }

  const entry = pickZipEntry(zip, fileName);
  if (!entry) throw new Error(`File-service ZIP did not contain ${fileName}`);

  const extractedName = entryBaseName(entry.entryName) || fileName;
  const data = entry.getData();

  return {
    data,
    fileName: extractedName,
    contentType: getMimeType(extractedName),
    sourceUrl: url,
    companyId,
  };
}

module.exports = {
  fetchFileFromArchive,
  getFileServiceCompanyId,
  getMimeType,
  contentDispositionFilename,
};
