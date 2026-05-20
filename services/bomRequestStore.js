// services/bomRequestStore.js
// Stores BOM Create/Update approval requests in HANA: ZBOM_REQUESTS
const hana = require('@sap/hana-client');

const DB_SCHEMA = process.env.SAP_B1_COMPANY || 'TEST_OIL_15122025';
const TABLE     = `"${DB_SCHEMA}"."ZBOM_REQUESTS"`;
const SEQ       = `"${DB_SCHEMA}"."ZBOM_REQUESTS_SEQ"`;

let _conn = null;

async function getConn() {
  if (_conn) return _conn;
  const conn = hana.createConnection();
  await new Promise((res, rej) => {
    conn.connect({
      serverNode:             `${process.env.HANA_HOST}:${process.env.HANA_PORT}`,
      uid:                    process.env.HANA_USER,
      pwd:                    process.env.HANA_PASSWORD,
      encrypt:                'true',
      sslValidateCertificate: 'false',
    }, err => err ? rej(err) : res());
  });
  _conn = conn;
  return _conn;
}

async function exec(sql, params = []) {
  const conn = await getConn();
  return new Promise((resolve, reject) => {
    if (params.length) {
      const stmt = conn.prepare(sql);
      stmt.exec(params, (err, rows) => {
        stmt.drop();
        if (err) { _conn = null; reject(err); } else resolve(rows || []);
      });
    } else {
      conn.exec(sql, (err, rows) => {
        if (err) { _conn = null; reject(err); } else resolve(rows || []);
      });
    }
  });
}

function isAlreadyExists(e) {
  const m = (e.message || '').toLowerCase();
  return m.includes('already exists') || m.includes('duplicate table name') || m.includes('existing object');
}

async function bootstrap() {
  console.log('[BOM-STORE] Checking table', TABLE, '...');
  await exec(`CREATE SEQUENCE ${SEQ} START WITH 1 INCREMENT BY 1`).catch(e => {
    if (!isAlreadyExists(e)) console.warn('[BOM-STORE] Seq warning:', e.message);
  });
  await exec(`
    CREATE COLUMN TABLE ${TABLE} (
      ID             INTEGER NOT NULL PRIMARY KEY,
      TYPE           NVARCHAR(10) NOT NULL,
      ITEM_CODE      NVARCHAR(50) NOT NULL,
      ITEM_NAME      NVARCHAR(200),
      QTY            DECIMAL(18,4) DEFAULT 1,
      BOM_TYPE       NVARCHAR(30) DEFAULT 'Production',
      WAREHOUSE      NVARCHAR(20),
      DISTR_RULE     NVARCHAR(50),
      PROJECT        NVARCHAR(50),
      COMPONENTS     NCLOB,
      ORIGINAL_DATA  NCLOB,
      STATUS         NVARCHAR(30) DEFAULT 'PENDING',
      SUBMITTED_BY   NVARCHAR(50),
      SUBMITTED_NAME NVARCHAR(100),
      SUBMITTED_AT   TIMESTAMP,
      APPROVAL_LOG   NCLOB,
      REJECTED_BY    NVARCHAR(50),
      REJECTED_AT    TIMESTAMP,
      SAP_PUSHED_AT  TIMESTAMP,
      SAP_PUSHED_BY  NVARCHAR(50),
      SAP_RESULT     NCLOB,
      COMPANY        NVARCHAR(60)
    )
  `).catch(e => {
    if (isAlreadyExists(e)) { console.log('[BOM-STORE] Table exists — OK'); }
    else throw e;
  });
  // Migration: add COMPANY column if missing
  await exec(`ALTER TABLE ${TABLE} ADD (COMPANY NVARCHAR(60))`).catch(e => {
    const m = (e.message||'').toLowerCase();
    if (m.includes('duplicate') || m.includes('already exists') || m.includes('column name already')) { /* OK */ }
    else console.warn('[BOM-STORE] COMPANY column migration:', e.message);
  });
  console.log('[BOM-STORE] ✅ Ready');
}

function toTs(isoStr) {
  if (!isoStr) return null;
  return isoStr.replace('T', ' ').replace('Z', '').substring(0, 23);
}

