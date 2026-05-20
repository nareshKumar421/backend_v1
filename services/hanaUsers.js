// backend/services/hanaUsers.js
// Manages portal users in SAP HANA
//
// USER ROLES:
//   manager    — L1 approver: reviews PENDING BOM requests
//   sr_manager — L2 approver: reviews L1_APPROVED BOM requests
//   sap_adder  — Final approver: pushes to SAP B1, manages portal users
//
// TABLE: ZCUST_USERS
//   ID          INTEGER PRIMARY KEY (sequence)
//   USERNAME    NVARCHAR(50) UNIQUE NOT NULL
//   PASSWORD    NVARCHAR(200)         -- bcrypt hash
//   FULL_NAME   NVARCHAR(100)
//   EMAIL       NVARCHAR(150)
//   ROLE        NVARCHAR(20)          -- 'manager' | 'sr_manager' | 'sap_adder'
//   ACTIVE      TINYINT DEFAULT 1
//   CREATED_AT  TIMESTAMP
//   LAST_LOGIN  TIMESTAMP

const hana   = require('@sap/hana-client');
const bcrypt = require('bcryptjs');

const DB_SCHEMA = process.env.SAP_B1_COMPANY || 'TEST_OIL_15122025';
const TABLE     = `"${DB_SCHEMA}"."ZCUST_USERS"`;
const SEQ       = `"${DB_SCHEMA}"."ZCUST_USERS_SEQ"`;

