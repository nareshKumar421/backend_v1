// backend/routes/customers.js  —  HANA-backed version
// Replaces the in-memory array store with SAP HANA (TEST_OIL_15122025.ZCUST_PORTAL)
const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');
const { createCustomer, getNextCardCode } = require('../services/sapServiceLayer');
const { verifyToken, verifyAdmin }        = require('../middleware/auth');
const store = require('../services/hanaStore');  // ← HANA persistence
const { resolve: resolveCompany } = require('../services/companyConfig');

function mapCurrency(label) {
  return {
    'Indian Rupee':'INR','US Dollar':'USD','Euro':'EUR',
    'British Pound':'GBP','UAE Dirham':'AED',
  }[label] || 'INR';
}
function mapCountryCode(name) {
  return {
    'India':'IN','United States':'US','United Kingdom':'GB',
    'UAE':'AE','Singapore':'SG','Germany':'DE','Japan':'JP','Australia':'AU',
  }[name] || 'IN';
}

// Fields the customer form / verifier can touch
const CUSTOMER_EDITABLE = [
  'cardName','foreignName','typeOfBusiness','industry','mobile','email','website',
  'contactFirst','contactLast','contactMobile','contactEmail','contactTitle',
  'currency','gstin','pan','remarks',
  'hasMsme','msmeNo','msmeType','msmeBType','attachments',
  'billAddressName','billStreet','billBlock','billCity','billZip','billState','billCountry',
  'shipAddressName','shipStreet','shipBlock','shipCity','shipZip','shipState','shipCountry',
  'sameAsBill','allBillAddresses','allShipAddresses',
];

const MANAGER_EDITABLE = [
  'mgrCardCodePrefix','mgrGroupCode','mgrGroup','mgrCurrency','mgrChain','mgrMainGroup',
  'mgrBranch','mgrCountry','mgrCity','mgrZone','mgrArea','mgrSubarea','mgrCountryHead',
  'mgrRsm','mgrAsm','mgrSo','mgrSr','mgrPromoter',
  'mgrSalesEmployee','mgrSalesPersonCode',
  'mgrSchemeType','mgrTerritory','mgrNotes',
  'mgrCreditLimit',
  'mgrPayTerms','mgrPayTermsCode',
  'mgrArAccount','mgrArAccountName','mgrLanguage',
];

const ALL_EDITABLE = [...CUSTOMER_EDITABLE, ...MANAGER_EDITABLE];

// Build a patch object from request body — only keys in allowedFields
function extractPatch(body, fields) {
  const patch = {};
  fields.forEach(f => {
    if (body[f] !== undefined) patch[f] = body[f];
  });
  return patch;
}

