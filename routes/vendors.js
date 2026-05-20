// backend/routes/vendors.js — FIXED v3
// Fixes:
//   1. /lookup/sales-employees added (same OSLP table as customers)
//   2. mgrSalesPersonCode added to MANAGER_EDITABLE
//   3. mgrChain added to MANAGER_EDITABLE (was missing → chain never saved/sent to SAP)
//   4. allBillAddresses / allShipAddresses added to VENDOR_EDITABLE
//   5. doApproveVendor passes salesPersonCode, allBillAddresses, allShipAddresses to createVendor
//   6. getBankCodes now works (exported from sapServiceLayer)

'use strict';
const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');
const { verifyToken, verifyAdmin } = require('../middleware/auth');
const store = require('../services/hanaVendorStore');
const { resolve: resolveCompany } = require('../services/companyConfig');

function getSap() { return require('../services/sapServiceLayer'); }

// HANA for lookups
const hana = require('@sap/hana-client');
let _hanaConn = null, _hanaConnecting = false;
async function getHanaConn() {
  if (_hanaConn) return _hanaConn;
  if (_hanaConnecting) {
    for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 500)); if (_hanaConn) return _hanaConn; }
    throw new Error('HANA timeout');
  }
  _hanaConnecting = true;
  try {
    const c = hana.createConnection();
    await new Promise((resolve, reject) =>
      c.connect({
        serverNode: `${process.env.HANA_HOST}:${process.env.HANA_PORT}`,
        uid: process.env.HANA_USER, pwd: process.env.HANA_PASSWORD,
        encrypt: 'true', sslValidateCertificate: 'false',
      }, err => err ? reject(err) : resolve())
    );
    _hanaConn = c; console.log('[VENDOR HANA] ✅ Connected');
  } catch (err) { console.error('[VENDOR HANA] ❌', err.message); throw err; }
  finally { _hanaConnecting = false; }
  return _hanaConn;
}
async function hq(sql) {
  const conn = await getHanaConn();
  return new Promise((resolve, reject) => conn.exec(sql, (err, rows) => {
    if (err) { try { conn.disconnect(); } catch (_) {} _hanaConn = null; return reject(err); }
    resolve(rows || []);
  }));
}
const DB = () => `"${process.env.SAP_B1_COMPANY}"`;
async function safeLookup(res, sql, mapFn) {
  try { const rows = await hq(sql); return res.json({ success: true, data: rows.map(mapFn) }); }
  catch (err) { console.warn('[VENDOR LOOKUP] fallback:', err.message); return res.json({ success: true, data: [], warning: err.message }); }
}

// Utils
function mapCurrency(label) {
  return { 'Indian Rupee':'INR','US Dollar':'USD','Euro':'EUR','British Pound':'GBP','UAE Dirham':'AED' }[label] || 'INR';
}
function mapCountryCode(name) {
  return { 'India':'IN','United States':'US','United Kingdom':'GB','UAE':'AE','Singapore':'SG','Germany':'DE','Japan':'JP','Australia':'AU' }[name] || 'IN';
}
function sanitizeMobile(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(3);
  return digits.slice(-10);
}

// ── EDITABLE FIELDS ───────────────────────────────────────────────────────────
const VENDOR_EDITABLE = [
  'cardName','foreignName','typeOfBusiness','industry','products','paymentTerms',
  'mobile','altContact','email','currency','contactFirst','contactLast','contactTitle',
  'billStreet','billBlock','billCity','billZip','billState','billCountry',
  // FIX: multiple addresses support
  'allBillAddresses','allShipAddresses','sameAsBill',
  'shipStreet','shipBlock','shipCity','shipZip','shipState','shipCountry',
  'gstin','pan','tan','remarks','hasMsme','msmeNo','msmeType','msmeBType',
  'fssaiNo','bankAccounts','attachments',
];
const MANAGER_EDITABLE = [
  'mgrCardCodePrefix','mgrGroupCode','mgrGroup','mgrCurrency','mgrPayTerms',
  'mgrPayTermsCode','mgrPurchaseAccount','mgrLanguage','mgrCreditLimit',
  'mgrNotes','mgrTerritory',
  'mgrMainGroup',       // → U_Main_Group in SAP
  'mgrChain',           // FIX: was missing → chain never persisted or sent to SAP
  'mgrSalesPersonCode', // FIX: new field for sales person
];
const ALL_EDITABLE = [...VENDOR_EDITABLE, ...MANAGER_EDITABLE];

function extractPatch(body, fields) {
  const p = {};
  fields.forEach(f => { if (body[f] !== undefined) p[f] = body[f]; });
  return p;
}

// ══ LOOKUP ROUTES ════════════════════════════════════════════════════════════