const VALID_ROLES = ['manager', 'sr_manager', 'sap_adder', 'admin'];

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
  return new Promise((res, rej) => {
    if (params.length) {
      const stmt = conn.prepare(sql);
      stmt.exec(params, (err, rows) => {
        stmt.drop();
        if (err) { _conn = null; rej(err); } else res(rows || []);
      });
    } else {
      conn.exec(sql, (err, rows) => {
        if (err) { _conn = null; rej(err); } else res(rows || []);
      });
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  console.log('[HANA-USERS] Checking user table…');

  const alreadyExists = e => {
    const m = (e.message || '').toLowerCase();
    return m.includes('already exists') || m.includes('duplicate table name')
      || m.includes('cannot use duplicate') || m.includes('existing object');
  };

  // Sequence
  await exec(`CREATE SEQUENCE ${SEQ} START WITH 1 INCREMENT BY 1`).catch(e => {
    if (!alreadyExists(e)) console.warn('[HANA-USERS] Sequence warning:', e.message);
  });

  // Table — ROLE is NVARCHAR(20) to hold 'sr_manager'
  let tableExisted = false;
  await exec(`
    CREATE COLUMN TABLE ${TABLE} (
      ID         INTEGER NOT NULL PRIMARY KEY,
      USERNAME   NVARCHAR(50) NOT NULL,
      PASSWORD   NVARCHAR(200) NOT NULL,
      FULL_NAME  NVARCHAR(100),
      EMAIL      NVARCHAR(150),
      ROLE       NVARCHAR(20) DEFAULT 'manager',
      ACTIVE     TINYINT DEFAULT 1,
      CREATED_AT TIMESTAMP,
      LAST_LOGIN TIMESTAMP
    )
  `).catch(e => {
    if (alreadyExists(e)) {
      tableExisted = true;
      console.log('[HANA-USERS] Table already exists — OK');
    } else throw e;
  });

  // Unique index on USERNAME
  await exec(`CREATE UNIQUE INDEX IDX_ZCUST_USERS_UN ON ${TABLE} (USERNAME)`).catch(() => {});

  // Migration: widen ROLE column + add MODULES column
  if (tableExisted) {
    await exec(`ALTER TABLE ${TABLE} ALTER ("ROLE" NVARCHAR(20))`).catch(() => {});
    await exec(`ALTER TABLE ${TABLE} ADD ("MODULES" NCLOB)`).catch(() => {});
    await exec(`ALTER TABLE ${TABLE} ADD ("SAP_USER_ID" INTEGER)`).catch(() => {});
  }

  // Seed default users if table is empty
  const cntRows = await exec(`SELECT COUNT(*) AS "CNT" FROM ${TABLE}`);
  const cnt = Number(cntRows[0]?.CNT || cntRows[0]?.['CNT'] || 0);

  if (cnt === 0) {
    console.log('[HANA-USERS] Seeding default users…');
    await createUser({ username: 'admin', password: 'Admin@123', fullName: 'System Administrator', email: 'admin@company.com', role: 'admin' });
   
    //await createUser({ username: 'admin',     password: 'Admin@123',     fullName: 'System Admin',      email: 'admin@company.com',      role: 'sap_adder'  });
    await createUser({ username: 'manager1',  password: 'Manager@123',   fullName: 'Field Manager',     email: 'manager@company.com',    role: 'manager'    });
    await createUser({ username: 'srmanager1',password: 'SrMgr@123',     fullName: 'Senior Manager',    email: 'srmgr@company.com',      role: 'sr_manager' });
    console.log('[HANA-USERS] ✅ Seeded: admin (sap_adder) + manager1 (manager) + srmanager1 (sr_manager)');
  }

  console.log('[HANA-USERS] ✅ User table ready');
}

// ── Row → JS object ───────────────────────────────────────────────────────────
function fromRow(r) {
  if (!r) return null;
  return {
    id:        r.ID,
    username:  r.USERNAME,
    fullName:  r.FULL_NAME  || '',
    email:     r.EMAIL      || '',
    role:      r.ROLE       || 'manager',
    active:    r.ACTIVE === 1,
    modules:   safeJson(r.MODULES, null),
    sapUserId: r.SAP_USER_ID || null,
    createdAt: r.CREATED_AT ? new Date(r.CREATED_AT).toISOString() : null,
    lastLogin: r.LAST_LOGIN ? new Date(r.LAST_LOGIN).toISOString() : null,
  };
}

function safeJson(v,fb){if(!v)return fb;try{return JSON.parse(v);}catch(_e){return fb;}}

// ── Create user ───────────────────────────────────────────────────────────────
async function createUser({ username, password, fullName, email, role, modules }) {
  if (!VALID_ROLES.includes(role)) throw new Error(`Invalid role: ${role}. Must be one of: ${VALID_ROLES.join(', ')}`);
  const hash = await bcrypt.hash(password, 10);
  const rows = await exec(`SELECT ${SEQ}.NEXTVAL AS "NV" FROM DUMMY`);
  const id   = rows[0].NV || rows[0].nv || rows[0]['NV'];
  const now  = new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 23);

  await exec(
    `INSERT INTO ${TABLE} (ID, USERNAME, PASSWORD, FULL_NAME, EMAIL, ROLE, ACTIVE, CREATED_AT, MODULES)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, (username || '').toLowerCase(), hash, fullName || '', email || '', role || 'manager', now, modules ? JSON.stringify(modules) : null]
  );
  console.log(`[HANA-USERS] ✅ Created user: ${username} (${role})`);
  return id;
}

// ── Find by username (includes hash for auth) ─────────────────────────────────
async function findByUsername(username) {
  const rows = await exec(
    `SELECT * FROM ${TABLE} WHERE USERNAME = ? AND ACTIVE = 1`,
    [(username || '').toLowerCase()]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { ...fromRow(r), passwordHash: r.PASSWORD };
}

// ── List all users ────────────────────────────────────────────────────────────
async function listUsers() {
  const rows = await exec(`SELECT * FROM ${TABLE} ORDER BY ROLE, USERNAME`);
  return rows.map(fromRow);
}

// ── Find by ID ────────────────────────────────────────────────────────────────
async function findById(id) {
  const rows = await exec(`SELECT * FROM ${TABLE} WHERE ID = ?`, [parseInt(id)]);
  return rows.length ? fromRow(rows[0]) : null;
}

// ── Update user ───────────────────────────────────────────────────────────────
async function updateUser(id, patch) {
  const sets = []; const vals = [];
  if (patch.fullName  !== undefined) { sets.push('FULL_NAME = ?');  vals.push(patch.fullName); }
  if (patch.email     !== undefined) { sets.push('EMAIL = ?');      vals.push(patch.email); }
  if (patch.role      !== undefined) {
    if (!VALID_ROLES.includes(patch.role)) throw new Error(`Invalid role: ${patch.role}`);
    sets.push('ROLE = ?'); vals.push(patch.role);
  }
  if (patch.active    !== undefined) { sets.push('ACTIVE = ?');     vals.push(patch.active ? 1 : 0); }
  if (patch.modules   !== undefined) { sets.push('MODULES = ?');   vals.push(JSON.stringify(patch.modules)); }
  if (patch.sapUserId !== undefined) { sets.push('SAP_USER_ID = ?'); vals.push(parseInt(patch.sapUserId)||null); }
  if (patch.password) {
    const hash = await bcrypt.hash(patch.password, 10);
    sets.push('PASSWORD = ?'); vals.push(hash);
  }
  if (!sets.length) return;
  vals.push(parseInt(id));
  await exec(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE ID = ?`, vals);
  console.log(`[HANA-USERS] ✅ Updated user ID=${id} (${sets.length} fields)`);
}

// ── Update last login ─────────────────────────────────────────────────────────
async function touchLastLogin(id) {
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 23);
  await exec(`UPDATE ${TABLE} SET LAST_LOGIN = ? WHERE ID = ?`, [now, parseInt(id)]);
}

// ── Delete user ───────────────────────────────────────────────────────────────
async function deleteUser(id) {
  await exec(`DELETE FROM ${TABLE} WHERE ID = ?`, [parseInt(id)]);
  console.log(`[HANA-USERS] ✅ Deleted user ID=${id}`);
}

// ── Verify password ───────────────────────────────────────────────────────────
async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

module.exports = {
  bootstrap,
  createUser,
  findByUsername,
  listUsers,
  findById,
  updateUser,
  deleteUser,
  touchLastLogin,
  verifyPassword,
  VALID_ROLES,
};