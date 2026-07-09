// backend/services/sapServiceLayer.js — FIXED FILE
// Fixes applied:
//   1. IFSC → BICSwiftCode in BPBankAccounts (OCRB)
//   2. PAN → TaxId0 in BPFiscalTaxIDCollection (CRD7)
//   3. Attachment FileName now includes extension to fix "File cannot be displayed" [40003-12]
//   4. MSME: U_MSME_Type values → 'Micro','Small','Medium','Large'
//   5. MSME: U_MSME_BType field wired
//   6. U_Fssai field support added

'use strict';
const axios     = require('axios');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const { execSync } = require('child_process');

const httpsAgent  = new https.Agent({ rejectUnauthorized: false });
const SAP_BASE    = process.env.SAP_B1_SERVER;
const _sessions   = {};   // companyDB → cookie

// ════════════════════════════════════════════════════════════════
//  SMB / UNC SHARE HELPERS
// ════════════════════════════════════════════════════════════════

let _shareAuthenticated = false;
let _lastMountedShare   = '';

function sanitizeFolderName(name) {
  return (name || 'VENDOR')
    .replace(/[\\/:*?"<>|.]/g, '')
    .replace(/\s+/g, '_')
    .toUpperCase()
    .trim()
    .substring(0, 60) || 'VENDOR';
}

function runCmd(cmd) {
  try {
    const stdout = execSync(cmd, { stdio: 'pipe', timeout: 15000 }).toString().trim();
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return {
      ok:     false,
      stdout: '',
      stderr: (e.stderr?.toString() || e.message || '').trim(),
    };
  }
}

function mountShare(shareRoot) {
  if (_shareAuthenticated && _lastMountedShare === shareRoot) {
    console.log('[ATTACH] Share already authenticated — skipping net use');
    return true;
  }

  const smbUser   = (process.env.SMB_USER     || '').trim();
  const smbPass   = (process.env.SMB_PASSWORD || '').trim();
  const smbDomain = (process.env.SMB_DOMAIN   || '').trim();

  const testA = runCmd(`dir "${shareRoot}" /b`);
  if (testA.ok) {
    console.log('[ATTACH] ✅ Strategy A: share accessible without net use');
    _shareAuthenticated = true;
    _lastMountedShare   = shareRoot;
    return true;
  }

  runCmd(`net use "${shareRoot}" /delete /y`);

  if (smbUser && smbPass) {
    const userArg = smbDomain ? `${smbDomain}\\${smbUser}` : smbUser;
    const cmdB = `net use "${shareRoot}" /user:${userArg} "${smbPass}" /persistent:no`;
    console.log(`[ATTACH] Strategy B: net use as ${userArg}`);
    const b = runCmd(cmdB);
    if (b.ok) {
      console.log('[ATTACH] ✅ Strategy B succeeded');
      _shareAuthenticated = true;
      _lastMountedShare   = shareRoot;
      return true;
    }
    console.warn('[ATTACH] Strategy B failed:', b.stderr);
    runCmd(`net use "${shareRoot}" /delete /y`);

    const cmdC = `net use "${shareRoot}" /user:WORKGROUP\\${smbUser} "${smbPass}" /persistent:no`;
    console.log(`[ATTACH] Strategy C: net use as WORKGROUP\\${smbUser}`);
    const c = runCmd(cmdC);
    if (c.ok) {
      console.log('[ATTACH] ✅ Strategy C succeeded');
      _shareAuthenticated = true;
      _lastMountedShare   = shareRoot;
      return true;
    }
    console.warn('[ATTACH] Strategy C failed:', c.stderr);
    runCmd(`net use "${shareRoot}" /delete /y`);
  } else {
    console.warn('[ATTACH] SMB_USER / SMB_PASSWORD not set in .env — skipping B & C');
  }

  const cmdD = `net use "${shareRoot}" /persistent:no`;
  console.log('[ATTACH] Strategy D: net use with current Windows session');
  const d = runCmd(cmdD);
  if (d.ok) {
    console.log('[ATTACH] ✅ Strategy D succeeded (current session)');
    _shareAuthenticated = true;
    _lastMountedShare   = shareRoot;
    return true;
  }

  console.error('[ATTACH] ❌ All 4 mount strategies failed. Last error:', d.stderr);
  return false;
}

// ════════════════════════════════════════════════════════════════
//  SAP B1 SERVICE LAYER — LOGIN
// ════════════════════════════════════════════════════════════════

const _loginPromises = {};  // companyDB → promise

async function loginFor(companyDB) {
  const db = companyDB || process.env.SAP_B1_COMPANY;
  if (_loginPromises[db]) {
    console.log(`[SAP] Login in progress for ${db} — waiting...`);
    return _loginPromises[db];
  }
  _loginPromises[db] = _doLoginFor(db).finally(() => { delete _loginPromises[db]; });
  return _loginPromises[db];
}

// Keep legacy login() as alias for the default company (backward compat)
async function login() { return loginFor(process.env.SAP_B1_COMPANY); }

async function _doLoginFor(companyDB) {
  console.log(`\n[SAP] ══ LOGIN ══════════════════════════════`);
  console.log(`[SAP] Server  : ${SAP_BASE}`);
  console.log(`[SAP] Company : ${companyDB}`);
  console.log(`[SAP] User    : ${process.env.SAP_B1_USER}`);
  try {
    const res = await axios.post(`${SAP_BASE}/b1s/v2/Login`, {
      CompanyDB: companyDB,
      UserName:  process.env.SAP_B1_USER,
      Password:  process.env.SAP_B1_PASSWORD,
    }, { httpsAgent, timeout: 30000 });

    const cookies = res.headers['set-cookie'];
    if (!cookies?.length) throw new Error('SAP B1 returned no session cookie');
    _sessions[companyDB] = cookies.map(c => c.split(';')[0]).join('; ');
    console.log(`[SAP] ✅ Login successful for ${companyDB}\n`);
    return true;
  } catch (err) {
    delete _sessions[companyDB];
    const detail = err.response?.data?.error?.message?.value
                || err.response?.data
                || err.message;
    console.error(`[SAP] ❌ Login FAILED for ${companyDB}:`, detail);
    throw new Error('SAP B1 Login failed: ' + JSON.stringify(detail));
  }
}

// ════════════════════════════════════════════════════════════════
//  SAP REQUEST
// ════════════════════════════════════════════════════════════════

async function sapRequest(method, endpoint, data = null, companyDB = null, retry = true, extraHeaders = null) {
  const db = companyDB || process.env.SAP_B1_COMPANY;
  if (!_sessions[db]) await loginFor(db);
  const url = `${SAP_BASE}/b1s/v2/${endpoint}`;
  console.log(`[SAP:${db}] ${method.toUpperCase()} ${url}`);
  try {
    const cfg = {
      method, url, httpsAgent, timeout: 60000,
      headers: {
        Cookie:              _sessions[db],
        'Content-Type':      'application/json',
        'B1S-CaseInsensitive': 'true',
        ...(extraHeaders || {}),
      },
    };
    if (data) cfg.data = data;
    const res = await axios(cfg);
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data || {};
    const isSaml = JSON.stringify(body).includes('SAML')
                || body?.error?.code === '299'
                || status === 401
                || status === 302;

    if (retry && isSaml) {
      console.log(`[SAP] Session expired for ${db} — re-logging in...`);
      delete _sessions[db];
      try { await loginFor(db); } catch (le) { throw new Error('SAP re-login failed: ' + le.message); }
      return sapRequest(method, endpoint, data, db, false, extraHeaders);
    }

    const sapErr  = err.response?.data?.error;
    const sapMsg  = sapErr?.message?.value || sapErr?.message || err.message;
    const sapCode = sapErr?.code || status;
    console.error(`[SAP] ❌ [${sapCode}]: ${sapMsg}`);
    if (data) console.error('[SAP] Payload:', JSON.stringify(data, null, 2));
    throw new Error(`[SAP ${sapCode}] ${sapMsg}`);
  }
}

// ════════════════════════════════════════════════════════════════
//  CARD CODE HELPERS
// ════════════════════════════════════════════════════════════════

async function getNextCardCode(prefix = 'CUSTA', companyDB = null) {
  try {
    const encoded = encodeURIComponent(
      `startswith(CardCode,'${prefix}') and CardType eq 'cCustomer'`
    );
    const r = await sapRequest('GET',
      `BusinessPartners?$filter=${encoded}&$select=CardCode&$orderby=CardCode desc&$top=1`,
      null, companyDB
    );
    if (r?.value?.length) {
      const last   = r.value[0].CardCode;
      const numStr = last.slice(prefix.length).replace(/\D/g, '');
      const next   = `${prefix}${String((parseInt(numStr) || 0) + 1).padStart(numStr.length || 6, '0')}`;
      console.log(`[SAP] CardCode: ${last} → ${next}`);
      return next;
    }
    return `${prefix}000001`;
  } catch (e) {
    const fb = `${prefix}${Date.now().toString().slice(-6)}`;
    console.log(`[SAP] getNextCardCode fallback: ${fb}`);
    return fb;
  }
}

async function getNextVendorCardCode(prefix = 'VENDA', companyDB = null) {
  try {
    const safePrefix = (prefix || 'VENDA').replace(/'/g, "''");
    const encoded = encodeURIComponent(
      `startswith(CardCode,'${safePrefix}') and CardType eq 'cSupplier'`
    );
    const r = await sapRequest('GET',
      `BusinessPartners?$filter=${encoded}&$select=CardCode&$orderby=CardCode desc&$top=1`,
      null, companyDB
    );
    if (r?.value?.length) {
      const last   = r.value[0].CardCode;
      const numStr = last.slice(safePrefix.length).replace(/\D/g, '');
      const next   = `${safePrefix}${String((parseInt(numStr) || 0) + 1).padStart(numStr.length || 6, '0')}`;
      console.log(`[SAP] VendorCardCode: ${last} → ${next}`);
      return next;
    }
    return `${safePrefix}000001`;
  } catch (e) {
    const fb = `${safePrefix}${Date.now().toString().slice(-6)}`;
    console.log(`[SAP] getNextVendorCardCode fallback: ${fb}`);
    return fb;
  }
}

// ════════════════════════════════════════════════════════════════
//  BANK CODES
// ════════════════════════════════════════════════════════════════

async function getBankCodes(countryCode = 'IN', companyDB = null) {
  try {
    console.log(`[SAP] Fetching bank codes for country: ${countryCode}`);
    const encoded = encodeURIComponent(`CountryCode eq '${countryCode}'`);
    let url = `Banks?$filter=${encoded}&$select=BankCode,BankName,SwiftNo,CountryCode&$orderby=BankName`;
    let allBanks = [];
    while (url) {
      const r = await sapRequest('GET', url, null, companyDB);
      const page = (r?.value || []).map(b => ({
        BankCode:    b.BankCode,
        BankName:    b.BankName,
        SwiftNo:     b.SwiftNo || '',
        CountryCode: b.CountryCode,
      }));
      allBanks = allBanks.concat(page);
      const nextLink = r?.['@odata.nextLink'];
      url = nextLink ? nextLink.replace(/^.*\/b1s\/v2\//, '') : null;
    }
    console.log(`[SAP] ✅ getBankCodes: ${allBanks.length} banks for ${countryCode}`);
    return allBanks;
  } catch (err) {
    console.error(`[SAP] ❌ getBankCodes failed: ${err.message}`);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════
//  ADDRESS / MAP HELPERS
// ════════════════════════════════════════════════════════════════

function mapCountry(name) {
  const m = {
    'India':'IN','United States':'US','United Kingdom':'GB',
    'UAE':'AE','Singapore':'SG','Germany':'DE','Japan':'JP','Australia':'AU',
  };
  return m[name] || (name && name.length <= 3 ? name.toUpperCase() : 'IN');
}

function mapStateCode(state) {
  if (!state) return '';
  const SAP_CODES = new Set([
    'AN','AP','AR','AS','BH','CH','CT','DD','DL','DN','GA','GJ','HP',
    'HR','JH','JK','KA','KL','LA','LD','MH','MN','MP','MZ','NL','OR',
    'PB','PY','RJ','SK','TG','TN','TR','UP','UT','WB',
  ]);
  const upper = state.trim().toUpperCase();
  if (upper.length <= 3 && SAP_CODES.has(upper)) return upper;
  const MAP = {
    'Andaman and Nicobar Islands':'AN','Andaman & Nicobar Islands':'AN',
    'Andhra Pradesh':'AP','Arunachal Pradesh':'AR','Assam':'AS','Bihar':'BH',
    'Chandigarh':'CH','Chhattisgarh':'CT','Dadra & Nagar Haveli':'DN',
    'Daman & Diu':'DD','Delhi':'DL','Goa':'GA','Gujarat':'GJ','Haryana':'HR',
    'Himachal Pradesh':'HP','Jammu & Kashmir':'JK','Jammu and Kashmir':'JK',
    'Jharkhand':'JH','Karnataka':'KA','Kerala':'KL','Ladakh':'LA',
    'Lakshadweep':'LD','Madhya Pradesh':'MP','Maharashtra':'MH','Manipur':'MN',
    'Meghalaya':'ME','Mizoram':'MZ','Nagaland':'NL','Odisha':'OR','Orissa':'OR',
    'Puducherry':'PY','Pondicherry':'PY','Punjab':'PB','Rajasthan':'RJ',
    'Sikkim':'SK','Tamil Nadu':'TN','Telangana':'TG','Tripura':'TR',
    'Uttar Pradesh':'UP','Uttarakhand':'UT','Uttaranchal':'UT','West Bengal':'WB',
  };
  const code = MAP[state] || MAP[state.trim()];
  if (code) return code;
  console.warn(`[SAP] Unknown state "${state}"`);
  return '';
}

function buildAddrObj(a, type) {
  const addrName = (a.addrName || a.addressName || '').substring(0, 50);
  const obj = {
    AddressName: addrName,
    AddressType: type,
    Street:      (a.street || '').substring(0, 100),
    Block:       (a.block  || '').substring(0, 100),
    City:        (a.city   || '').substring(0, 100),
    ZipCode:     (a.zip    || '').substring(0, 20),
    State:       mapStateCode(a.state   || ''),
    Country:     mapCountry(a.country || 'India'),
  };
  const gstin = (a.gstin || '').trim().toUpperCase();
  if (gstin && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    obj.GSTIN   = gstin;
    obj.GstType = 'gstRegularTDSISD';
  }
  console.log(`[SAP]   ${type} "${addrName}" State:${obj.State} Country:${obj.Country}`);
  return obj;
}

function sanitizeMobileForSAP(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91'))  return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(3);
  return digits.slice(-10);
}

// ════════════════════════════════════════════════════════════════
//  ATTACHMENT UPLOAD
//  FIX: FileName must include extension so SAP can open the file.
//       SAP error [40003-12] "File cannot be displayed" happens when
//       FileName has no extension — Windows has no program associated.
// ════════════════════════════════════════════════════════════════

async function uploadAttachmentsToSAP(attachments, cardName, companyDB = null) {
  if (!attachments || typeof attachments !== 'object') return null;

  const nodePath  = process.env.SAP_ATTACHMENT_PATH;
  const svrPath   = process.env.SAP_ATTACHMENT_SERVER_PATH || nodePath;

  if (!nodePath) {
    console.log('[ATTACH] SAP_ATTACHMENT_PATH not set — skipping attachment upload');
    return null;
  }

  const isUNC = nodePath.startsWith('\\\\') || nodePath.startsWith('//');
  if (isUNC) {
    const parts     = nodePath.replace(/\\/g, '/').split('/').filter(Boolean);
    const shareRoot = `\\\\${parts[0]}\\${parts[1]}`;
    const mounted   = mountShare(shareRoot);
    if (!mounted) {
      console.error('[ATTACH] ❌ Cannot reach share — vendor will still be created in SAP B1');
      return null;
    }
  }

  const folderName   = sanitizeFolderName(cardName);
  const vendorFolder = `${nodePath}\\${folderName}`;
  const vendorSvrDir = `${svrPath}\\${folderName}`;

  try {
    if (!fs.existsSync(vendorFolder)) {
      fs.mkdirSync(vendorFolder, { recursive: true });
      console.log(`[ATTACH] ✅ Created vendor folder: ${vendorFolder}`);
    }
  } catch (mkErr) {
    console.error(`[ATTACH] ❌ mkdir failed "${vendorFolder}": ${mkErr.message}`);
    _shareAuthenticated = false;
    return null;
  }

  const filesToUpload = [];
  ['pan', 'cheque', 'gst', 'msme', 'other'].forEach(key => {
    const val = attachments[key];
    if (!val) return;
    const arr = Array.isArray(val) ? val : [val];
    arr.forEach(a => { if (a?.data) filesToUpload.push({ key, ...a }); });
  });

  if (!filesToUpload.length) {
    console.log('[ATTACH] No attachment data — nothing to upload');
    return null;
  }

  console.log(`\n[ATTACH] Uploading ${filesToUpload.length} file(s) → ${vendorFolder}`);

  const attachmentLines = [];
  try {
    for (const file of filesToUpload) {
      const base64 = file.data.includes(',') ? file.data.split(',')[1] : file.data;
      const buffer = Buffer.from(base64, 'base64');

      // ── FIX [40003-12]: derive extension from original filename or mime type
      let ext = '';
      if (file.name && file.name.includes('.')) {
        ext = file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
      } else if (file.type) {
        const mimeMap = {
          'application/pdf': 'pdf',
          'image/jpeg': 'jpg',
          'image/jpg': 'jpg',
          'image/png': 'png',
          'image/gif': 'gif',
          'image/tiff': 'tif',
          'application/msword': 'doc',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        };
        ext = mimeMap[file.type] || 'pdf';
      } else {
        ext = 'pdf'; // safe default
      }

      const stem = `${folderName}_${file.key.toUpperCase()}_${Date.now()}`;
      const fileName = `${stem}.${ext}`;                  // ← MUST include extension
      const dest = path.join(vendorFolder, fileName);

      fs.writeFileSync(dest, buffer);
      console.log(`[ATTACH] ✅ ${(buffer.length / 1024).toFixed(1)} KB → ${dest}`);

      // ── FIX: SAP Attachments2_Lines
      //    FileName  = stem WITHOUT extension  (SAP stores stem + FileExtension separately)
      //    FileExtension = extension WITHOUT dot
      //    SourcePath = folder path (no trailing slash)
      attachmentLines.push({
        FileName:      stem,          // no extension here — SAP adds it from FileExtension
        FileExtension: ext,           // no dot, e.g. "pdf", "jpg"
        SourcePath:    vendorSvrDir,  // folder only, no filename
        UserID:        '1',
        Override:      'tYES',
      });
    }

    const result   = await sapRequest('POST', 'Attachments2', { Attachments2_Lines: attachmentLines }, companyDB);
    const absEntry = result?.AbsoluteEntry;

    if (absEntry) {
      console.log(`[ATTACH] ✅ Attachments2 AbsoluteEntry=${absEntry}  folder: ${folderName}`);
    } else {
      console.warn('[ATTACH] ⚠ No AbsoluteEntry returned from SAP Attachments2');
    }
    return absEntry || null;

  } catch (err) {
    console.error(`[ATTACH] ❌ Upload error: ${err.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
//  ATTACHMENT DOWNLOAD — direct SMB/UNC read
//  The HTTP file service (files.jivo.in) builds a Content-Disposition
//  header by latin-1 encoding the download filename and 500s on any name
//  outside that range (em-dash "—", curly quotes, …). Reading the file
//  straight off the share sidesteps that: SAP's Attachments2 line already
//  records the exact folder (SourcePath) + FileName + FileExtension on disk,
//  and the caller serves it back with its own (correct) encoding.
// ════════════════════════════════════════════════════════════════

const _ATTACH_MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', csv: 'text/csv',
};

function attachmentDiskName(line) {
  const stem = String(line?.FileName || '').trim();
  const ext  = String(line?.FileExtension || '').trim().replace(/^\./, '');
  if (!stem) return '';
  if (!ext || stem.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return stem;
  return `${stem}.${ext}`;
}

function joinSharePath(dir, name) {
  const sep = String(dir).includes('\\') ? '\\' : '/';
  return `${String(dir).replace(/[\\/]+$/, '')}${sep}${name}`;
}

// Candidate on-disk locations for an attachment line, most-specific first.
function attachmentPathCandidates(line) {
  const name = attachmentDiskName(line);
  if (!name) return [];

  const nodeRoot = (process.env.SAP_ATTACHMENT_PATH || '').trim();
  const svrRoot  = (process.env.SAP_ATTACHMENT_SERVER_PATH || nodeRoot).trim();
  const src      = String(line?.SourcePath || '').trim().replace(/[\\/]+$/, '');
  const paths    = [];

  if (src) {
    // SAP stores the server-side SourcePath, which may not be how this Node
    // host addresses the share — translate the server root to the Node root.
    if (svrRoot && nodeRoot && svrRoot.toLowerCase() !== nodeRoot.toLowerCase() &&
        src.toLowerCase().startsWith(svrRoot.toLowerCase())) {
      paths.push(joinSharePath(nodeRoot + src.slice(svrRoot.length), name));
    }
    paths.push(joinSharePath(src, name));
    // Same leaf folder rehomed under the Node root (covers a moved/renamed share).
    const leaf = src.split(/[\\/]/).pop();
    if (nodeRoot && leaf) paths.push(joinSharePath(joinSharePath(nodeRoot, leaf), name));
  }
  if (nodeRoot) paths.push(joinSharePath(nodeRoot, name));

  return [...new Set(paths)];
}

async function readAttachmentFromShare(line) {
  const name = attachmentDiskName(line);
  if (!name) throw new Error('Attachment filename is missing on the SAP line');

  const candidates = attachmentPathCandidates(line);
  if (!candidates.length) throw new Error('Could not resolve attachment path from the SAP line');

  // Authenticate the UNC share once (Windows `net use`) before reading.
  const first = candidates[0];
  if (first.startsWith('\\\\') || first.startsWith('//')) {
    const parts     = first.replace(/\//g, '\\').split('\\').filter(Boolean);
    const shareRoot = `\\\\${parts[0]}\\${parts[1]}`;
    if (!mountShare(shareRoot)) throw new Error(`Cannot reach attachment share ${shareRoot}`);
  }

  let lastErr;
  for (const p of candidates) {
    try {
      const data = fs.readFileSync(p);
      const ext  = name.split('.').pop().toLowerCase();
      console.log(`[ATTACH-DL] ✅ Read ${(data.length / 1024).toFixed(1)} KB from share: ${p}`);
      return { data, fileName: name, contentType: _ATTACH_MIME[ext] || 'application/octet-stream', sourcePath: p };
    } catch (e) {
      lastErr = e;
      if (e.code !== 'ENOENT') console.warn(`[ATTACH-DL] share read failed at ${p}: ${e.message}`);
    }
  }
  throw new Error(`Attachment "${name}" not found on share (${lastErr?.message || 'no readable candidate path'})`);
}

// ════════════════════════════════════════════════════════════════
//  CREATE CUSTOMER
// ════════════════════════════════════════════════════════════════

async function createCustomer(d, companyDB = null) {
  console.log(`\n[SAP] ══ CREATE CUSTOMER ════════════════════`);
  console.log(`[SAP] CardCode : ${d.cardCode}`);
  console.log(`[SAP] CardName : ${d.cardName}`);

  const hasAttachData = d.attachments &&
    Object.values(d.attachments).some(v => (Array.isArray(v) ? v : [v]).some(f => f?.data));
  let attachmentEntry = null;
  if (hasAttachData) attachmentEntry = await uploadAttachmentsToSAP(d.attachments, d.cardName, companyDB);

  const payload = { CardCode: d.cardCode, CardName: d.cardName, CardType: 'cCustomer' };

  if (d.currency)        payload.Currency        = d.currency;
  if (d.phone1)          payload.Phone1          = d.phone1;
  if (d.mobile)          payload.Cellular        = d.mobile;
  if (d.email)           payload.EmailAddress    = d.email;
  if (d.website)         payload.Website         = d.website;
  if (d.creditLimit > 0) payload.CreditLimit     = parseFloat(d.creditLimit);
  if (d.remarks)         payload.Notes           = d.remarks;

  if (d.groupCode       != null && !isNaN(d.groupCode))       payload.GroupCode       = parseInt(d.groupCode);
  if (d.payTermsGrpCode != null && !isNaN(d.payTermsGrpCode) && d.payTermsGrpCode >= 0)
    payload.PayTermsGrpCode = parseInt(d.payTermsGrpCode);
  if (d.salesPersonCode != null && !isNaN(d.salesPersonCode) && d.salesPersonCode > 0)
    payload.SalesPersonCode = parseInt(d.salesPersonCode);
  if (attachmentEntry)
    payload.AttachmentEntry = parseInt(attachmentEntry);

  const contactName = `${d.contactFirst || ''} ${d.contactLast || ''}`.trim();
  if (contactName) {
    payload.ContactEmployees = [{
      Name:        contactName,
      FirstName:   d.contactFirst  || '',
      LastName:    d.contactLast   || '',
      MobilePhone: d.contactMobile || '',
      E_Mail:      d.contactEmail  || d.email || '',
      Active:      'tYES',
    }];
  }

  payload.BPAddresses = [];
  if (Array.isArray(d.allBillAddresses) && d.allBillAddresses.length) {
    d.allBillAddresses.forEach(a => payload.BPAddresses.push(buildAddrObj(a, 'bo_BillTo')));
  } else {
    payload.BPAddresses.push(buildAddrObj({
      addrName: d.billAddressName, street: d.billStreet, block: d.billBlock,
      city: d.billCity, zip: d.billZip, state: d.billState,
      country: d.billCountry, gstin: d.gstin,
    }, 'bo_BillTo'));
  }
  if (Array.isArray(d.allShipAddresses) && d.allShipAddresses.length) {
    d.allShipAddresses.forEach(a => payload.BPAddresses.push(buildAddrObj(a, 'bo_ShipTo')));
  } else {
    payload.BPAddresses.push(buildAddrObj({
      addrName:  d.shipAddressName || d.billAddressName,
      street:    d.shipStreet      || d.billStreet,
      block:     d.shipBlock       || d.billBlock,
      city:      d.shipCity        || d.billCity,
      zip:       d.shipZip         || d.billZip,
      state:     d.shipState       || d.billState,
      country:   d.shipCountry     || d.billCountry,
      gstin:     '',
    }, 'bo_ShipTo'));
  }

  if (d.mgrMainGroup) payload.U_Main_Group = d.mgrMainGroup;
  if (d.mgrChain)     payload.U_Chain      = d.mgrChain;

  // ── MSME UDFs ─────────────────────────────────────────────────
  if (d.hasMsme && d.msmeNo) {
    payload.U_MSME       = d.msmeNo;
    // U_MSME_Type: exact SAP UDF values — Micro, Small, Medium, Large
    payload.U_MSME_Type  = d.msmeType  || '';
    payload.U_MSME_BType = d.msmeBType || '';
  }
  // FSSAI
  if (d.fssaiNo && d.fssaiNo.trim()) {
    payload.U_Fssai = d.fssaiNo.trim().toUpperCase();
  }

  if (d.mgrArAccount) payload.DebitorAccount = d.mgrArAccount;

  // ── PAN → BPFiscalTaxIDCollection (CRD7.TaxId0) ──────────────
  const panUpper = (d.pan || '').toUpperCase().trim();
  if (panUpper && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panUpper)) {
    const billAddrName = (
      (Array.isArray(d.allBillAddresses) && d.allBillAddresses[0]?.addrName) ||
      d.billAddressName || d.cardName || ''
    ).substring(0, 50);
    payload.BPFiscalTaxIDCollection = [{
      Address:  billAddrName,
      AddrType: 'bo_BillTo',
      TaxId0:   panUpper,    // ← PAN goes in TaxId0 (maps to CRD7.TaxId0)
    }];
    console.log(`[SAP] PAN (TaxId0): ${panUpper}  Address: ${billAddrName}`);
  }

  console.log('[SAP] Customer Payload:\n' + JSON.stringify(payload, null, 2));
  try {
    const result = await sapRequest('POST', 'BusinessPartners', payload, companyDB);
    console.log(`\n[SAP] ✅ Customer created: ${result?.CardCode || d.cardCode}`);
    return { ...result, attachmentEntry };
  } catch (err) {
    console.error(`[SAP] ❌ createCustomer failed: ${err.message}`);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════
//  CREATE VENDOR
// ════════════════════════════════════════════════════════════════

async function createVendor(d, companyDB = null) {
  console.log(`\n[SAP] ══ CREATE VENDOR (SUPPLIER) ══════════`);
  console.log(`[SAP] CardCode : ${d.cardCode}`);
  console.log(`[SAP] CardName : ${d.cardName}`);

  let attachmentEntry = null;
  const hasAttachData = d.attachments &&
    Object.values(d.attachments).some(v => (Array.isArray(v) ? v : [v]).some(f => f?.data));
  if (hasAttachData) {
    try {
      attachmentEntry = await uploadAttachmentsToSAP(d.attachments, d.cardName, companyDB);
    } catch (attErr) {
      console.warn('[SAP] ⚠ Attachment upload skipped (non-fatal):', attErr.message);
    }
  }

  const payload = {
    CardCode: d.cardCode,
    CardName: d.cardName,
    CardType: 'cSupplier',
  };

  if (d.currency)        payload.Currency     = d.currency;
  if (d.phone1)          payload.Phone1       = d.phone1;
  if (d.email)           payload.EmailAddress = d.email;
  if (d.creditLimit > 0) payload.CreditLimit  = parseFloat(d.creditLimit);
  if (d.remarks)         payload.Notes        = d.remarks;

  if (d.groupCode       != null && !isNaN(d.groupCode))
    payload.GroupCode       = parseInt(d.groupCode);
  if (d.payTermsGrpCode != null && !isNaN(d.payTermsGrpCode) && d.payTermsGrpCode >= 0)
    payload.PayTermsGrpCode = parseInt(d.payTermsGrpCode);
  if (d.salesPersonCode != null && !isNaN(d.salesPersonCode) && d.salesPersonCode > 0)
    payload.SalesPersonCode = parseInt(d.salesPersonCode);
  if (attachmentEntry)
    payload.AttachmentEntry = parseInt(attachmentEntry);

  // AP Account
  payload.DebitorAccount = (d.mgrPurchaseAccount && d.mgrPurchaseAccount.trim())
    ? d.mgrPurchaseAccount.trim()
    : '2110005';
  console.log(`[SAP] DebitorAccount (AP): ${payload.DebitorAccount}`);

  // Contact person
  const contactName = `${d.contactFirst || ''} ${d.contactLast || ''}`.trim();
  if (contactName) {
    payload.ContactEmployees = [{
      Name:        contactName,
      FirstName:   d.contactFirst  || '',
      LastName:    d.contactLast   || '',
      MobilePhone: sanitizeMobileForSAP(d.contactMobile || d.mobile || d.phone1 || ''),
      E_Mail:      d.contactEmail  || d.email || '',
      Active:      'tYES',
    }];
  }

  // Addresses
  payload.BPAddresses = [];
  if (Array.isArray(d.allBillAddresses) && d.allBillAddresses.length) {
    d.allBillAddresses.forEach(a => payload.BPAddresses.push(buildAddrObj(a, 'bo_BillTo')));
  } else {
    const billAddrName = `${d.cardName.substring(0, 25)}-${mapStateCode(d.billState)}`;
    payload.BPAddresses.push(buildAddrObj({
      addrName: billAddrName, street: d.billStreet, block: d.billBlock,
      city: d.billCity, zip: d.billZip, state: d.billState,
      country: d.billCountry || 'India', gstin: d.gstin,
    }, 'bo_BillTo'));
  }
  if (Array.isArray(d.allShipAddresses) && d.allShipAddresses.length) {
    d.allShipAddresses.forEach(a => payload.BPAddresses.push(buildAddrObj(a, 'bo_ShipTo')));
  } else {
    const shipAddrName = `${d.cardName.substring(0, 25)}-${mapStateCode(d.billState)}`;
    payload.BPAddresses.push(buildAddrObj({
      addrName: shipAddrName, street: d.billStreet, block: d.billBlock,
      city: d.billCity, zip: d.billZip, state: d.billState,
      country: d.billCountry || 'India', gstin: d.gstin,
    }, 'bo_ShipTo'));
  }

  // ── MSME UDFs ─────────────────────────────────────────────────
  // U_MSME_Type valid values in SAP: 'Micro', 'Small', 'Medium', 'Large'
  if (d.hasMsme && d.msmeNo) {
    payload.U_MSME       = d.msmeNo.trim();
    payload.U_MSME_Type  = d.msmeType  || '';   // 'Micro'|'Small'|'Medium'|'Large'
    payload.U_MSME_BType = d.msmeBType || '';   // e.g. 'Manufacturing'|'Service'
    console.log(`[SAP] MSME: ${payload.U_MSME}  Type: ${payload.U_MSME_Type}  BType: ${payload.U_MSME_BType}`);
  }

  // ── FSSAI ─────────────────────────────────────────────────────
  if (d.fssaiNo && d.fssaiNo.trim()) {
    payload.U_Fssai = d.fssaiNo.trim().toUpperCase();
    console.log(`[SAP] FSSAI: ${payload.U_Fssai}`);
  }

  // UDF fields
  if (d.mgrMainGroup && d.mgrMainGroup.trim()) {
    payload.U_Main_Group = d.mgrMainGroup.trim();
    console.log(`[SAP] U_Main_Group: ${payload.U_Main_Group}`);
  }
  if (d.mgrChain && d.mgrChain.trim()) {
    payload.U_Chain = d.mgrChain.trim();
    console.log(`[SAP] U_Chain: ${payload.U_Chain}`);
  }

  // ── PAN → BPFiscalTaxIDCollection (CRD7.TaxId0) ──────────────
  // TaxId0 is the PAN field in SAP B1 India localisation.
  // Address must match an existing BPAddress AddressName exactly.
  const panUpper = (d.pan || '').toUpperCase().trim();
  const billAddrNameForPan = (
    (Array.isArray(d.allBillAddresses) && d.allBillAddresses[0]?.addrName) ||
    `${d.cardName.substring(0, 25)}-${mapStateCode(d.billState)}`
  ).substring(0, 50);

  if (panUpper && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panUpper)) {
    payload.BPFiscalTaxIDCollection = [{
      Address:  billAddrNameForPan,  // must match BPAddresses[0].AddressName
      AddrType: 'bo_BillTo',
      TaxId0:   panUpper,            // ← this is PAN in CRD7
    }];
    console.log(`[SAP] PAN (TaxId0): ${panUpper}  AddrName: ${billAddrNameForPan}`);
  }

  // ── Bank accounts ──────────────────────────────────────────────
  // FIX: IFSC goes in BICSwiftCode (maps to OCRB.BICSwiftCode in SAP B1)
  //      NOT in UserNo1. The field was previously wrong.
  if (Array.isArray(d.bankAccounts) && d.bankAccounts.length > 0) {
    const validBanks = d.bankAccounts.filter(b => b.accNo && b.accNo.trim());
    if (validBanks.length > 0) {
      const bankAccountsForSAP = [];
      for (const b of validBanks) {
        const bankCode = b.bankCode || b.mgrBankCode || null;
        if (!bankCode) {
          console.warn(`[SAP] ⚠ Skipping bank account ${b.accNo} — BankCode not resolved`);
          continue;
        }
        const ifscCode = (b.ifsc || '').trim().toUpperCase();
        console.log(`[SAP] Bank: ${bankCode} | A/C: ${b.accNo} | IFSC→BICSwiftCode: ${ifscCode} | Type: ${b.accountType || 'Current'}`);
        bankAccountsForSAP.push({
          BankCode:    bankCode,
          AccountNo:   b.accNo.trim(),
          Branch:      (b.branch      || '').trim().substring(0, 50),
          AccountName: (b.bankName    || d.cardName || '').trim().substring(0, 100),
          // ── FIX: IFSC → BICSwiftCode (OCRB.BICSwiftCode) ──────────────
          BICSwiftCode:    ifscCode.substring(0, 50),   // ← CORRECTED field name
          // UserNo1 / UserNo2 can hold additional reference info
          UserNo1:     ifscCode.substring(0, 50),   // keep for backward compat
          UserNo2:     (b.accountType || 'Current').substring(0, 50),
          IBAN:        (b.swiftCode   || '').trim().substring(0, 34),
        });
      }
      if (bankAccountsForSAP.length > 0) {
        payload.BPBankAccounts = bankAccountsForSAP;
        console.log(`[SAP] BPBankAccounts: ${bankAccountsForSAP.length} account(s) with BICSwiftCode (IFSC)`);
      } else {
        console.warn('[SAP] ⚠ No bank accounts added — BankCode unresolved for all');
      }
    }
  }

  console.log('[SAP] Vendor Payload:\n' + JSON.stringify(payload, null, 2));
  try {
    const result = await sapRequest('POST', 'BusinessPartners', payload, companyDB);
    console.log(`\n[SAP] ✅ Vendor created: ${result?.CardCode || d.cardCode}`);
    return { ...result, attachmentEntry };
  } catch (err) {
    console.error(`[SAP] ❌ createVendor failed: ${err.message}`);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════
//  SAP REQUEST AS SPECIFIC USER — one-off login, no session cache
// ════════════════════════════════════════════════════════════════

async function sapRequestAs(userName, password, companyDB, method, endpoint, data = null) {
  const db = companyDB || process.env.SAP_B1_COMPANY;
  console.log(`[SAP:${db}] ── one-off login as ${userName} for ${method.toUpperCase()} ${endpoint}`);
  let cookie;
  try {
    const lr = await axios.post(`${SAP_BASE}/b1s/v2/Login`, {
      CompanyDB: db, UserName: userName, Password: password,
    }, { httpsAgent, timeout: 30000 });
    const cookies = lr.headers['set-cookie'];
    if (!cookies?.length) throw new Error('no session cookie returned');
    cookie = cookies.map(c => c.split(';')[0]).join('; ');
  } catch (err) {
    const detail = err.response?.data?.error?.message?.value || err.response?.data || err.message;
    throw new Error('SAP login as ' + userName + ' failed: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)));
  }
  try {
    const cfg = {
      method, url: `${SAP_BASE}/b1s/v2/${endpoint}`, httpsAgent, timeout: 60000,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'B1S-CaseInsensitive': 'true' },
    };
    if (data) cfg.data = data;
    const res = await axios(cfg);
    return res.data;
  } catch (err) {
    const sapErr = err.response?.data?.error;
    const sapMsg = sapErr?.message?.value || sapErr?.message || err.message;
    const sapCode = sapErr?.code || err.response?.status;
    if (data) console.error('[SAP] Payload:', JSON.stringify(data, null, 2));
    throw new Error(`[SAP ${sapCode}] ${sapMsg}`);
  } finally {
    axios.post(`${SAP_BASE}/b1s/v2/Logout`, null, {
      httpsAgent, timeout: 10000, headers: { Cookie: cookie },
    }).catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════════════

module.exports = {
  login,
  sapRequest,
  sapRequestAs,
  getNextCardCode,
  getNextVendorCardCode,
  getBankCodes,
  createCustomer,
  createVendor,
  uploadAttachmentsToSAP,
  readAttachmentFromShare,
  sanitizeFolderName,
};