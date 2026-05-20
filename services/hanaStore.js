// backend/services/hanaStore.js
// ─────────────────────────────────────────────────────────────────────────────
// Persistent storage for the Customer Registration Portal using SAP HANA.
// All customer submissions are stored in the TEST_OIL_15122025 schema in a
// custom table: ZCUST_PORTAL
//
// TABLE STRUCTURE (auto-created on first run):
//   ZCUST_PORTAL (
//     ID              INTEGER NOT NULL PRIMARY KEY,   -- auto-increment via sequence
//     CARD_NAME       NVARCHAR(200),
//     FOREIGN_NAME    NVARCHAR(200),
//     CUSTOMER_TYPE   NVARCHAR(10),    -- B2B / B2C
//     TYPE_OF_BUSINESS NVARCHAR(50),
//     INDUSTRY        NVARCHAR(100),
//     MOBILE          NVARCHAR(30),
//     EMAIL           NVARCHAR(150),
//     WEBSITE         NVARCHAR(200),
//     CONTACT_FIRST   NVARCHAR(100),
//     CONTACT_LAST    NVARCHAR(100),
//     CONTACT_TITLE   NVARCHAR(100),
//     CONTACT_MOBILE  NVARCHAR(30),
//     CONTACT_EMAIL   NVARCHAR(150),
//     GSTIN           NVARCHAR(20),
//     PAN             NVARCHAR(15),
//     CURRENCY        NVARCHAR(50),
//     REMARKS         NCLOB,
//     -- MSME
//     HAS_MSME        TINYINT DEFAULT 0,
//     MSME_NO         NVARCHAR(30),
//     MSME_TYPE       NVARCHAR(20),
//     MSME_BTYPE      NVARCHAR(20),
//     -- Status & workflow
//     STATUS          NVARCHAR(20) DEFAULT 'PENDING',
//     SUBMITTED_AT    TIMESTAMP,
//     VERIFIED_AT     TIMESTAMP,
//     APPROVED_AT     TIMESTAMP,
//     APPROVED_BY     NVARCHAR(100),
//     SAP_CARD_CODE   NVARCHAR(50),
//     SAP_ATT_ENTRY   INTEGER,
//     -- Billing address (primary)
//     BILL_ADDR_NAME  NVARCHAR(100),
//     BILL_STREET     NVARCHAR(200),
//     BILL_BLOCK      NVARCHAR(200),
//     BILL_CITY       NVARCHAR(100),
//     BILL_ZIP        NVARCHAR(20),
//     BILL_STATE      NVARCHAR(10),
//     BILL_COUNTRY    NVARCHAR(100),
//     -- Shipping address (primary)
//     SHIP_ADDR_NAME  NVARCHAR(100),
//     SHIP_STREET     NVARCHAR(200),
//     SHIP_BLOCK      NVARCHAR(200),
//     SHIP_CITY       NVARCHAR(100),
//     SHIP_ZIP        NVARCHAR(20),
//     SHIP_STATE      NVARCHAR(10),
//     SHIP_COUNTRY    NVARCHAR(100),
//     SAME_AS_BILL    TINYINT DEFAULT 0,
//     -- Multi-address JSON blobs
//     ALL_BILL_ADDRS  NCLOB,   -- JSON array of billing address objects
//     ALL_SHIP_ADDRS  NCLOB,   -- JSON array of shipping address objects
//     -- Attachments (base64 JSON blob — cleared after SAP upload)
//     ATTACHMENTS     NCLOB,
//     -- Manager fields
//     MGR_PREFIX      NVARCHAR(20) DEFAULT 'CUSTA',
//     MGR_GROUP_CODE  NVARCHAR(20),
//     MGR_GROUP       NVARCHAR(100),
//     MGR_CURRENCY    NVARCHAR(50),
//     MGR_CHAIN       NVARCHAR(50),
//     MGR_MAIN_GROUP  NVARCHAR(50),
//     MGR_BRANCH      NVARCHAR(50),
//     MGR_COUNTRY     NVARCHAR(10),
//     MGR_CITY        NVARCHAR(100),
//     MGR_ZONE        NVARCHAR(100),
//     MGR_AREA        NVARCHAR(100),
//     MGR_SUBAREA     NVARCHAR(100),
//     MGR_COUNTRY_HD  NVARCHAR(100),
//     MGR_RSM         NVARCHAR(100),
//     MGR_ASM         NVARCHAR(100),
//     MGR_SO          NVARCHAR(100),
//     MGR_SR          NVARCHAR(100),
//     MGR_PROMOTER    NVARCHAR(100),
//     MGR_SALES_EMP   NVARCHAR(100),
//     MGR_SLP_CODE    NVARCHAR(20),
//     MGR_SCHEME_TYPE NVARCHAR(100),
//     MGR_TERRITORY   NVARCHAR(100),
//     MGR_NOTES       NCLOB,
//     MGR_CREDIT_LMT  DECIMAL(18,2) DEFAULT 0,
//     MGR_PAY_TERMS   NVARCHAR(100),
//     MGR_PAY_CODE    NVARCHAR(20),
//     MGR_AR_ACCOUNT  NVARCHAR(30),
//     MGR_AR_ACC_NAME NVARCHAR(200),
//     MGR_LANGUAGE    NVARCHAR(50)
//   )
// ─────────────────────────────────────────────────────────────────────────────