// Vendor BP Groups
router.get('/lookup/bp-groups', verifyToken, async (req, res) => {
  try {
    const result = await getSap().sapRequest('GET',
      `BusinessPartnerGroups?$filter=Type eq 'bbpgt_VendorGroup'&$select=Code,Name&$orderby=Name`
    );
    res.json({ success: true, data: (result?.value || []).map(r => ({ GroupCode: r.Code, GroupName: r.Name })) });
  } catch (err) { res.json({ success: true, data: [], warning: err.message }); }
});

// Payment Terms
router.get('/lookup/payment-terms', verifyToken, (req, res) =>
  safeLookup(res,
    `SELECT "GroupNum","PymntGroup" FROM ${DB()}."OCTG" ORDER BY "PymntGroup"`,
    r => ({ Code: r.GroupNum, Name: r.PymntGroup })
  )
);

// AP Accounts
router.get('/lookup/ap-accounts', verifyToken, (req, res) =>
  safeLookup(res,
    `SELECT "AcctCode","AcctName" FROM ${DB()}."OACT"
     WHERE ("FatherNum" = '2101000' OR "AcctCode" LIKE '211%')
     AND "Finanse" = 'N'
     ORDER BY "AcctCode"`,
    r => ({ AcctCode: r.AcctCode, AcctName: r.AcctName })
  )
);

// ── FIX 1: Sales Employees — was missing from vendor lookups ─────────────────
router.get('/lookup/sales-employees', verifyToken, (req, res) =>
  safeLookup(res,
    `SELECT "SlpCode","SlpName" FROM ${DB()}."OSLP"
     WHERE "SlpCode" > 0 AND "Locked" = 'N'
     ORDER BY "SlpName"`,
    r => ({ SlpCode: r.SlpCode, SlpName: r.SlpName })
  )
);

// ── Bank Codes from ODSC (Bank Master) ────────────────────────────────────────
// FIX: getBankCodes is now exported from sapServiceLayer — this will work
router.get('/lookup/banks', verifyToken, async (req, res) => {
  const country = (req.query.country || 'IN').toUpperCase();
  try {
    const banks = await getSap().getBankCodes(country);
    res.json({ success: true, data: banks });
  } catch (err) {
    // Fallback: try HANA ODSC table directly
    try {
      const rows = await hq(
        `SELECT "BankCode","BankName","SwiftNo","CountryCode"
         FROM ${DB()}."ODSC"
         ORDER BY "BankName"`
      );
      res.json({ success: true, data: rows.map(r => ({
        BankCode: r.BankCode, BankName: r.BankName,
        SwiftNo: r.SwiftNo || '', CountryCode: r.CountryCode,
      })) });
    } catch (e2) {
      res.json({ success: true, data: [], warning: e2.message });
    }
  }
});

// Main Group
router.get('/lookup/main-group', verifyToken, (req, res) =>
  safeLookup(res,
    `SELECT "Code","Name" FROM ${DB()}."@MAIN_GROUP" ORDER BY "Code"`,
    r => ({ Code: r.Code, Name: r.Name || r.Code })
  )
);

// ── FIX 2: Chain — query was correct but field wasn't in MANAGER_EDITABLE ───
router.get('/lookup/chain', verifyToken, (req, res) =>
  safeLookup(res,
    `SELECT "Code","Name" FROM ${DB()}."@CHAIN" ORDER BY "Code"`,
    r => ({ Code: r.Code, Name: r.Name || r.Code })
  )
);