function fromRow(row) {
  if (!row) return null;
  return {
    id:            row.ID,
    type:          row.TYPE,
    itemCode:      row.ITEM_CODE || '',
    itemName:      row.ITEM_NAME || '',
    qty:           Number(row.QTY) || 1,
    bomType:       row.BOM_TYPE || 'Production',
    warehouse:     row.WAREHOUSE || '',
    distrRule:     row.DISTR_RULE || '',
    project:       row.PROJECT || '',
    components:    safeJson(row.COMPONENTS, []),
    originalData:  safeJson(row.ORIGINAL_DATA, null),
    status:        row.STATUS || 'PENDING',
    submittedBy:   row.SUBMITTED_BY || '',
    submittedByName: row.SUBMITTED_NAME || '',
    submittedAt:   row.SUBMITTED_AT ? new Date(row.SUBMITTED_AT).toISOString() : null,
    approvalLog:   safeJson(row.APPROVAL_LOG, []),
    rejectedBy:    row.REJECTED_BY || null,
    rejectedAt:    row.REJECTED_AT ? new Date(row.REJECTED_AT).toISOString() : null,
    sapPushedAt:   row.SAP_PUSHED_AT ? new Date(row.SAP_PUSHED_AT).toISOString() : null,
    sapPushedBy:   row.SAP_PUSHED_BY || null,
    sapResult:     safeJson(row.SAP_RESULT, null),
    company:       row.COMPANY || '',
  };
}

function safeJson(val, fallback) {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

async function insertBomRequest(b) {
  const rows = await exec(`SELECT "${DB_SCHEMA}"."ZBOM_REQUESTS_SEQ".NEXTVAL AS "NV" FROM DUMMY`);
  const id   = rows[0].NV || rows[0].nv || rows[0]['NV'];
  const now  = toTs(new Date().toISOString());

  await exec(`
    INSERT INTO ${TABLE} (
      ID, TYPE, ITEM_CODE, ITEM_NAME, QTY, BOM_TYPE, WAREHOUSE, DISTR_RULE, PROJECT,
      COMPONENTS, ORIGINAL_DATA, STATUS, SUBMITTED_BY, SUBMITTED_NAME, SUBMITTED_AT,
      APPROVAL_LOG, COMPANY
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    id, b.type, b.itemCode, b.itemName || '', Number(b.qty) || 1,
    b.bomType || 'Production', b.warehouse || '', b.distrRule || '', b.project || '',
    JSON.stringify(b.components || []),
    b.originalData ? JSON.stringify(b.originalData) : null,
    'PENDING', b.submittedBy, b.submittedByName || b.submittedBy, now,
    JSON.stringify([]),
    b.company || '',
  ]);
  return { id, ...b, status: 'PENDING', submittedAt: new Date().toISOString(), approvalLog: [] };
}

async function listRequests({ status, type, mine, company } = {}) {
  // Fetch all then filter in JS for reliability
  const all = await exec(`SELECT * FROM ${TABLE} ORDER BY SUBMITTED_AT DESC`);
  return all.map(fromRow).filter(r => {
    if (status && status !== 'ALL' && r.status !== status.toUpperCase()) return false;
    if (type && r.type !== type.toUpperCase()) return false;
    if (mine && r.submittedBy !== mine) return false;
    if (company && r.company && r.company !== company) return false;
    return true;
  });
}

async function findById(id) {
  const rows = await exec(`SELECT * FROM ${TABLE} WHERE ID = ?`, [parseInt(id)]);
  return rows.length ? fromRow(rows[0]) : null;
}

async function updateRequest(id, patch) {
  const FIELD_MAP = {
    status:       'STATUS',
    approvalLog:  'APPROVAL_LOG',
    rejectedBy:   'REJECTED_BY',
    rejectedAt:   'REJECTED_AT',
    sapPushedAt:  'SAP_PUSHED_AT',
    sapPushedBy:  'SAP_PUSHED_BY',
    sapResult:    'SAP_RESULT',
  };

  function prepareValue(key, val) {
    if (key === 'approvalLog' || key === 'sapResult') return JSON.stringify(val || []);
    if (key === 'rejectedAt' || key === 'sapPushedAt') return toTs(val);
    return val;
  }

  const sets = []; const vals = [];
  for (const [jsKey, colName] of Object.entries(FIELD_MAP)) {
    if (patch[jsKey] !== undefined) {
      sets.push(`${colName} = ?`);
      vals.push(prepareValue(jsKey, patch[jsKey]));
    }
  }
  if (!sets.length) return;
  vals.push(parseInt(id));
  await exec(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE ID = ?`, vals);
}

async function getStats() {
  const rows = await exec(`
    SELECT STATUS, TYPE, COUNT(*) AS CNT
    FROM ${TABLE}
    GROUP BY STATUS, TYPE
    ORDER BY STATUS, TYPE
  `);
  const stats = { byStatus: {}, byType: { CREATE: 0, UPDATE: 0 }, total: 0 };
  rows.forEach(r => {
    const s = r.STATUS || r.status || r.S;
    const t = r.TYPE || r.type || r.T;
    const c = Number(r.CNT || r.cnt || r.C) || 0;
    stats.byStatus[s] = (stats.byStatus[s] || 0) + c;
    stats.byType[t] = (stats.byType[t] || 0) + c;
    stats.total += c;
  });
  return stats;
}

module.exports = { bootstrap, insertBomRequest, listRequests, findById, updateRequest, getStats };