// ── POST /submit ──────────────────────────────────────────────────────────────
router.post('/submit', [
  body('cardName').notEmpty().trim().withMessage('Company name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('mobile').notEmpty().trim().withMessage('Mobile is required'),
  body('contactFirst').notEmpty().trim().withMessage('Contact first name is required'),
  body('contactLast').notEmpty().trim().withMessage('Contact last name is required'),
  body('billStreet').notEmpty().trim().withMessage('Street is required'),
  body('billCity').notEmpty().trim().withMessage('City is required'),
], async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ success: false, errors: errs.array() });

  const b = req.body;
  const companyDB = resolveCompany(b.company);
  try {
    const customer = await store.insertCustomer({
      customerType:   b.customerType || 'B2B',
      cardName:       b.cardName,
      foreignName:    b.foreignName || '',
      typeOfBusiness: b.typeOfBusiness || 'Company',
      industry:       b.industry || '',
      mobile:         b.mobile,
      email:          b.email,
      website:        b.website || '',
      contactFirst:   b.contactFirst,
      contactLast:    b.contactLast,
      contactMobile:  b.contactMobile || b.mobile,
      contactEmail:   b.contactEmail  || b.email || '',
      contactTitle:   b.contactTitle  || '',
      billAddressName: b.billAddressName || b.cardName,
      billStreet:     b.billStreet,
      billBlock:      b.billBlock  || '',
      billCity:       b.billCity,
      billZip:        b.billZip    || '',
      billState:      b.billState  || '',
      billCountry:    b.billCountry || 'India',
      sameAsBill:     b.sameAsBill || false,
      shipAddressName: b.sameAsBill ? (b.billAddressName || b.cardName) : (b.shipAddressName || b.billAddressName || b.cardName),
      shipStreet:  b.sameAsBill ? b.billStreet  : (b.shipStreet  || b.billStreet),
      shipBlock:   b.sameAsBill ? b.billBlock   : (b.shipBlock   || b.billBlock  || ''),
      shipCity:    b.sameAsBill ? b.billCity    : (b.shipCity    || b.billCity),
      shipZip:     b.sameAsBill ? b.billZip     : (b.shipZip     || b.billZip    || ''),
      shipState:   b.sameAsBill ? b.billState   : (b.shipState   || b.billState  || ''),
      shipCountry: b.sameAsBill ? b.billCountry : (b.shipCountry || b.billCountry || 'India'),
      allBillAddresses: Array.isArray(b.allBillAddresses) ? b.allBillAddresses : [],
      allShipAddresses: Array.isArray(b.allShipAddresses) ? b.allShipAddresses : [],
      currency:    b.currency || 'Indian Rupee',
      gstin:       b.gstin   || '',
      pan:         b.pan     || '',
      remarks:     b.remarks || '',
      hasMsme:     b.hasMsme  || false,
      msmeNo:      b.msmeNo   || '',
      msmeType:    b.msmeType || '',
      msmeBType:   b.msmeBType|| '',
      attachments: b.attachments || {},
      // Manager defaults
      mgrCardCodePrefix: 'CUSTA',
      mgrArAccount: '1101001', mgrArAccountName: 'SUNDRY DEBTORS GT',
      mgrCurrency: 'Indian Rupee', mgrLanguage: 'English (UK)',
    }, companyDB);

    const attKeys = Object.keys(b.attachments || {}).filter(k => b.attachments[k]);
    console.log(`[APP] Submitted: ${b.cardName} (id=${customer.id}) | Attachments: ${attKeys.join(',') || 'none'}`);
    res.json({ success: true, message: 'Submitted', id: customer.id });
  } catch (err) {
    console.error('[APP] submit error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET list ──────────────────────────────────────────────────────────────────
router.get('/', verifyToken, async (req, res) => {
  const st = (req.query.status || 'PENDING').toUpperCase();
  const companyDB = resolveCompany(req.query.company);
  try {
    const data = await store.listByStatus(st, companyDB);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[APP] list error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET single ────────────────────────────────────────────────────────────────
router.get('/:id', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.query.company);
  try {
    const c = await store.findById(req.params.id, companyDB);
    if (!c) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: c });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /verify ─────────────────────────────────────────────────────────────
router.patch('/:id/verify', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const c = await store.findById(req.params.id, companyDB);
    if (!c) return res.status(404).json({ success: false, message: 'Not found' });
    if (c.status !== 'PENDING')
      return res.status(400).json({ success: false, message: 'Only PENDING can be verified. Current: ' + c.status });

    const patch = extractPatch(req.body, ALL_EDITABLE);
    patch.status     = req.body.approved ? 'VERIFIED' : 'REJECTED';
    patch.verifiedAt = new Date().toISOString();

    await store.updateCustomer(c.id, patch, companyDB);
    console.log(`[APP] ${c.id} (${c.cardName}) → ${patch.status}`);
    res.json({ success: true, message: `Customer ${patch.status.toLowerCase()}` });
  } catch (err) {
    console.error('[APP] verify error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /approve ────────────────────────────────────────────────────────────
router.patch('/:id/approve', verifyToken, verifyAdmin, async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const c = await store.findById(req.params.id, companyDB);
    if (!c) return res.status(404).json({ success: false, message: 'Not found' });

    if (!req.body.approved) {
      await store.updateCustomer(c.id, { status: 'REJECTED' }, companyDB);
      return res.json({ success: true, message: 'Customer rejected' });
    }

    if (c.status !== 'VERIFIED')
      return res.status(400).json({ success: false, message: `Must be VERIFIED. Current: ${c.status}` });

    // Merge incoming manager edits into the record
    const patch = extractPatch(req.body, ALL_EDITABLE);
    const merged = { ...c, ...patch };

    const prefix = merged.mgrCardCodePrefix || 'CUSTA';
    const cardCode = await getNextCardCode(prefix, companyDB);

    const payTermsGrpCode = merged.mgrPayTermsCode && !isNaN(parseInt(merged.mgrPayTermsCode))
      ? parseInt(merged.mgrPayTermsCode) : null;
    const salesPersonCode = merged.mgrSalesPersonCode && !isNaN(parseInt(merged.mgrSalesPersonCode))
      ? parseInt(merged.mgrSalesPersonCode) : null;
    const groupCode = merged.mgrGroupCode && !isNaN(parseInt(merged.mgrGroupCode))
      ? parseInt(merged.mgrGroupCode) : null;

    console.log(`[APP] APPROVE ${cardCode}: PayTermsGrpCode=${payTermsGrpCode} SalesPersonCode=${salesPersonCode} GroupCode=${groupCode}`);

    const result = await createCustomer({
      cardCode,
      cardName:         merged.cardName,
      currency:         mapCurrency(merged.mgrCurrency || merged.currency),
      phone1:           merged.mobile,
      email:            merged.email,
      website:          merged.website,
      creditLimit:      parseFloat(merged.mgrCreditLimit) || 0,
      remarks:          merged.remarks,
      typeOfBusiness:   merged.typeOfBusiness,
      groupCode,
      payTermsGrpCode,
      salesPersonCode,
      contactFirst:     merged.contactFirst,
      contactLast:      merged.contactLast,
      contactMobile:    merged.contactMobile || merged.mobile,
      contactEmail:     merged.contactEmail  || merged.email,
      contactTitle:     merged.contactTitle,
      billAddressName:  merged.billAddressName,
      billStreet:       merged.billStreet,
      billBlock:        merged.billBlock,
      billCity:         merged.billCity,
      billZip:          merged.billZip,
      billState:        merged.billState,
      billCountry:      mapCountryCode(merged.billCountry),
      shipAddressName:  merged.shipAddressName,
      shipStreet:       merged.shipStreet,
      shipBlock:        merged.shipBlock,
      shipCity:         merged.shipCity,
      shipZip:          merged.shipZip,
      shipState:        merged.shipState,
      shipCountry:      mapCountryCode(merged.shipCountry),
      allBillAddresses: merged.allBillAddresses || [],
      allShipAddresses: merged.allShipAddresses || [],
      mgrMainGroup:     merged.mgrMainGroup,
      mgrChain:         merged.mgrChain,
      mgrArAccount:     merged.mgrArAccount,
      hasMsme:          merged.hasMsme,
      msmeNo:           merged.msmeNo   || '',
      msmeType:         merged.msmeType || '',
      msmeBType:        merged.msmeBType|| '',
      gstin:            merged.gstin,
      pan:              merged.pan,
      attachments:      merged.attachments || {},
    }, companyDB);

    await store.updateCustomer(c.id, {
      ...patch,
      status:             'APPROVED',
      sapCardCode:        cardCode,
      approvedAt:         new Date().toISOString(),
      approvedBy:         req.user.username,
      sapAttachmentEntry: result?.attachmentEntry || null,
    }, companyDB);

    console.log(`[APP] ✅ ${merged.cardName} → SAP B1 as ${cardCode}`);
    res.json({ success: true, message: 'Customer created in SAP B1!', cardCode, cardName: merged.cardName });
  } catch (err) {
    console.error('[APP] approve error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /draft ──────────────────────────────────────────────────────────────
router.patch('/:id/draft', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const c = await store.findById(req.params.id, companyDB);
    if (!c) return res.status(404).json({ success: false, message: 'Not found' });
    if (c.status === 'APPROVED' || c.status === 'REJECTED')
      return res.status(400).json({ success: false, message: 'Cannot edit ' + c.status + ' records' });

    const patch = extractPatch(req.body, ALL_EDITABLE);
    await store.updateCustomer(c.id, patch, companyDB);
    console.log(`[APP] Draft saved: id=${c.id} (${c.cardName})`);
    res.json({ success: true, message: 'Draft saved' });
  } catch (err) {
    console.error('[APP] draft error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;