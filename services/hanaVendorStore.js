// backend/services/hanaVendorStore.js
// HANA persistence for vendor registrations.
// Schema: uses SAP_B1_COMPANY env var (same as hanaStore.js)
// Table:  ZVENDOR_PORTAL  (auto-created on first run)

const hana = require('@sap/hana-client');

// Match hanaStore.js exactly — use SAP_B1_COMPANY as the schema
const DEFAULT_SCHEMA = process.env.SAP_B1_COMPANY || 'JIVO_OIL_HANADB';
const tbl = (s) => `"${s || DEFAULT_SCHEMA}"."ZVENDOR_PORTAL"`;
const seq = (s) => `"${s || DEFAULT_SCHEMA}"."ZVENDOR_PORTAL_SEQ"`;

let _conn       = null;
let _connecting = false;

// ── Connection (mirrors hanaStore.js pattern) ─────────────────────────────────
async function getConn() {
  if (_conn) return _conn;
  if (_connecting) {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      if (_conn) return _conn;
    }
    throw new Error('HANA vendor store connection timeout');
  }
  _connecting = true;
  try {
    const conn = hana.createConnection();
    await new Promise((resolve, reject) => {
      conn.connect({
        serverNode:             `${process.env.HANA_HOST}:${process.env.HANA_PORT}`,
        uid:                    process.env.HANA_USER,
        pwd:                    process.env.HANA_PASSWORD,
        encrypt:                'true',
        sslValidateCertificate: 'false',
      }, err => err ? reject(err) : resolve());
    });
    _conn = conn;
    console.log('[VENDOR STORE] ✅ HANA connected to', DEFAULT_SCHEMA);
  } catch (err) {
    console.error('[VENDOR STORE] ❌ HANA connection failed:', err.message);
    throw err;
  } finally {
    _connecting = false;
  }
  return _conn;
}

async function exec(sql, params = []) {
  const conn = await getConn();
  return new Promise((resolve, reject) => {
    if (params && params.length > 0) {
      const stmt = conn.prepare(sql);
      stmt.exec(params, (err, rows) => {
        stmt.drop();
        if (err) { _conn = null; return reject(err); }
        resolve(rows || []);
      });
    } else {
      conn.exec(sql, (err, rows) => {
        if (err) { _conn = null; return reject(err); }
        resolve(rows || []);
      });
    }
  });
}

function isAlreadyExists(e) {
  const m = (e.message || '').toLowerCase();
  return m.includes('already exists')
    || m.includes('duplicate table name')
    || m.includes('cannot use duplicate')
    || m.includes('existing object');
}