// Next Vendor CardCode
router.get('/next-cardcode', verifyToken, async (req, res) => {
  const prefix = (req.query.prefix || 'VENDA').trim();
  try { res.json({ success: true, cardCode: await getSap().getNextVendorCardCode(prefix) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ══ CRUD ROUTES ══════════════════════════════════════════════════════════════

router.post('/submit', [
  body('cardName').notEmpty().trim(),
  body('email').isEmail().normalizeEmail(),
  body('mobile').notEmpty().trim(),
  body('contactFirst').notEmpty().trim(),
  body('contactLast').notEmpty().trim(),
  body('billStreet').notEmpty().trim(),
  body('billCity').notEmpty().trim(),
  body('gstin').notEmpty().trim(),
  body('pan').notEmpty().trim(),
], async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ success: false, errors: errs.array() });
  const b = req.body;
  const companyDB = resolveCompany(b.company);
  try {
    const vendor = await store.insertVendor({
      userId: b.userId||'', userType: b.userType||'', userDept: b.userDept||'',
      vendorType: b.vendorType||'SUPPLIER', cardName: b.cardName, foreignName: b.foreignName||'',
      typeOfBusiness: b.typeOfBusiness||'Company', industry: b.industry||'', products: b.products||'',
      paymentTerms: b.paymentTerms||'30 Days', contactFirst: b.contactFirst, contactLast: b.contactLast,
      contactTitle: b.contactTitle||'', mobile: sanitizeMobile(b.mobile),
      altContact: b.altContact ? sanitizeMobile(b.altContact) : '', email: b.email,
      billStreet: b.billStreet, billBlock: b.billBlock||'', billCity: b.billCity,
      billZip: b.billZip||'', billState: b.billState||'', billCountry: b.billCountry||'India',
      // Multiple addresses
      allBillAddresses: Array.isArray(b.allBillAddresses) ? b.allBillAddresses : [],
      allShipAddresses: Array.isArray(b.allShipAddresses) ? b.allShipAddresses : [],
      sameAsBill: b.sameAsBill || false,
      gstin: (b.gstin||'').toUpperCase(), pan: (b.pan||'').toUpperCase(), tan: (b.tan||'').toUpperCase(),
      currency: b.currency||'Indian Rupee',
      hasMsme: b.hasMsme||false, msmeNo: b.msmeNo||'', msmeType: b.msmeType||'', msmeBType: b.msmeBType||'',
      fssaiNo: b.fssaiNo||'',
      bankAccounts: Array.isArray(b.bankAccounts) ? b.bankAccounts : [],
      attachments: b.attachments||{}, remarks: b.remarks||'',
      mgrCardCodePrefix: 'VENDA', mgrPurchaseAccount: '2110005',
      mgrCurrency: 'Indian Rupee', mgrLanguage: 'English (UK)',
      company: companyDB,
    }, companyDB);
    res.json({ success: true, message: 'Vendor registration submitted', id: vendor.id });
  } catch (err) {
    console.error('[VENDOR] submit error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/', verifyToken, async (req, res) => {
  const st = (req.query.status || 'PENDING').toUpperCase();
  const companyDB = resolveCompany(req.query.company);
  try { res.json({ success: true, data: await store.listByStatus(st, companyDB) }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/:id', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.query.company);
  try {
    const v = await store.findById(req.params.id, companyDB);
    if (!v) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: v });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.patch('/:id/verify', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const v = await store.findById(req.params.id, companyDB);
    if (!v) return res.status(404).json({ success: false, message: 'Not found' });
    if (v.status !== 'PENDING') return res.status(400).json({ success: false, message: 'Only PENDING can be verified. Current: ' + v.status });
    const patch = extractPatch(req.body, ALL_EDITABLE);
    patch.status     = req.body.approved ? 'VERIFIED' : 'REJECTED';
    patch.verifiedAt = new Date().toISOString();
    patch.verifiedBy = req.user.username;
    await store.updateVendor(v.id, patch, companyDB);
    console.log(`[VENDOR] ${v.id} (${v.cardName}) → ${patch.status} by ${req.user.username}`);
    res.json({ success: true, message: `Vendor ${patch.status.toLowerCase()}` });
  } catch (err) {
    console.error('[VENDOR] verify error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Core approval logic ───────────────────────────────────────────────────────
async function doApproveVendor(v, req, patch, companyDB) {
  const { createVendor, getNextVendorCardCode } = getSap();
  const merged = { ...v, ...patch };
  const cardCode = await getNextVendorCardCode(merged.mgrCardCodePrefix || 'VENDA', companyDB);

  const groupCode       = merged.mgrGroupCode    && !isNaN(parseInt(merged.mgrGroupCode))    ? parseInt(merged.mgrGroupCode)    : null;
  const payTermsGrpCode = merged.mgrPayTermsCode && !isNaN(parseInt(merged.mgrPayTermsCode)) ? parseInt(merged.mgrPayTermsCode) : null;
  // FIX: sales person now passed through
  const salesPersonCode = merged.mgrSalesPersonCode && !isNaN(parseInt(merged.mgrSalesPersonCode)) ? parseInt(merged.mgrSalesPersonCode) : null;

  console.log(`[VENDOR] APPROVE ${cardCode}: GroupCode=${groupCode} PayTermsGrpCode=${payTermsGrpCode} SalesPersonCode=${salesPersonCode}`);
  console.log(`[VENDOR] UDFs: U_Main_Group=${merged.mgrMainGroup || '(none)'} U_Chain=${merged.mgrChain || '(none)'}`);

  // Bank accounts: manager-selected bankCode takes priority
  const bankAccounts = (merged.bankAccounts || []).map(b => ({
    ...b,
    bankCode: b.bankCode || b.mgrBankCode || null,
  }));

  const result = await createVendor({
    cardCode,
    cardName:    merged.cardName,
    currency:    mapCurrency(merged.mgrCurrency || merged.currency),
    phone1:      sanitizeMobile(merged.mobile),
    email:       merged.email,
    creditLimit: parseFloat(merged.mgrCreditLimit) || 0,
    remarks:     merged.remarks,
    typeOfBusiness: merged.typeOfBusiness,
    groupCode,
    payTermsGrpCode,
    salesPersonCode,    // FIX: now passed
    contactFirst:  merged.contactFirst,
    contactLast:   merged.contactLast,
    contactMobile: sanitizeMobile(merged.mobile),
    contactEmail:  merged.email,
    contactTitle:  merged.contactTitle,
    billStreet:    merged.billStreet,
    billBlock:     merged.billBlock,
    billCity:      merged.billCity,
    billZip:       merged.billZip,
    billState:     merged.billState,
    billCountry:   mapCountryCode(merged.billCountry),
    // FIX: multiple addresses now passed
    allBillAddresses: merged.allBillAddresses || [],
    allShipAddresses: merged.allShipAddresses || [],
    mgrPurchaseAccount: merged.mgrPurchaseAccount || '2110005',
    hasMsme:       merged.hasMsme,
    msmeNo:        merged.msmeNo  || '',
    msmeType:      merged.msmeType || '',
    msmeBType:     merged.msmeBType || '',
    fssaiNo:       merged.fssaiNo || '',
    gstin:         merged.gstin,
    pan:           merged.pan,
    bankAccounts,
    attachments:   merged.attachments || {},
    mgrMainGroup:  merged.mgrMainGroup || '',   // → U_Main_Group in SAP B1
    mgrChain:      merged.mgrChain     || '',   // FIX: now in MANAGER_EDITABLE → U_Chain in SAP B1
  }, companyDB);

  return {
    cardCode,
    cardName:        merged.cardName,
    attachmentEntry: result?.attachmentEntry || null,
  };
}

router.patch('/:id/approve', verifyToken, verifyAdmin, async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const v = await store.findById(req.params.id, companyDB);
    if (!v) return res.status(404).json({ success: false, message: 'Not found' });
    if (!req.body.approved) {
      await store.updateVendor(v.id, { status: 'REJECTED', rejectedBy: req.user.username, rejectedAt: new Date().toISOString() }, companyDB);
      return res.json({ success: true, message: 'Vendor rejected' });
    }
    if (v.status !== 'VERIFIED') return res.status(400).json({ success: false, message: `Must be VERIFIED. Current: ${v.status}` });
    const patch = extractPatch(req.body, ALL_EDITABLE);
    const { cardCode, cardName, attachmentEntry } = await doApproveVendor(v, req, patch, companyDB);
    await store.updateVendor(v.id, {
      ...patch, status: 'APPROVED', sapCardCode: cardCode,
      approvedAt: new Date().toISOString(), approvedBy: req.user.username,
      sapAttachmentEntry: attachmentEntry,
    }, companyDB);
    console.log(`[VENDOR] ✅ ${cardName} → SAP B1 as ${cardCode}`);
    res.json({ success: true, message: 'Vendor created in SAP B1!', cardCode, cardName });
  } catch (err) {
    console.error('[VENDOR] approve error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/:id/admin-approve', verifyToken, verifyAdmin, async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const v = await store.findById(req.params.id, companyDB);
    if (!v) return res.status(404).json({ success: false, message: 'Not found' });
    if (v.status === 'APPROVED') return res.status(400).json({ success: false, message: 'Already approved' });
    if (v.status === 'REJECTED') return res.status(400).json({ success: false, message: 'Cannot approve rejected vendor' });
    await store.updateVendor(v.id, { status: 'VERIFIED' }, companyDB);
    const refreshed = await store.findById(v.id, companyDB);
    const patch = extractPatch(req.body, ALL_EDITABLE);
    const { cardCode, cardName, attachmentEntry } = await doApproveVendor(refreshed, req, patch, companyDB);
    await store.updateVendor(v.id, {
      ...patch, status: 'APPROVED', sapCardCode: cardCode,
      approvedAt: new Date().toISOString(), approvedBy: req.user.username,
      sapAttachmentEntry: attachmentEntry,
    }, companyDB);
    console.log(`[VENDOR] ⚡ Admin pushed ${cardName} → SAP B1 as ${cardCode}`);
    res.json({ success: true, message: 'Vendor pushed to SAP B1!', cardCode, cardName });
  } catch (err) {
    console.error('[VENDOR] admin-approve error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/:id/draft', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const v = await store.findById(req.params.id, companyDB);
    if (!v) return res.status(404).json({ success: false, message: 'Not found' });
    if (v.status === 'APPROVED' || v.status === 'REJECTED') return res.status(400).json({ success: false, message: 'Cannot edit ' + v.status + ' records' });
    await store.updateVendor(v.id, extractPatch(req.body, ALL_EDITABLE), companyDB);
    res.json({ success: true, message: 'Draft saved' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;