const hana = require('@sap/hana-client');

const DEFAULT_SCHEMA = process.env.SAP_B1_COMPANY || 'JIVO_OIL_HANADB';
const tbl = (s) => `"${s || DEFAULT_SCHEMA}"."ZCUST_PORTAL"`;
const seq = (s) => `"${s || DEFAULT_SCHEMA}"."ZCUST_PORTAL_SEQ"`;

// ── Singleton connection ──────────────────────────────────────────────────────
let _conn = null;

async function getConn() {
  if (_conn) return _conn;
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
  console.log('[HANA-STORE] ✅ Connected to', DEFAULT_SCHEMA);
  return _conn;
}

async function exec(sql, params = []) {
  const conn = await getConn();
  return new Promise((resolve, reject) => {
    if (params.length) {
      const stmt = conn.prepare(sql);
      stmt.exec(params, (err, rows) => {
        stmt.drop();
        if (err) { _conn = null; reject(err); }
        else resolve(rows || []);
      });
    } else {
      conn.exec(sql, (err, rows) => {
        if (err) { _conn = null; reject(err); }
        else resolve(rows || []);
      });
    }
  });
}

// ── Check if a HANA error means "object already exists" ─────────────────────
function isAlreadyExists(e) {
  const m = (e.message || '').toLowerCase();
  return m.includes('already exists')
    || m.includes('duplicate table name')
    || m.includes('cannot use duplicate')
    || m.includes('existing object');
}