// ── Bootstrap — create sequence + table if not exists ────────────────────────
// NOTE: No inline SQL comments (--) inside CREATE TABLE — HANA rejects them.
async function bootstrap(schema) {
  console.log('[VENDOR STORE] Checking table', tbl(schema), '...');

  await exec(`CREATE SEQUENCE ${seq(schema)} START WITH 1 INCREMENT BY 1`).catch(e => {
    if (!isAlreadyExists(e)) console.warn('[VENDOR STORE] Sequence warning:', e.message);
    else console.log('[VENDOR STORE] Sequence already exists — OK');
  });

  let tableExisted = false;
  await exec(`
    CREATE COLUMN TABLE ${tbl(schema)} (
      "ID"                    INTEGER NOT NULL PRIMARY KEY,
      "STATUS"                NVARCHAR(30)    DEFAULT 'PENDING',
      "VENDOR_TYPE"           NVARCHAR(20)    DEFAULT 'SUPPLIER',
      "CARD_NAME"             NVARCHAR(100),
      "FOREIGN_NAME"          NVARCHAR(100),
      "TYPE_OF_BUSINESS"      NVARCHAR(50),
      "INDUSTRY"              NVARCHAR(100),
      "PRODUCTS"              NVARCHAR(500),
      "PAYMENT_TERMS"         NVARCHAR(50),
      "CONTACT_FIRST"         NVARCHAR(60),
      "CONTACT_LAST"          NVARCHAR(60),
      "CONTACT_TITLE"         NVARCHAR(60),
      "MOBILE"                NVARCHAR(20),
      "ALT_CONTACT"           NVARCHAR(20),
      "EMAIL"                 NVARCHAR(150),
      "BILL_STREET"           NVARCHAR(200),
      "BILL_BLOCK"            NVARCHAR(100),
      "BILL_CITY"             NVARCHAR(100),
      "BILL_ZIP"              NVARCHAR(20),
      "BILL_STATE"            NVARCHAR(100),
      "BILL_COUNTRY"          NVARCHAR(60),
      "GSTIN"                 NVARCHAR(15),
      "PAN"                   NVARCHAR(10),
      "TAN"                   NVARCHAR(10),
      "CURRENCY"              NVARCHAR(50),
      "HAS_TDS"               NVARCHAR(1)     DEFAULT 'N',
      "TDS_CATEGORY"          NVARCHAR(100),
      "TDS_RATE"              DECIMAL(5,2)    DEFAULT 0,
      "TDS_LDC_NO"            NVARCHAR(50),
      "HAS_MSME"              NVARCHAR(1)     DEFAULT 'N',
      "MSME_NO"               NVARCHAR(30),
      "MSME_TYPE"             NVARCHAR(20),
      "MSME_BTYPE"            NVARCHAR(30),
      "FSSAI_NO"              NVARCHAR(20),
      "REMARKS"               NCLOB,
      "BANK_ACCOUNTS"         NCLOB,
      "ATTACHMENTS"           NCLOB,
      "USER_ID"               NVARCHAR(50),
      "USER_TYPE"             NVARCHAR(50),
      "USER_DEPT"             NVARCHAR(100),
      "SUBMITTED_AT"          TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
      "MGR_CARD_CODE_PREFIX"  NVARCHAR(20)    DEFAULT 'VENDA',
      "MGR_GROUP_CODE"        INTEGER,
      "MGR_GROUP"             NVARCHAR(100),
      "MGR_PAY_TERMS_CODE"    INTEGER,
      "MGR_PAY_TERMS"         NVARCHAR(100),
      "MGR_PURCHASE_ACCOUNT"  NVARCHAR(20)    DEFAULT '2101001',
      "MGR_PURCHASE_ACCT_NAME" NVARCHAR(100),
      "MGR_CURRENCY"          NVARCHAR(50)    DEFAULT 'Indian Rupee',
      "MGR_LANGUAGE"          NVARCHAR(50)    DEFAULT 'English (UK)',
      "MGR_CREDIT_LIMIT"      DECIMAL(18,2)   DEFAULT 0,
      "MGR_NOTES"             NCLOB,
      "MGR_BRANCH"            NVARCHAR(100),
      "MGR_AREA"              NVARCHAR(100),
      "MGR_TERRITORY"         NVARCHAR(100),
      "VERIFIED_BY"           NVARCHAR(60),
      "VERIFIED_AT"           TIMESTAMP,
      "APPROVED_BY"           NVARCHAR(60),
      "APPROVED_AT"           TIMESTAMP,
      "REJECTED_BY"           NVARCHAR(60),
      "REJECTED_AT"           TIMESTAMP,
      "SAP_CARD_CODE"         NVARCHAR(30),
      "SAP_ATTACHMENT_ENTRY"  INTEGER
    )
  `).catch(e => {
    if (isAlreadyExists(e)) {
      tableExisted = true;
      console.log('[VENDOR STORE] Table already exists — checking for missing columns...');
    } else {
      throw e;
    }
  });

  // Run migrations if table already existed
  if (tableExisted) {
    const migrations = [
      `ALTER TABLE ${tbl(schema)} ADD ("MGR_SALES_PERSON_CODE" INTEGER)`,
      `ALTER TABLE ${tbl(schema)} ADD ("MGR_SALES_EMPLOYEE" NVARCHAR(100))`,
      `ALTER TABLE ${tbl(schema)} ADD ("COMPANY" NVARCHAR(50) DEFAULT 'JIVO_OIL_HANADB')`,
      `ALTER TABLE ${tbl(schema)} ADD ("MSME_BTYPE" NVARCHAR(30))`,
      `ALTER TABLE ${tbl(schema)} ADD ("FSSAI_NO" NVARCHAR(20))`,
    ];
    for (const sql of migrations) {
      await exec(sql).catch(e => {
        const em = (e.message || '').toLowerCase();
        if (!em.includes('column') && !em.includes('duplicate') && !isAlreadyExists(e)) {
          console.warn('[VENDOR STORE] Migration warning:', e.message);
        }
      });
    }
    console.log('[VENDOR STORE] ✅ Column migration check complete');
  }

  console.log('[VENDOR STORE] ✅ Table ready:', tbl(schema));
}

