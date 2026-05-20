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

async function fetchFileFromArchive(fileName, companyDB) {
  if (!fileName) throw new Error('Attachment filename is missing');

  const companyId = getFileServiceCompanyId(companyDB);
  if (!companyId) throw new Error(`No file-service company id mapped for ${companyDB || 'unknown company'}`);

  const url = `${FILE_SERVICE_BASE}/files/${encodeURIComponent(fileName)}?company=${encodeURIComponent(companyId)}`;

  let response;
  try {
    response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: { Accept: 'application/json' },
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
    });
  } catch (err) {
    const status = err.response?.status;
    throw new Error(status ? `File service returned HTTP ${status}` : `File service request failed: ${err.message}`);
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