// ── Bootstrap: create table + sequence if not exists ────────────────────────
async function bootstrap(schema) {
  console.log('[HANA-STORE] Checking table', tbl(schema), '...');
  try {
    // 1. Sequence
    await exec(`CREATE SEQUENCE ${seq(schema)} START WITH 1 INCREMENT BY 1`).catch(e => {
      if (!isAlreadyExists(e)) console.warn('[HANA-STORE] Sequence warning:', e.message);
    });

    // 2. Try to create full table
    let tableExisted = false;
    await exec(`
      CREATE COLUMN TABLE ${tbl(schema)} (
        ID               INTEGER NOT NULL PRIMARY KEY,
        USER_ID          NVARCHAR(50),
        USER_TYPE        NVARCHAR(50),
        USER_DEPT        NVARCHAR(100),
        CARD_NAME        NVARCHAR(200),
        FOREIGN_NAME     NVARCHAR(200),
        CUSTOMER_TYPE    NVARCHAR(10),
        TYPE_OF_BUSINESS NVARCHAR(50),
        INDUSTRY         NVARCHAR(100),
        MOBILE           NVARCHAR(30),
        EMAIL            NVARCHAR(150),
        WEBSITE          NVARCHAR(200),
        CONTACT_FIRST    NVARCHAR(100),
        CONTACT_LAST     NVARCHAR(100),
        CONTACT_TITLE    NVARCHAR(100),
        CONTACT_MOBILE   NVARCHAR(30),
        CONTACT_EMAIL    NVARCHAR(150),
        GSTIN            NVARCHAR(20),
        PAN              NVARCHAR(15),
        CURRENCY         NVARCHAR(50),
        REMARKS          NCLOB,
        HAS_MSME         TINYINT DEFAULT 0,
        MSME_NO          NVARCHAR(30),
        MSME_TYPE        NVARCHAR(20),
        MSME_BTYPE       NVARCHAR(20),
        STATUS           NVARCHAR(20) DEFAULT 'PENDING',
        SUBMITTED_AT     TIMESTAMP,
        VERIFIED_AT      TIMESTAMP,
        APPROVED_AT      TIMESTAMP,
        APPROVED_BY      NVARCHAR(100),
        SAP_CARD_CODE    NVARCHAR(50),
        SAP_ATT_ENTRY    INTEGER,
        BILL_ADDR_NAME   NVARCHAR(100),
        BILL_STREET      NVARCHAR(200),
        BILL_BLOCK       NVARCHAR(200),
        BILL_CITY        NVARCHAR(100),
        BILL_ZIP         NVARCHAR(20),
        BILL_STATE       NVARCHAR(10),
        BILL_COUNTRY     NVARCHAR(100),
        SHIP_ADDR_NAME   NVARCHAR(100),
        SHIP_STREET      NVARCHAR(200),
        SHIP_BLOCK       NVARCHAR(200),
        SHIP_CITY        NVARCHAR(100),
        SHIP_ZIP         NVARCHAR(20),
        SHIP_STATE       NVARCHAR(10),
        SHIP_COUNTRY     NVARCHAR(100),
        SAME_AS_BILL     TINYINT DEFAULT 0,
        ALL_BILL_ADDRS   NCLOB,
        ALL_SHIP_ADDRS   NCLOB,
        ATTACHMENTS      NCLOB,
        MGR_PREFIX       NVARCHAR(20) DEFAULT 'CUSTA',
        MGR_GROUP_CODE   NVARCHAR(20),
        MGR_GROUP        NVARCHAR(100),
        MGR_CURRENCY     NVARCHAR(50),
        MGR_CHAIN        NVARCHAR(50),
        MGR_MAIN_GROUP   NVARCHAR(50),
        MGR_BRANCH       NVARCHAR(50),
        MGR_COUNTRY      NVARCHAR(10),
        MGR_CITY         NVARCHAR(100),
        MGR_ZONE         NVARCHAR(100),
        MGR_AREA         NVARCHAR(100),
        MGR_SUBAREA      NVARCHAR(100),
        MGR_COUNTRY_HD   NVARCHAR(100),
        MGR_RSM          NVARCHAR(100),
        MGR_ASM          NVARCHAR(100),
        MGR_SO           NVARCHAR(100),
        MGR_SR           NVARCHAR(100),
        MGR_PROMOTER     NVARCHAR(100),
        MGR_SALES_EMP    NVARCHAR(100),
        MGR_SLP_CODE     NVARCHAR(20),
        MGR_SCHEME_TYPE  NVARCHAR(100),
        MGR_TERRITORY    NVARCHAR(100),
        MGR_NOTES        NCLOB,
        MGR_CREDIT_LMT   DECIMAL(18,2) DEFAULT 0,
        MGR_PAY_TERMS    NVARCHAR(100),
        MGR_PAY_CODE     NVARCHAR(20),
        MGR_AR_ACCOUNT   NVARCHAR(30),
        MGR_AR_ACC_NAME  NVARCHAR(200),
        MGR_LANGUAGE     NVARCHAR(50),
        COMPANY          NVARCHAR(50) DEFAULT 'JIVO_OIL_HANADB'
      )
    `).catch(e => {
      if (isAlreadyExists(e)) {
        tableExisted = true;
        console.log('[HANA-STORE] Table already exists — checking for missing columns...');
      } else {
        throw e;
      }
    });

    // 3. If table existed, safely add any new columns (migration)
    if (tableExisted) {
      const migrations = [
        `ALTER TABLE ${tbl(schema)} ADD ("USER_ID"   NVARCHAR(50))`,
        `ALTER TABLE ${tbl(schema)} ADD ("USER_TYPE" NVARCHAR(50))`,
        `ALTER TABLE ${tbl(schema)} ADD ("USER_DEPT" NVARCHAR(100))`,
        `ALTER TABLE ${tbl(schema)} ADD ("COMPANY"   NVARCHAR(50) DEFAULT 'JIVO_OIL_HANADB')`,
      ];
      for (const sql of migrations) {
        await exec(sql).catch(e => {
          // Ignore "column already exists" errors
          const em = (e.message || '').toLowerCase();
          if (!em.includes('column') && !em.includes('duplicate') && !isAlreadyExists(e)) {
            console.warn('[HANA-STORE] Migration warning:', e.message);
          }
        });
      }
      console.log('[HANA-STORE] ✅ Column migration check complete');
    }

    console.log('[HANA-STORE] ✅ Table ready:', tbl(schema));
  } catch (err) {
    console.error('[HANA-STORE] ❌ Bootstrap failed:', err.message);
    throw err;
  }
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function toTs(isoStr) {
  if (!isoStr) return null;
  return isoStr.replace('T', ' ').replace('Z', '').substring(0, 23);
}

function fromRow(row) {
  if (!row) return null;
  return {
    id:              row.ID,
    userId:          row.USER_ID     || '',
    userType:        row.USER_TYPE   || '',
    userDept:        row.USER_DEPT   || '',
    cardName:        row.CARD_NAME        || '',
    foreignName:     row.FOREIGN_NAME     || '',
    customerType:    row.CUSTOMER_TYPE    || 'B2B',
    typeOfBusiness:  row.TYPE_OF_BUSINESS || '',
    industry:        row.INDUSTRY         || '',
    mobile:          row.MOBILE           || '',
    email:           row.EMAIL            || '',
    website:         row.WEBSITE          || '',
    contactFirst:    row.CONTACT_FIRST    || '',
    contactLast:     row.CONTACT_LAST     || '',
    contactTitle:    row.CONTACT_TITLE    || '',
    contactMobile:   row.CONTACT_MOBILE   || '',
    contactEmail:    row.CONTACT_EMAIL    || '',
    gstin:           row.GSTIN            || '',
    pan:             row.PAN              || '',
    currency:        row.CURRENCY         || 'Indian Rupee',
    remarks:         row.REMARKS          || '',
    hasMsme:         row.HAS_MSME === 1,
    msmeNo:          row.MSME_NO          || '',
    msmeType:        row.MSME_TYPE        || '',
    msmeBType:       row.MSME_BTYPE       || '',
    status:          row.STATUS           || 'PENDING',
    submittedAt:     row.SUBMITTED_AT     ? new Date(row.SUBMITTED_AT).toISOString() : null,
    verifiedAt:      row.VERIFIED_AT      ? new Date(row.VERIFIED_AT).toISOString()  : null,
    approvedAt:      row.APPROVED_AT      ? new Date(row.APPROVED_AT).toISOString()  : null,
    approvedBy:      row.APPROVED_BY      || null,
    sapCardCode:     row.SAP_CARD_CODE    || null,
    sapAttachmentEntry: row.SAP_ATT_ENTRY || null,
    // Bill
    billAddressName: row.BILL_ADDR_NAME   || '',
    billStreet:      row.BILL_STREET      || '',
    billBlock:       row.BILL_BLOCK       || '',
    billCity:        row.BILL_CITY        || '',
    billZip:         row.BILL_ZIP         || '',
    billState:       row.BILL_STATE       || '',
    billCountry:     row.BILL_COUNTRY     || 'India',
    // Ship
    shipAddressName: row.SHIP_ADDR_NAME   || '',
    shipStreet:      row.SHIP_STREET      || '',
    shipBlock:       row.SHIP_BLOCK       || '',
    shipCity:        row.SHIP_CITY        || '',
    shipZip:         row.SHIP_ZIP         || '',
    shipState:       row.SHIP_STATE       || '',
    shipCountry:     row.SHIP_COUNTRY     || 'India',
    sameAsBill:      row.SAME_AS_BILL === 1,
    allBillAddresses: safeJson(row.ALL_BILL_ADDRS, []),
    allShipAddresses: safeJson(row.ALL_SHIP_ADDRS, []),
    attachments:     safeJson(row.ATTACHMENTS, {}),
    // Manager
    mgrCardCodePrefix:  row.MGR_PREFIX      || 'CUSTA',
    mgrGroupCode:       row.MGR_GROUP_CODE  || '',
    mgrGroup:           row.MGR_GROUP       || '',
    mgrCurrency:        row.MGR_CURRENCY    || 'Indian Rupee',
    mgrChain:           row.MGR_CHAIN       || '',
    mgrMainGroup:       row.MGR_MAIN_GROUP  || '',
    mgrBranch:          row.MGR_BRANCH      || '',
    mgrCountry:         row.MGR_COUNTRY     || 'IN',
    mgrCity:            row.MGR_CITY        || '',
    mgrZone:            row.MGR_ZONE        || '',
    mgrArea:            row.MGR_AREA        || '',
    mgrSubarea:         row.MGR_SUBAREA     || '',
    mgrCountryHead:     row.MGR_COUNTRY_HD  || '',
    mgrRsm:             row.MGR_RSM         || '',
    mgrAsm:             row.MGR_ASM         || '',
    mgrSo:              row.MGR_SO          || '',
    mgrSr:              row.MGR_SR          || '',
    mgrPromoter:        row.MGR_PROMOTER    || '',
    mgrSalesEmployee:   row.MGR_SALES_EMP   || '',
    mgrSalesPersonCode: row.MGR_SLP_CODE    || '',
    mgrSchemeType:      row.MGR_SCHEME_TYPE || '',
    mgrTerritory:       row.MGR_TERRITORY   || '',
    mgrNotes:           row.MGR_NOTES       || '',
    mgrCreditLimit:     row.MGR_CREDIT_LMT  || 0,
    mgrPayTerms:        row.MGR_PAY_TERMS   || '',
    mgrPayTermsCode:    row.MGR_PAY_CODE    || '',
    mgrArAccount:       row.MGR_AR_ACCOUNT  || '1101001',
    mgrArAccountName:   row.MGR_AR_ACC_NAME || 'SUNDRY DEBTORS GT',
    mgrLanguage:        row.MGR_LANGUAGE    || 'English (UK)',
    company:            row.COMPANY         || '',
  };
}

function safeJson(val, fallback) {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

function s(v, max) {
  if (v === null || v === undefined) return null;
  const str = String(v);
  return max ? str.substring(0, max) : str;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

// INSERT — returns new customer object with ID
async function insertCustomer(b, _schema) {
  const rows = await exec(`SELECT ${seq()}.NEXTVAL AS "NV" FROM DUMMY`);
  const id = rows[0].NV || rows[0].nv || rows[0]['NV'];
  const now = toTs(new Date().toISOString());

  await exec(`
    INSERT INTO ${tbl()} (
      ID, USER_ID, USER_TYPE, USER_DEPT,
      CARD_NAME, FOREIGN_NAME, CUSTOMER_TYPE, TYPE_OF_BUSINESS, INDUSTRY,
      MOBILE, EMAIL, WEBSITE,
      CONTACT_FIRST, CONTACT_LAST, CONTACT_TITLE, CONTACT_MOBILE, CONTACT_EMAIL,
      GSTIN, PAN, CURRENCY, REMARKS,
      HAS_MSME, MSME_NO, MSME_TYPE, MSME_BTYPE,
      STATUS, SUBMITTED_AT,
      BILL_ADDR_NAME, BILL_STREET, BILL_BLOCK, BILL_CITY, BILL_ZIP, BILL_STATE, BILL_COUNTRY,
      SHIP_ADDR_NAME, SHIP_STREET, SHIP_BLOCK, SHIP_CITY, SHIP_ZIP, SHIP_STATE, SHIP_COUNTRY,
      SAME_AS_BILL, ALL_BILL_ADDRS, ALL_SHIP_ADDRS, ATTACHMENTS,
      MGR_PREFIX, MGR_AR_ACCOUNT, MGR_AR_ACC_NAME, MGR_CURRENCY, MGR_LANGUAGE,
      COMPANY
    ) VALUES (
      ?,?,?,?,
      ?,?,?,?,?,
      ?,?,?,
      ?,?,?,?,?,
      ?,?,?,?,
      ?,?,?,?,
      ?,?,
      ?,?,?,?,?,?,?,
      ?,?,?,?,?,?,?,
      ?,?,?,?,
      ?,?,?,?,?,
      ?
    )
  `, [
    id,
    s(b.userId, 50), s(b.userType, 50), s(b.userDept, 100),
    s(b.cardName, 200), s(b.foreignName, 200), s(b.customerType || 'B2B', 10),
    s(b.typeOfBusiness, 50), s(b.industry, 100),
    s(b.mobile, 30), s(b.email, 150), s(b.website, 200),
    s(b.contactFirst, 100), s(b.contactLast, 100), s(b.contactTitle, 100),
    s(b.contactMobile, 30), s(b.contactEmail, 150),
    s(b.gstin, 20), s(b.pan, 15), s(b.currency || 'Indian Rupee', 50), b.remarks || '',
    b.hasMsme ? 1 : 0, s(b.msmeNo, 30), s(b.msmeType, 20), s(b.msmeBType, 20),
    'PENDING', now,
    s(b.billAddressName, 100), s(b.billStreet, 200), s(b.billBlock, 200),
    s(b.billCity, 100), s(b.billZip, 20), s(b.billState, 10), s(b.billCountry, 100),
    s(b.shipAddressName, 100), s(b.shipStreet, 200), s(b.shipBlock, 200),
    s(b.shipCity, 100), s(b.shipZip, 20), s(b.shipState, 10), s(b.shipCountry, 100),
    b.sameAsBill ? 1 : 0,
    JSON.stringify(b.allBillAddresses || []),
    JSON.stringify(b.allShipAddresses || []),
    JSON.stringify(b.attachments || {}),
    s(b.mgrCardCodePrefix || 'CUSTA', 20),
    s(b.mgrArAccount || '1101001', 30),
    s(b.mgrArAccountName || 'SUNDRY DEBTORS GT', 200),
    s(b.mgrCurrency || 'Indian Rupee', 50),
    s(b.mgrLanguage || 'English (UK)', 50),
    s(b.company || '', 50),
  ]);

  console.log(`[HANA-STORE] ✅ Inserted ID=${id} — ${b.cardName}`);
  return { id, ...b, status: 'PENDING', submittedAt: new Date().toISOString() };
}

// SELECT ALL by status — always query default schema table, filter by COMPANY
async function listByStatus(status, companyDB) {
  const rows = await exec(
    `SELECT * FROM ${tbl()} WHERE STATUS = ? ORDER BY SUBMITTED_AT DESC`,
    [status.toUpperCase()]
  );
  let result = rows.map(fromRow);
  if (companyDB) result = result.filter(r => r.company === companyDB);
  return result;
}

// SELECT ONE by id — always query default schema table
async function findById(id, companyDB) {
  const rows = await exec(
    `SELECT * FROM ${tbl()} WHERE ID = ?`,
    [parseInt(id)]
  );
  return rows.length ? fromRow(rows[0]) : null;
}

// UPDATE — apply a partial patch object
async function updateCustomer(id, patch, _schema) {
  // Build SET clause dynamically from only provided fields
  const FIELD_MAP = {
    userId:             'USER_ID',
    userType:           'USER_TYPE',
    userDept:           'USER_DEPT',
    cardName:           'CARD_NAME',
    foreignName:        'FOREIGN_NAME',
    customerType:       'CUSTOMER_TYPE',
    typeOfBusiness:     'TYPE_OF_BUSINESS',
    industry:           'INDUSTRY',
    mobile:             'MOBILE',
    email:              'EMAIL',
    website:            'WEBSITE',
    contactFirst:       'CONTACT_FIRST',
    contactLast:        'CONTACT_LAST',
    contactTitle:       'CONTACT_TITLE',
    contactMobile:      'CONTACT_MOBILE',
    contactEmail:       'CONTACT_EMAIL',
    gstin:              'GSTIN',
    pan:                'PAN',
    currency:           'CURRENCY',
    remarks:            'REMARKS',
    hasMsme:            'HAS_MSME',
    msmeNo:             'MSME_NO',
    msmeType:           'MSME_TYPE',
    msmeBType:          'MSME_BTYPE',
    status:             'STATUS',
    verifiedAt:         'VERIFIED_AT',
    approvedAt:         'APPROVED_AT',
    approvedBy:         'APPROVED_BY',
    sapCardCode:        'SAP_CARD_CODE',
    sapAttachmentEntry: 'SAP_ATT_ENTRY',
    billAddressName:    'BILL_ADDR_NAME',
    billStreet:         'BILL_STREET',
    billBlock:          'BILL_BLOCK',
    billCity:           'BILL_CITY',
    billZip:            'BILL_ZIP',
    billState:          'BILL_STATE',
    billCountry:        'BILL_COUNTRY',
    shipAddressName:    'SHIP_ADDR_NAME',
    shipStreet:         'SHIP_STREET',
    shipBlock:          'SHIP_BLOCK',
    shipCity:           'SHIP_CITY',
    shipZip:            'SHIP_ZIP',
    shipState:          'SHIP_STATE',
    shipCountry:        'SHIP_COUNTRY',
    sameAsBill:         'SAME_AS_BILL',
    allBillAddresses:   'ALL_BILL_ADDRS',
    allShipAddresses:   'ALL_SHIP_ADDRS',
    attachments:        'ATTACHMENTS',
    mgrCardCodePrefix:  'MGR_PREFIX',
    mgrGroupCode:       'MGR_GROUP_CODE',
    mgrGroup:           'MGR_GROUP',
    mgrCurrency:        'MGR_CURRENCY',
    mgrChain:           'MGR_CHAIN',
    mgrMainGroup:       'MGR_MAIN_GROUP',
    mgrBranch:          'MGR_BRANCH',
    mgrCountry:         'MGR_COUNTRY',
    mgrCity:            'MGR_CITY',
    mgrZone:            'MGR_ZONE',
    mgrArea:            'MGR_AREA',
    mgrSubarea:         'MGR_SUBAREA',
    mgrCountryHead:     'MGR_COUNTRY_HD',
    mgrRsm:             'MGR_RSM',
    mgrAsm:             'MGR_ASM',
    mgrSo:              'MGR_SO',
    mgrSr:              'MGR_SR',
    mgrPromoter:        'MGR_PROMOTER',
    mgrSalesEmployee:   'MGR_SALES_EMP',
    mgrSalesPersonCode: 'MGR_SLP_CODE',
    mgrSchemeType:      'MGR_SCHEME_TYPE',
    mgrTerritory:       'MGR_TERRITORY',
    mgrNotes:           'MGR_NOTES',
    mgrCreditLimit:     'MGR_CREDIT_LMT',
    mgrPayTerms:        'MGR_PAY_TERMS',
    mgrPayTermsCode:    'MGR_PAY_CODE',
    mgrArAccount:       'MGR_AR_ACCOUNT',
    mgrArAccountName:   'MGR_AR_ACC_NAME',
    mgrLanguage:        'MGR_LANGUAGE',
    company:            'COMPANY',
  };

  // JSON / boolean / timestamp transforms
  function prepareValue(key, val) {
    if (key === 'hasMsme' || key === 'sameAsBill') return val ? 1 : 0;
    if (key === 'allBillAddresses' || key === 'allShipAddresses' || key === 'attachments')
      return JSON.stringify(val || (key === 'attachments' ? {} : []));
    if (key === 'verifiedAt' || key === 'approvedAt') return toTs(val);
    if (key === 'mgrCreditLimit') return parseFloat(val) || 0;
    if (key === 'sapAttachmentEntry') return parseInt(val) || null;
    return val;
  }

  const sets = [];
  const vals = [];
  for (const [jsKey, colName] of Object.entries(FIELD_MAP)) {
    if (patch[jsKey] !== undefined) {
      sets.push(`${colName} = ?`);
      vals.push(prepareValue(jsKey, patch[jsKey]));
    }
  }
  if (!sets.length) return;

  vals.push(parseInt(id));
  await exec(
    `UPDATE ${tbl()} SET ${sets.join(', ')} WHERE ID = ?`,
    vals
  );
  console.log(`[HANA-STORE] ✅ Updated ID=${id} (${sets.length} fields)`);
}

module.exports = { bootstrap, insertCustomer, listByStatus, findById, updateCustomer };