// ── Row → JS object ───────────────────────────────────────────────────────────
function rowToVendor(row) {
  if (!row) return null;
  let bankAccounts = [];
  let attachments  = {};
  try { bankAccounts = JSON.parse(row.BANK_ACCOUNTS || '[]'); } catch (_) {}
  try { attachments  = JSON.parse(row.ATTACHMENTS   || '{}'); } catch (_) {}

  return {
    id:                   row.ID,
    status:               row.STATUS,
    vendorType:           row.VENDOR_TYPE        || 'SUPPLIER',
    cardName:             row.CARD_NAME          || '',
    foreignName:          row.FOREIGN_NAME       || '',
    typeOfBusiness:       row.TYPE_OF_BUSINESS   || '',
    industry:             row.INDUSTRY           || '',
    products:             row.PRODUCTS           || '',
    paymentTerms:         row.PAYMENT_TERMS      || '30 Days',
    contactFirst:         row.CONTACT_FIRST      || '',
    contactLast:          row.CONTACT_LAST       || '',
    contactTitle:         row.CONTACT_TITLE      || '',
    mobile:               row.MOBILE             || '',
    altContact:           row.ALT_CONTACT        || '',
    email:                row.EMAIL              || '',
    billStreet:           row.BILL_STREET        || '',
    billBlock:            row.BILL_BLOCK         || '',
    billCity:             row.BILL_CITY          || '',
    billZip:              row.BILL_ZIP           || '',
    billState:            row.BILL_STATE         || '',
    billCountry:          row.BILL_COUNTRY       || 'India',
    gstin:                row.GSTIN              || '',
    pan:                  row.PAN                || '',
    tan:                  row.TAN                || '',
    currency:             row.CURRENCY           || 'Indian Rupee',
    hasTds:               row.HAS_TDS === 'Y',
    tdsCategory:          row.TDS_CATEGORY       || '',
    tdsRate:              Number(row.TDS_RATE)   || 0,
    tdsLdcNo:             row.TDS_LDC_NO        || '',
    hasMsme:              row.HAS_MSME === 'Y',
    msmeNo:               row.MSME_NO           || '',
    msmeType:             row.MSME_TYPE         || '',
    msmeBType:            row.MSME_BTYPE        || '',
    fssaiNo:              row.FSSAI_NO          || '',
    remarks:              row.REMARKS           || '',
    bankAccounts,
    attachments,
    userId:               row.USER_ID           || '',
    userType:             row.USER_TYPE         || '',
    userDept:             row.USER_DEPT         || '',
    submittedAt:          row.SUBMITTED_AT      ? new Date(row.SUBMITTED_AT).toISOString() : null,
    mgrCardCodePrefix:    row.MGR_CARD_CODE_PREFIX || 'VENDA',
    mgrGroupCode:         row.MGR_GROUP_CODE,
    mgrGroup:             row.MGR_GROUP          || '',
    mgrPayTermsCode:      row.MGR_PAY_TERMS_CODE,
    mgrPayTerms:          row.MGR_PAY_TERMS      || '',
    mgrPurchaseAccount:   row.MGR_PURCHASE_ACCOUNT    || '2101001',
    mgrPurchaseAcctName:  row.MGR_PURCHASE_ACCT_NAME  || '',
    mgrCurrency:          row.MGR_CURRENCY       || 'Indian Rupee',
    mgrLanguage:          row.MGR_LANGUAGE       || 'English (UK)',
    mgrCreditLimit:       Number(row.MGR_CREDIT_LIMIT) || 0,
    mgrNotes:             row.MGR_NOTES         || '',
    mgrBranch:            row.MGR_BRANCH        || '',
    mgrArea:              row.MGR_AREA          || '',
    mgrTerritory:         row.MGR_TERRITORY     || '',
    verifiedBy:           row.VERIFIED_BY       || null,
    verifiedAt:           row.VERIFIED_AT       ? new Date(row.VERIFIED_AT).toISOString() : null,
    approvedBy:           row.APPROVED_BY       || null,
    approvedAt:           row.APPROVED_AT       ? new Date(row.APPROVED_AT).toISOString() : null,
    rejectedBy:           row.REJECTED_BY       || null,
    rejectedAt:           row.REJECTED_AT       ? new Date(row.REJECTED_AT).toISOString() : null,
    sapCardCode:          row.SAP_CARD_CODE     || null,
    sapAttachmentEntry:   row.SAP_ATTACHMENT_ENTRY || null,
    company:              row.COMPANY             || '',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toTs(isoStr) {
  if (!isoStr) return null;
  return isoStr.replace('T', ' ').replace('Z', '').substring(0, 23);
}

function s(v, max) {
  if (v === null || v === undefined) return null;
  const str = String(v);
  return max ? str.substring(0, max) : str;
}

// ── INSERT (uses sequence + parameterised query — matches hanaStore.js) ───────
async function insertVendor(data, _schema) {
  const rows = await exec(`SELECT ${seq()}.NEXTVAL AS "NV" FROM DUMMY`);
  const id = rows[0]?.NV || rows[0]?.nv;
  const now = toTs(new Date().toISOString());

  await exec(`
    INSERT INTO ${tbl()} (
      "ID","VENDOR_TYPE","CARD_NAME","FOREIGN_NAME","TYPE_OF_BUSINESS","INDUSTRY",
      "PRODUCTS","PAYMENT_TERMS",
      "CONTACT_FIRST","CONTACT_LAST","CONTACT_TITLE",
      "MOBILE","ALT_CONTACT","EMAIL",
      "BILL_STREET","BILL_BLOCK","BILL_CITY","BILL_ZIP","BILL_STATE","BILL_COUNTRY",
      "GSTIN","PAN","TAN","CURRENCY",
      "HAS_TDS","TDS_CATEGORY","TDS_RATE","TDS_LDC_NO",
      "HAS_MSME","MSME_NO","MSME_TYPE","MSME_BTYPE","FSSAI_NO",
      "REMARKS","BANK_ACCOUNTS","ATTACHMENTS",
      "USER_ID","USER_TYPE","USER_DEPT",
      "SUBMITTED_AT",
      "MGR_CARD_CODE_PREFIX","MGR_PURCHASE_ACCOUNT","MGR_CURRENCY","MGR_LANGUAGE",
      "COMPANY"
    ) VALUES (
      ?,?,?,?,?,?,
      ?,?,
      ?,?,?,
      ?,?,?,
      ?,?,?,?,?,?,
      ?,?,?,?,
      ?,?,?,?,
      ?,?,?,?,?,
      ?,?,?,
      ?,?,?,
      ?,
      ?,?,?,?,
      ?
    )
  `, [
    id,
    s(data.vendorType   || 'SUPPLIER', 20),
    s(data.cardName,       100),
    s(data.foreignName  || '', 100),
    s(data.typeOfBusiness || 'Company', 50),
    s(data.industry     || '', 100),
    s(data.products     || '', 500),
    s(data.paymentTerms || '30 Days', 50),
    s(data.contactFirst,   60),
    s(data.contactLast,    60),
    s(data.contactTitle || '', 60),
    s(data.mobile       || '', 20),
    s(data.altContact   || '', 20),
    s(data.email,          150),
    s(data.billStreet   || '', 200),
    s(data.billBlock    || '', 100),
    s(data.billCity     || '', 100),
    s(data.billZip      || '', 20),
    s(data.billState    || '', 100),
    s(data.billCountry  || 'India', 60),
    s(data.gstin        || '', 15),
    s(data.pan          || '', 10),
    s(data.tan          || '', 10),
    s(data.currency     || 'Indian Rupee', 50),
    data.hasTds  ? 'Y' : 'N',
    s(data.tdsCategory  || '', 100),
    parseFloat(data.tdsRate) || 0,
    s(data.tdsLdcNo     || '', 50),
    data.hasMsme ? 'Y' : 'N',
    s(data.msmeNo       || '', 30),
    s(data.msmeType     || '', 20),
    s(data.msmeBType    || '', 30),
    s(data.fssaiNo      || '', 20),
    data.remarks || '',
    JSON.stringify(data.bankAccounts || []),
    JSON.stringify(data.attachments  || {}),
    s(data.userId       || '', 50),
    s(data.userType     || '', 50),
    s(data.userDept     || '', 100),
    now,
    s(data.mgrCardCodePrefix   || 'VENDA', 20),
    s(data.mgrPurchaseAccount  || '2101001', 20),
    s(data.mgrCurrency         || 'Indian Rupee', 50),
    s(data.mgrLanguage         || 'English (UK)', 50),
    s(data.company             || '', 50),
  ]);

  console.log(`[VENDOR STORE] ✅ Inserted ID=${id} — ${data.cardName}`);
  return { id };
}

// ── FIND BY ID — always default schema table ─────────────────────────────────
async function findById(id, companyDB) {
  const rows = await exec(
    `SELECT * FROM ${tbl()} WHERE "ID" = ?`,
    [parseInt(id)]
  );
  return rowToVendor(rows[0]);
}

// ── LIST BY STATUS — always default schema, filter by COMPANY column ─────────
async function listByStatus(status, companyDB) {
  let rows;
  if (status === 'ALL') {
    rows = await exec(`SELECT * FROM ${tbl()} ORDER BY "SUBMITTED_AT" DESC`);
  } else {
    rows = await exec(
      `SELECT * FROM ${tbl()} WHERE "STATUS" = ? ORDER BY "SUBMITTED_AT" DESC`,
      [status.toUpperCase()]
    );
  }
  let result = rows.map(rowToVendor);
  if (companyDB) result = result.filter(r => r.company === companyDB);
  return result;
}

// ── UPDATE ────────────────────────────────────────────────────────────────────
async function updateVendor(id, patch, _schema) {
  if (!patch || Object.keys(patch).length === 0) return;

  const COL_MAP = {
    status:               'STATUS',
    vendorType:           'VENDOR_TYPE',
    cardName:             'CARD_NAME',
    foreignName:          'FOREIGN_NAME',
    typeOfBusiness:       'TYPE_OF_BUSINESS',
    industry:             'INDUSTRY',
    products:             'PRODUCTS',
    paymentTerms:         'PAYMENT_TERMS',
    contactFirst:         'CONTACT_FIRST',
    contactLast:          'CONTACT_LAST',
    contactTitle:         'CONTACT_TITLE',
    mobile:               'MOBILE',
    altContact:           'ALT_CONTACT',
    email:                'EMAIL',
    billStreet:           'BILL_STREET',
    billBlock:            'BILL_BLOCK',
    billCity:             'BILL_CITY',
    billZip:              'BILL_ZIP',
    billState:            'BILL_STATE',
    billCountry:          'BILL_COUNTRY',
    gstin:                'GSTIN',
    pan:                  'PAN',
    tan:                  'TAN',
    currency:             'CURRENCY',
    hasTds:               'HAS_TDS',
    tdsCategory:          'TDS_CATEGORY',
    tdsRate:              'TDS_RATE',
    tdsLdcNo:             'TDS_LDC_NO',
    hasMsme:              'HAS_MSME',
    msmeNo:               'MSME_NO',
    msmeType:             'MSME_TYPE',
    msmeBType:            'MSME_BTYPE',
    fssaiNo:              'FSSAI_NO',
    remarks:              'REMARKS',
    bankAccounts:         'BANK_ACCOUNTS',
    attachments:          'ATTACHMENTS',
    verifiedBy:           'VERIFIED_BY',
    verifiedAt:           'VERIFIED_AT',
    approvedBy:           'APPROVED_BY',
    approvedAt:           'APPROVED_AT',
    rejectedBy:           'REJECTED_BY',
    rejectedAt:           'REJECTED_AT',
    sapCardCode:          'SAP_CARD_CODE',
    sapAttachmentEntry:   'SAP_ATTACHMENT_ENTRY',
    mgrCardCodePrefix:    'MGR_CARD_CODE_PREFIX',
    mgrGroupCode:         'MGR_GROUP_CODE',
    mgrGroup:             'MGR_GROUP',
    mgrPayTermsCode:      'MGR_PAY_TERMS_CODE',
    mgrPayTerms:          'MGR_PAY_TERMS',
    mgrPurchaseAccount:   'MGR_PURCHASE_ACCOUNT',
    mgrPurchaseAcctName:  'MGR_PURCHASE_ACCT_NAME',
    mgrCurrency:          'MGR_CURRENCY',
    mgrLanguage:          'MGR_LANGUAGE',
    mgrCreditLimit:       'MGR_CREDIT_LIMIT',
    mgrNotes:             'MGR_NOTES',
    mgrBranch:            'MGR_BRANCH',
    mgrArea:              'MGR_AREA',
    mgrTerritory:         'MGR_TERRITORY',
    company:              'COMPANY',
  };

  const BOOL_COLS   = new Set(['HAS_TDS', 'HAS_MSME']);
  const JSON_COLS   = new Set(['BANK_ACCOUNTS', 'ATTACHMENTS']);
  const NUMBER_COLS = new Set(['MGR_GROUP_CODE', 'MGR_PAY_TERMS_CODE', 'MGR_CREDIT_LIMIT', 'TDS_RATE', 'SAP_ATTACHMENT_ENTRY']);
  const TS_COLS     = new Set(['VERIFIED_AT', 'APPROVED_AT', 'REJECTED_AT']);

  const setClauses = [];
  const vals       = [];

  Object.entries(patch).forEach(([k, v]) => {
    const col = COL_MAP[k];
    if (!col) return;

    setClauses.push(`"${col}" = ?`);

    if (BOOL_COLS.has(col)) {
      vals.push(v ? 'Y' : 'N');
    } else if (JSON_COLS.has(col)) {
      vals.push(JSON.stringify(v || (col === 'ATTACHMENTS' ? {} : [])));
    } else if (NUMBER_COLS.has(col)) {
      vals.push(v === null || v === undefined ? null : Number(v));
    } else if (TS_COLS.has(col)) {
      vals.push(v ? toTs(v) : null);
    } else {
      vals.push(v === null || v === undefined ? null : String(v));
    }
  });

  if (!setClauses.length) return;

  vals.push(parseInt(id));
  await exec(
    `UPDATE ${tbl()} SET ${setClauses.join(', ')} WHERE "ID" = ?`,
    vals
  );
  console.log(`[VENDOR STORE] ✅ Updated ID=${id} (${setClauses.length} fields)`);
}

module.exports = { bootstrap, insertVendor, findById, listByStatus, updateVendor };