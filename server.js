// ════════════════════════════════════════════════════════════════
//  SAP B1 UNIFIED PORTAL — MULTI-LEVEL BOM APPROVAL SERVER
// ════════════════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');

const { resolve: resolveCompany } = require('./services/companyConfig');
const app    = express();
const SECRET = process.env.JWT_SECRET || 'sap-portal-secret';

// ── MIDDLEWARE FIRST (body parser must come before routes) ───────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════
//  APPROVAL LEVEL CONFIGURATION
// ════════════════════════════════════════════════════════════════
const APPROVAL_LEVELS = parseInt(process.env.BOM_APPROVAL_LEVELS) || 3;

const LEVEL_ROLES = { 1: 'manager', 2: 'sr_manager', 3: 'sap_adder', 4: 'sap_adder' };

const STATUS_FLOW = {
  2: ['DRAFT', 'PENDING', 'L1_APPROVED', 'SAP_PUSHED', 'REJECTED'],
  3: ['DRAFT', 'PENDING', 'L1_APPROVED', 'L2_APPROVED', 'SAP_PUSHED', 'REJECTED'],
  4: ['DRAFT', 'PENDING', 'L1_APPROVED', 'L2_APPROVED', 'L3_APPROVED', 'SAP_PUSHED', 'REJECTED'],
};

function getNextStatus(currentStatus) {
  const flow = STATUS_FLOW[APPROVAL_LEVELS];
  const idx = flow.indexOf(currentStatus);
  if (idx === -1 || idx >= flow.length - 2) return null;
  return flow[idx + 1];
}

function canApproveAtStatus(role, status) {
  if (role === 'admin') return true;
  const approvalMap = {
    2: { PENDING: 'manager',    L1_APPROVED: 'sap_adder' },
    3: { PENDING: 'manager',    L1_APPROVED: 'sr_manager', L2_APPROVED: 'sap_adder' },
    4: { PENDING: 'manager',    L1_APPROVED: 'sr_manager', L2_APPROVED: 'sap_adder', L3_APPROVED: 'sap_adder' },
  };
  return approvalMap[APPROVAL_LEVELS]?.[status] === role;
}

function isFinalApproval(status) {
  const finalMap = { 2: 'L1_APPROVED', 3: 'L2_APPROVED', 4: 'L3_APPROVED' };
  return finalMap[APPROVAL_LEVELS] === status;
}

// ────────────────────────────────────────────────────────────────
// STATIC PAGES
// ────────────────────────────────────────────────────────────────
app.get('/portal',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));
app.get('/bom',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'bom.html')));
app.get('/grpo',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'grpo.html')));
app.get('/production',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'production.html')));
app.get('/issue-production',(req, res) => res.sendFile(path.join(__dirname, 'public', 'issue-production.html')));
app.get('/receipt-production',(req, res) => res.sendFile(path.join(__dirname, 'public', 'receipt-production.html')));
app.get('/close-production', (req, res) => res.sendFile(path.join(__dirname, 'public', 'close-production.html')));
app.get('/budget',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'budget.html')));
app.get('/documents',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'documents.html')));
app.get('/sap-approvals',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'sap-approvals.html')));
app.get('/reports',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'reports.html')));
app.get('/journal-entries',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'journal-entries.html')));
app.get('/approvals',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'approvals.html')));
app.get('/register',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/vendor-register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vendor-register.html')));
app.get('/admin',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/',                (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ════════════════════════════════════════════════════════════════
//  MIDDLEWARE — JWT AUTH
// ════════════════════════════════════════════════════════════════
function verifyToken(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user?.role === 'admin') return next();
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ success: false, message: `Required role: ${roles.join(' or ')}` });
    next();
  };
}

// ════════════════════════════════════════════════════════════════
//  LAZY-LOAD SERVICES
// ════════════════════════════════════════════════════════════════
let hanaStore        = null;
let hanaUsers        = null;
let sapSvc           = null;
let bomStore         = null;
let hanaVendorStore  = null;

function getStore()    { return hanaStore; }
function getUsers()    { return hanaUsers; }
function getSap()      { return sapSvc;    }
function getBomStore() { return bomStore;  }

// ════════════════════════════════════════════════════════════════
//  HANA CONNECTION (shared pool used by server-level routes)
// ════════════════════════════════════════════════════════════════
const hana = require('@sap/hana-client');
let hanaConn       = null;
let hanaConnecting = false;

async function getHanaConn() {
  if (hanaConn) return hanaConn;
  if (hanaConnecting) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (hanaConn) return hanaConn;
    }
    throw new Error('HANA connection timeout');
  }
  hanaConnecting = true;
  try {
    const conn = hana.createConnection();
    await new Promise((resolve, reject) => {
      conn.connect({
        serverNode:            `${process.env.HANA_HOST}:${process.env.HANA_PORT}`,
        uid:                   process.env.HANA_USER,
        pwd:                   process.env.HANA_PASSWORD,
        encrypt:               'true',
        sslValidateCertificate:'false',
      }, err => err ? reject(err) : resolve());
    });
    hanaConn = conn;
    console.log('[HANA] ✅ Connected');
  } catch (err) {
    console.error('[HANA] ❌ Connection failed:', err.message);
    throw err;
  } finally { hanaConnecting = false; }
  return hanaConn;
}

async function hanaQuery(sql) {
  console.log('[HANA] SQL:', sql.slice(0, 120).replace(/\s+/g, ' '));
  const conn = await getHanaConn();
  return new Promise((resolve, reject) => {
    conn.exec(sql, (err, rows) => {
      if (err) {
        try { conn.disconnect(); } catch (_) {}
        hanaConn = null;
        return reject(err);
      }
      console.log(`[HANA] ✅ ${(rows || []).length} rows`);
      resolve(rows || []);
    });
  });
}

const DB = () => `"${process.env.SAP_B1_COMPANY}"`;

async function safeLookup(res, sql, mapFn) {
  try {
    const rows = await hanaQuery(sql);
    return res.json({ success: true, data: rows.map(mapFn) });
  } catch (err) {
    console.warn('[LOOKUP] fallback to empty:', err.message);
    return res.json({ success: true, data: [], warning: err.message });
  }
}

// ════════════════════════════════════════════════════════════════
//  CONFIG  /api/config
// ════════════════════════════════════════════════════════════════
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    approvalLevels: APPROVAL_LEVELS,
    statusFlow: STATUS_FLOW[APPROVAL_LEVELS],
    levelRoles: LEVEL_ROLES,
    approvalMap: {
      2: { PENDING: 'manager', L1_APPROVED: 'sap_adder' },
      3: { PENDING: 'manager', L1_APPROVED: 'sr_manager', L2_APPROVED: 'sap_adder' },
      4: { PENDING: 'manager', L1_APPROVED: 'sr_manager', L2_APPROVED: 'sap_adder', L3_APPROVED: 'sap_adder' },
    }[APPROVAL_LEVELS],
    levelLabels: {
      2: { PENDING: 'Awaiting Manager Review', L1_APPROVED: 'Awaiting SAP Adder Approval' },
      3: { PENDING: 'Awaiting Manager Review', L1_APPROVED: 'Awaiting Senior Manager Review', L2_APPROVED: 'Awaiting SAP Adder Approval' },
      4: { PENDING: 'Awaiting Manager Review', L1_APPROVED: 'Awaiting Senior Manager Review', L2_APPROVED: 'Awaiting SAP Adder L1', L3_APPROVED: 'Awaiting SAP Adder L2' },
    }[APPROVAL_LEVELS],
    custApprovalLevels: parseInt(process.env.CUST_APPROVAL_LEVELS) || 2,
  });
});

// ════════════════════════════════════════════════════════════════
//  AUTH  /api/auth
// ════════════════════════════════════════════════════════════════
const authRouter = express.Router();

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: 'Username and password required' });
  try {
    const userDb = getUsers();
    if (!userDb) return res.status(503).json({ success: false, message: 'Auth service not ready' });
    const user = await userDb.findByUsername(username);
    if (!user) return res.status(401).json({ success: false, message: 'Invalid username or password' });
    const ok = await userDb.verifyPassword(password, user.passwordHash);
    if (!ok) return res.status(401).json({ success: false, message: 'Invalid username or password' });
    await userDb.touchLastLogin(user.id);
    const payload = { id: user.id, username: user.username, role: user.role, name: user.fullName, modules: user.modules, sapUserId: user.sapUserId };
    const token   = jwt.sign(payload, SECRET, { expiresIn: '12h' });
    res.json({ success: true, token, user: payload });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

authRouter.get('/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false });
  try {
    const user = jwt.verify(token, SECRET);
    res.json({ success: true, user });
  } catch { res.status(401).json({ success: false }); }
});

app.use('/api/auth', authRouter);

// ════════════════════════════════════════════════════════════════
//  USERS  /api/users
// ════════════════════════════════════════════════════════════════
const usersRouter = express.Router();

usersRouter.get('/', verifyToken, requireRole('sap_adder'), async (req, res) => {
  try {
    const users = await getUsers().listUsers();
    res.json({ success: true, data: users });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

usersRouter.post('/', verifyToken, requireRole('sap_adder'), async (req, res) => {
  const { username, password, fullName, email, role, modules } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: 'Username and password are required' });
  if (!['manager', 'sr_manager', 'sap_adder', 'admin'].includes(role))
    return res.status(400).json({ success: false, message: 'Invalid role' });
  try {
    const id = await getUsers().createUser({ username, password, fullName, email, role, modules });
    res.json({ success: true, message: 'User created', id });
  } catch (err) {
    const msg = err.message?.includes('unique') || err.message?.includes('duplicate')
      ? `Username "${username}" already exists` : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

usersRouter.patch('/:id', verifyToken, requireRole('sap_adder'), async (req, res) => {
  try {
    const existing = await getUsers().findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'User not found' });
    await getUsers().updateUser(req.params.id, req.body);
    res.json({ success: true, message: 'User updated' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

usersRouter.delete('/:id', verifyToken, requireRole('sap_adder'), async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id)
      return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    await getUsers().deleteUser(req.params.id);
    res.json({ success: true, message: 'User deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.use('/api/users', usersRouter);

// ════════════════════════════════════════════════════════════════
//  BOM APPROVAL  /api/bom-requests
// ════════════════════════════════════════════════════════════════
const TREE_TYPE_MAP = {
  production: 'iProductionTree', sales: 'iSalesTree',
  assembly: 'iAssemblyTree', template: 'iTemplateTree', disassembly: 'iDisassemblyTree',
};
const ISSUE_METHOD_MAP = {
  Manual: 'im_Manual', Backflush: 'im_Backflush',
  Stock: 'im_Backflush', 'Non-Stock': 'im_Manual', Phantom: 'im_Manual', Fixed: 'im_Backflush',
};

const bomRequestRouter = express.Router();

bomRequestRouter.post('/direct-create', verifyToken, requireRole('admin'), [
  body('itemCode').notEmpty(), body('itemName').notEmpty(),
  body('qty').isFloat({ gt: 0 }), body('components').isArray({ min: 1 }),
], async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ success: false, errors: errs.array() });
  try {
    const store = getBomStore();
    const b = req.body;
    const request = await store.insertBomRequest({
      type: 'CREATE', itemCode: b.itemCode.trim().toUpperCase(),
      itemName: b.itemName.trim().toUpperCase(), qty: Number(b.qty) || 1,
      bomType: b.bomType || 'Production', warehouse: b.warehouse || '',
      distrRule: b.distrRule || '', project: b.project || '',
      components: b.components || [], submittedBy: req.user.username,
      submittedByName: req.user.name || req.user.username, status: 'PENDING', approvalLog: [],
      company: b.company || '',
    });
    const sapResult = await pushBomToSap({ ...b, id: request.id, itemCode: b.itemCode.trim().toUpperCase(), itemName: b.itemName.trim().toUpperCase(), type: 'CREATE' });
    const logEntry = { username: req.user.username, name: req.user.name || req.user.username, role: 'admin', action: 'approve', comment: 'Admin direct push', status: 'PENDING', timestamp: new Date().toISOString() };
    await store.updateRequest(request.id, { status: 'SAP_PUSHED', approvalLog: [logEntry], sapPushedAt: new Date().toISOString(), sapPushedBy: req.user.username, sapResult });
    res.json({ success: true, message: 'BOM created directly in SAP B1!', id: request.id, sapResult });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

bomRequestRouter.post('/direct-update', verifyToken, requireRole('admin'), [
  body('treeCode').notEmpty(), body('components').isArray({ min: 1 }),
], async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ success: false, errors: errs.array() });
  try {
    const store = getBomStore();
    const b = req.body;
    const request = await store.insertBomRequest({
      type: 'UPDATE', itemCode: b.treeCode.trim().toUpperCase(), itemName: b.itemName || '',
      qty: Number(b.qty) || 1, bomType: b.bomType || 'Production', warehouse: b.warehouse || '',
      distrRule: '', project: '', components: b.components || [],
      submittedBy: req.user.username, submittedByName: req.user.name || req.user.username,
      status: 'PENDING', approvalLog: [], company: b.company || '',
    });
    const sapResult = await pushBomToSap({ ...b, id: request.id, itemCode: b.treeCode.trim().toUpperCase(), itemName: b.itemName || '', type: 'UPDATE' });
    const logEntry = { username: req.user.username, name: req.user.name || req.user.username, role: 'admin', action: 'approve', comment: 'Admin direct push', status: 'PENDING', timestamp: new Date().toISOString() };
    await store.updateRequest(request.id, { status: 'SAP_PUSHED', approvalLog: [logEntry], sapPushedAt: new Date().toISOString(), sapPushedBy: req.user.username, sapResult });
    res.json({ success: true, message: 'BOM updated directly in SAP B1!', id: request.id, sapResult });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

bomRequestRouter.post('/create', verifyToken, [
  body('itemCode').notEmpty(), body('itemName').notEmpty(),
  body('qty').isFloat({ gt: 0 }), body('components').isArray({ min: 1 }),
], async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ success: false, errors: errs.array() });
  try {
    const store = getBomStore();
    if (!store) return res.status(503).json({ success: false, message: 'Service not ready' });
    const b = req.body;
    if (req.user.role === 'admin') {
      try {
        const sapResult = await pushBomToSap({ ...b, id: 'DIRECT-' + Date.now(), itemCode: b.itemCode.trim().toUpperCase(), itemName: b.itemName.trim().toUpperCase(), type: 'CREATE' });
        const request = await store.insertBomRequest({
          type: 'CREATE', itemCode: b.itemCode.trim().toUpperCase(), itemName: b.itemName.trim().toUpperCase(),
          qty: Number(b.qty) || 1, bomType: b.bomType || 'Production', warehouse: b.warehouse || '',
          distrRule: b.distrRule || '', project: b.project || '', components: b.components || [],
          submittedBy: req.user.username, submittedByName: req.user.name || req.user.username,
          status: 'SAP_PUSHED', approvalLog: [{ username: req.user.username, role: 'admin', action: 'approve', comment: 'Admin direct push', timestamp: new Date().toISOString() }],
          company: b.company || '',
        });
        await store.updateRequest(request.id, { status: 'SAP_PUSHED', sapPushedAt: new Date().toISOString(), sapPushedBy: req.user.username, sapResult });
        return res.json({ success: true, message: 'BOM created directly in SAP B1!', id: request.id, sapResult, status: 'SAP_PUSHED' });
      } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
    }
    const request = await store.insertBomRequest({
      type: 'CREATE', itemCode: b.itemCode.trim().toUpperCase(), itemName: b.itemName.trim().toUpperCase(),
      qty: Number(b.qty) || 1, bomType: b.bomType || 'Production', warehouse: b.warehouse || '',
      distrRule: b.distrRule || '', project: b.project || '', components: b.components || [],
      submittedBy: req.user.username, submittedByName: req.user.name || req.user.username,
      status: 'PENDING', approvalLog: [], company: b.company || '',
    });
    res.json({ success: true, message: 'BOM Create request submitted for approval', id: request.id, status: 'PENDING' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

bomRequestRouter.post('/update', verifyToken, [
  body('treeCode').notEmpty(), body('components').isArray({ min: 1 }),
], async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ success: false, errors: errs.array() });
  try {
    const store = getBomStore();
    if (!store) return res.status(503).json({ success: false, message: 'Service not ready' });
    const b = req.body;
    if (req.user.role === 'admin') {
      try {
        const sapResult = await pushBomToSap({ ...b, itemCode: b.treeCode.trim().toUpperCase(), itemName: b.itemName || '', type: 'UPDATE' });
        const request = await store.insertBomRequest({
          type: 'UPDATE', itemCode: b.treeCode.trim().toUpperCase(), itemName: b.itemName || '',
          qty: Number(b.qty) || 1, bomType: b.bomType || 'Production', warehouse: b.warehouse || '',
          distrRule: '', project: '', components: b.components || [],
          submittedBy: req.user.username, submittedByName: req.user.name || req.user.username,
          status: 'SAP_PUSHED', approvalLog: [{ username: req.user.username, role: 'admin', action: 'approve', comment: 'Admin direct push', timestamp: new Date().toISOString() }],
          company: b.company || '',
        });
        await store.updateRequest(request.id, { status: 'SAP_PUSHED', sapPushedAt: new Date().toISOString(), sapPushedBy: req.user.username, sapResult });
        return res.json({ success: true, message: 'BOM updated directly in SAP B1!', id: request.id, sapResult, status: 'SAP_PUSHED' });
      } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
    }
    const request = await store.insertBomRequest({
      type: 'UPDATE', itemCode: b.treeCode.trim().toUpperCase(), itemName: b.itemName || '',
      qty: Number(b.qty) || 1, bomType: b.bomType || 'Production', warehouse: b.warehouse || '',
      distrRule: '', project: '', components: b.components || [],
      submittedBy: req.user.username, submittedByName: req.user.name || req.user.username,
      status: 'PENDING', approvalLog: [], originalData: b.originalData || null, company: b.company || '',
    });
    res.json({ success: true, message: 'BOM Update request submitted for approval', id: request.id, status: 'PENDING' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

bomRequestRouter.get('/', verifyToken, async (req, res) => {
  try {
    const store = getBomStore();
    if (!store) return res.status(503).json({ success: false, message: 'Service not ready' });
    const { status, type, mine, company } = req.query;
    const requests = await store.listRequests({ status, type, mine: mine === 'true' ? req.user.username : null, company: company || null });
    res.json({ success: true, data: requests });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

bomRequestRouter.get('/:id', verifyToken, async (req, res) => {
  try {
    const store = getBomStore();
    const req2 = await store.findById(req.params.id);
    if (!req2) return res.status(404).json({ success: false, message: 'Request not found' });
    res.json({ success: true, data: req2 });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

bomRequestRouter.patch('/:id/action', verifyToken, async (req, res) => {
  try {
    const store = getBomStore();
    const bomReq = await store.findById(req.params.id);
    if (!bomReq) return res.status(404).json({ success: false, message: 'Request not found' });
    const { action, comment } = req.body;
    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ success: false, message: 'Action must be approve or reject' });
    if (req.user.role !== 'admin' && !canApproveAtStatus(req.user.role, bomReq.status))
      return res.status(403).json({ success: false, message: `Your role (${req.user.role}) cannot act on status: ${bomReq.status}` });
    if (req.user.role !== 'admin') {
      const alreadyApproved = (bomReq.approvalLog || []).some(l => l.username === req.user.username && l.action === 'approve');
      if (alreadyApproved)
        return res.status(400).json({ success: false, message: 'You have already approved this request' });
    }
    const logEntry = { username: req.user.username, name: req.user.name || req.user.username, role: req.user.role, action, comment: comment || '', status: bomReq.status, timestamp: new Date().toISOString() };
    if (action === 'reject') {
      await store.updateRequest(bomReq.id, { status: 'REJECTED', approvalLog: [...(bomReq.approvalLog || []), logEntry], rejectedBy: req.user.username, rejectedAt: new Date().toISOString() });
      return res.json({ success: true, message: 'BOM request rejected', status: 'REJECTED' });
    }
    const isAdminAction = req.user.role === 'admin';
    const isFinal = isAdminAction || isFinalApproval(bomReq.status);
    const nextStatus = isAdminAction ? 'SAP_PUSHED' : getNextStatus(bomReq.status);
    if (!nextStatus) return res.status(400).json({ success: false, message: 'No next status available' });
    let sapResult = null;
    if (isFinal) {
      try { sapResult = await pushBomToSap(bomReq); }
      catch (sapErr) { return res.status(500).json({ success: false, message: 'SAP push failed: ' + sapErr.message }); }
    }
    await store.updateRequest(bomReq.id, {
      status: isFinal ? 'SAP_PUSHED' : nextStatus,
      approvalLog: [...(bomReq.approvalLog || []), logEntry],
      ...(isFinal ? { sapPushedAt: new Date().toISOString(), sapPushedBy: req.user.username, sapResult } : {}),
    });
    res.json({ success: true, message: isFinal ? `BOM ${bomReq.type === 'CREATE' ? 'created' : 'updated'} in SAP B1!` : `Approved — moved to ${nextStatus}`, status: isFinal ? 'SAP_PUSHED' : nextStatus, sapResult });
  } catch (err) {
    console.error('[BOM-APPROVAL] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

async function pushBomToSap(bomReq) {
  const sap = getSap();
  if (!sap) throw new Error('SAP service not available');
  const components = bomReq.components || [];
  if (bomReq.type === 'CREATE') {
    const productTreeLines = components.map((c, idx) => {
      const line = { ItemCode: c.itemCode?.trim().toUpperCase(), Quantity: Number(c.qty) || 1, IssueMethod: ISSUE_METHOD_MAP[c.issueMethod] || 'im_Manual', ItemType: c.itemType === 'pit_Resource' ? 'pit_Resource' : 'pit_Item', VisualOrder: idx, PriceList: -1 };
      if (c.warehouse?.trim()) line.Warehouse = c.warehouse.trim();
      else if (bomReq.warehouse?.trim()) line.Warehouse = bomReq.warehouse.trim();
      if (Number(c.unitCost) > 0) { line.Price = Number(c.unitCost); line.Currency = 'INR'; }
      if (c.note?.trim()) line.Comment = c.note.trim().slice(0, 100);
      return line;
    });
    const payload = { TreeCode: bomReq.itemCode, TreeType: TREE_TYPE_MAP[bomReq.bomType?.toLowerCase()] || 'iProductionTree', Quantity: Number(bomReq.qty) || 1, ProductDescription: bomReq.itemName.slice(0, 100), PriceList: -1, ProductTreeLines: productTreeLines };
    if (bomReq.warehouse?.trim()) payload.Warehouse = bomReq.warehouse.trim();
    if (bomReq.distrRule?.trim()) payload.DistributionRule = bomReq.distrRule.trim();
    if (bomReq.project?.trim())   payload.Project = bomReq.project.trim();
    const co = bomReq.company || null;
    const result = await sap.sapRequest('POST', 'ProductTrees', payload, co);
    return { treeCode: result?.TreeCode || bomReq.itemCode, operation: 'CREATED' };
  } else {
    const code = bomReq.itemCode;
    const co = bomReq.company || null;
    const payload = { TreeType: TREE_TYPE_MAP[bomReq.bomType?.toLowerCase()] || 'iProductionTree', Quantity: Number(bomReq.qty) || 1, Warehouse: bomReq.warehouse || '', PriceList: -1 };
    if (bomReq.itemName) payload.ProductDescription = bomReq.itemName.slice(0, 100);
    payload.ProductTreeLines = components.map((c, idx) => {
      const line = { ItemCode: c.itemCode.toUpperCase(), Quantity: Number(c.qty) || 1, IssueMethod: ISSUE_METHOD_MAP[c.issueMethod] || 'im_Manual', ItemType: c.itemType === 'pit_Resource' ? 'pit_Resource' : 'pit_Item', VisualOrder: c.visualOrder !== undefined ? c.visualOrder : idx, PriceList: -1 };
      if (c.warehouse?.trim()) line.Warehouse = c.warehouse.trim();
      else if (bomReq.warehouse?.trim()) line.Warehouse = bomReq.warehouse.trim();
      return line;
    });
    await sap.sapRequest('PUT', `ProductTrees('${encodeURIComponent(code)}')`, payload, co);
    return { treeCode: code, operation: 'UPDATED' };
  }
}

bomRequestRouter.delete('/:id', verifyToken, async (req, res) => {
  try {
    const store = getBomStore();
    const bomReq = await store.findById(req.params.id);
    if (!bomReq) return res.status(404).json({ success: false, message: 'Request not found' });
    if (bomReq.submittedBy !== req.user.username && req.user.role !== 'sap_adder' && req.user.role !== 'admin')
      return res.status(403).json({ success: false, message: 'Can only cancel your own requests' });
    if (bomReq.status !== 'PENDING')
      return res.status(400).json({ success: false, message: `Cannot cancel request in status: ${bomReq.status}` });
    await store.updateRequest(bomReq.id, { status: 'CANCELLED' });
    res.json({ success: true, message: 'Request cancelled' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.use('/api/bom-requests', bomRequestRouter);

// ════════════════════════════════════════════════════════════════
//  SAP LOOKUPS + GRPO  /api/sap  ← single router from routes/sap.js
//  This replaces ALL inline sapRouter.get() definitions.
//  routes/sap.js handles: items, warehouses, gl-accounts, tax-codes,
//  costing-codes, branches, customers, vendors, sales-employees,
//  payment-terms, ar-accounts, ap-accounts, states, bom/list,
//  bom/:treeCode, bp-groups, and POST /grpo
// ════════════════════════════════════════════════════════════════
app.use('/api/sap', require('./routes/sap'));

// ════════════════════════════════════════════════════════════════
//  VENDORS  /api/vendors
// ════════════════════════════════════════════════════════════════
app.use('/api/vendors', require('./routes/vendors'));

// Vendor BP groups (vendor-specific, kept here for vendor-register page)
app.get('/api/vendors/lookup/bp-groups', verifyToken, async (req, res) => {
  try {
    const sap = getSap();
    if (!sap) return res.json({ success: true, data: [] });
    const result = await sap.sapRequest('GET',
      `BusinessPartnerGroups?$filter=Type eq 'bbpgt_VendorGroup'&$select=Code,Name&$orderby=Name`
    );
    res.json({ success: true, data: (result?.value || []).map(r => ({ GroupCode: r.Code, GroupName: r.Name })) });
  } catch (err) { res.json({ success: true, data: [], warning: err.message }); }
});

app.get('/api/vendors/lookup/ap-accounts', verifyToken, (req, res) =>
  safeLookup(res,
    `SELECT "AcctCode","AcctName" FROM ${DB()}."OACT" WHERE "FatherNum"='2101000' ORDER BY "AcctCode"`,
    r => ({ AcctCode: r.AcctCode, AcctName: r.AcctName })
  )
);

// ════════════════════════════════════════════════════════════════
//  CUSTOMERS  /api/customers
// ════════════════════════════════════════════════════════════════
const CUSTOMER_EDITABLE = [
  'cardName','foreignName','typeOfBusiness','industry','mobile','email','website',
  'contactFirst','contactLast','contactMobile','contactEmail','contactTitle',
  'currency','gstin','pan','remarks','hasMsme','msmeNo','msmeType','msmeBType','attachments',
  'billAddressName','billStreet','billBlock','billCity','billZip','billState','billCountry',
  'shipAddressName','shipStreet','shipBlock','shipCity','shipZip','shipState','shipCountry',
  'sameAsBill','allBillAddresses','allShipAddresses',
];
const MANAGER_EDITABLE = [
  'mgrCardCodePrefix','mgrGroupCode','mgrGroup','mgrCurrency','mgrChain','mgrMainGroup',
  'mgrBranch','mgrCountry','mgrCity','mgrZone','mgrArea','mgrSubarea','mgrCountryHead',
  'mgrRsm','mgrAsm','mgrSo','mgrSr','mgrPromoter','mgrSalesEmployee','mgrSalesPersonCode',
  'mgrSchemeType','mgrTerritory','mgrNotes','mgrCreditLimit','mgrPayTerms','mgrPayTermsCode',
  'mgrArAccount','mgrArAccountName','mgrLanguage',
];
const ALL_EDITABLE = [...CUSTOMER_EDITABLE, ...MANAGER_EDITABLE];

function extractPatch(body, fields) {
  const patch = {};
  fields.forEach(f => { if (body[f] !== undefined) patch[f] = body[f]; });
  return patch;
}
function mapCurrency(label) {
  return { 'Indian Rupee':'INR','US Dollar':'USD','Euro':'EUR','British Pound':'GBP','UAE Dirham':'AED' }[label] || 'INR';
}
function mapCountryCode(name) {
  return { 'India':'IN','United States':'US','United Kingdom':'GB','UAE':'AE','Singapore':'SG','Germany':'DE','Japan':'JP','Australia':'AU' }[name] || 'IN';
}

async function doCreateCustomerInSAP(store, sap, c, patch, req, companyDB) {
  const merged = { ...c, ...patch };
  const prefix = merged.mgrCardCodePrefix || 'CUSTA';
  const cardCode = await sap.getNextCardCode(prefix, companyDB);
  const payTermsGrpCode = merged.mgrPayTermsCode && !isNaN(parseInt(merged.mgrPayTermsCode)) ? parseInt(merged.mgrPayTermsCode) : null;
  const salesPersonCode = merged.mgrSalesPersonCode && !isNaN(parseInt(merged.mgrSalesPersonCode)) ? parseInt(merged.mgrSalesPersonCode) : null;
  const groupCode = merged.mgrGroupCode && !isNaN(parseInt(merged.mgrGroupCode)) ? parseInt(merged.mgrGroupCode) : null;
  const result = await sap.createCustomer({
    cardCode, cardName: merged.cardName, currency: mapCurrency(merged.mgrCurrency || merged.currency),
    phone1: merged.mobile, email: merged.email, website: merged.website,
    creditLimit: parseFloat(merged.mgrCreditLimit) || 0, remarks: merged.remarks,
    typeOfBusiness: merged.typeOfBusiness, groupCode, payTermsGrpCode, salesPersonCode,
    contactFirst: merged.contactFirst, contactLast: merged.contactLast,
    contactMobile: merged.contactMobile || merged.mobile, contactEmail: merged.contactEmail || merged.email,
    contactTitle: merged.contactTitle, billAddressName: merged.billAddressName,
    billStreet: merged.billStreet, billBlock: merged.billBlock, billCity: merged.billCity,
    billZip: merged.billZip, billState: merged.billState, billCountry: mapCountryCode(merged.billCountry),
    shipAddressName: merged.shipAddressName, shipStreet: merged.shipStreet, shipBlock: merged.shipBlock,
    shipCity: merged.shipCity, shipZip: merged.shipZip, shipState: merged.shipState,
    shipCountry: mapCountryCode(merged.shipCountry),
    allBillAddresses: merged.allBillAddresses || [], allShipAddresses: merged.allShipAddresses || [],
    mgrMainGroup: merged.mgrMainGroup, mgrChain: merged.mgrChain, mgrArAccount: merged.mgrArAccount,
    hasMsme: merged.hasMsme, msmeNo: merged.msmeNo || '', msmeType: merged.msmeType || '',
    msmeBType: merged.msmeBType || '', gstin: merged.gstin, pan: merged.pan,
    attachments: merged.attachments || {},
  }, companyDB);
  await store.updateCustomer(c.id, {
    ...patch, status: 'APPROVED', sapCardCode: cardCode,
    approvedAt: new Date().toISOString(), approvedBy: req.user.username,
    sapAttachmentEntry: result?.attachmentEntry || null,
  }, companyDB);
  return { cardCode, cardName: merged.cardName };
}

const custRouter = express.Router();

// Lookup routes BEFORE /:id
custRouter.get('/lookup/bp-groups', verifyToken, async (req, res) => {
  try {
    const sap = getSap();
    if (!sap) return res.json({ success: true, data: [] });
    const result = await sap.sapRequest('GET', `BusinessPartnerGroups?$filter=Type eq 'bbpgt_CustomerGroup'&$select=Code,Name&$orderby=Name`);
    res.json({ success: true, data: (result?.value || []).map(r => ({ GroupCode: r.Code, GroupName: r.Name })) });
  } catch (err) { res.json({ success: true, data: [], warning: err.message }); }
});
custRouter.get('/lookup/payment-terms', verifyToken, (req, res) =>
  safeLookup(res, `SELECT "GroupNum","PymntGroup" FROM ${DB()}."OCTG" ORDER BY "PymntGroup"`, r => ({ Code: r.GroupNum, Name: r.PymntGroup }))
);
custRouter.get('/lookup/sales-employees', verifyToken, (req, res) =>
  safeLookup(res, `SELECT "SlpCode","SlpName" FROM ${DB()}."OSLP" WHERE "SlpCode">0 AND "Locked"='N' ORDER BY "SlpName"`, r => ({ SlpCode: r.SlpCode, SlpName: r.SlpName }))
);
custRouter.get('/lookup/ar-accounts', verifyToken, (req, res) =>
  safeLookup(res, `SELECT "AcctCode","AcctName" FROM ${DB()}."OACT" WHERE "FatherNum"='1101000' ORDER BY "AcctCode"`, r => ({ AcctCode: r.AcctCode, AcctName: r.AcctName }))
);
custRouter.get('/lookup/main-group', verifyToken, (req, res) =>
  safeLookup(res, `SELECT "Code","Name" FROM ${DB()}."@MAIN_GROUP" ORDER BY "Code"`, r => ({ Code: r.Code, Name: r.Name || r.Code }))
);
custRouter.get('/lookup/chain', verifyToken, (req, res) =>
  safeLookup(res, `SELECT "Code","Name" FROM ${DB()}."@CHAIN" ORDER BY "Code"`, r => ({ Code: r.Code, Name: r.Name || r.Code }))
);
custRouter.get('/next-cardcode', verifyToken, async (req, res) => {
  const { prefix = 'CUSTA' } = req.query;
  try {
    const sap = getSap();
    if (!sap) return res.status(503).json({ success: false, message: 'SAP service not ready' });
    const cardCode = await sap.getNextCardCode(prefix);
    res.json({ success: true, cardCode });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
custRouter.get('/lookup/states', verifyToken, async (req, res) => {
  try {
    const sap = getSap();
    if (!sap) return res.json({ success: true, data: [] });
    let allStates = [], url = `States?$filter=Country eq 'IN'&$select=Code,Name&$orderby=Name`;
    while (url) {
      const result = await sap.sapRequest('GET', url);
      allStates = allStates.concat(result?.value || []);
      const nextLink = result?.['@odata.nextLink'];
      url = nextLink ? nextLink.replace(/^.*\/b1s\/v2\//, '') : null;
    }
    res.json({ success: true, data: allStates.map(r => ({ Code: r.Code, Name: r.Name })) });
  } catch (err) { res.json({ success: true, data: [], warning: err.message }); }
});

custRouter.post('/submit', [
  body('cardName').notEmpty().trim(), body('email').isEmail().normalizeEmail(),
  body('mobile').notEmpty().trim(), body('contactFirst').notEmpty().trim(),
  body('contactLast').notEmpty().trim(), body('billStreet').notEmpty().trim(),
  body('billCity').notEmpty().trim(),
], async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ success: false, errors: errs.array() });
  const b = req.body;
  const companyDB = resolveCompany(b.company);
  try {
    const store = getStore();
    if (!store) return res.status(503).json({ success: false, message: 'Database not ready' });
    const customer = await store.insertCustomer({
      customerType: b.customerType || 'B2B', cardName: b.cardName, foreignName: b.foreignName || '',
      typeOfBusiness: b.typeOfBusiness || 'Company', industry: b.industry || '',
      mobile: b.mobile, email: b.email, website: b.website || '',
      contactFirst: b.contactFirst, contactLast: b.contactLast,
      contactMobile: b.contactMobile || b.mobile, contactEmail: b.contactEmail || b.email || '',
      contactTitle: b.contactTitle || '',
      billAddressName: b.billAddressName || b.cardName, billStreet: b.billStreet,
      billBlock: b.billBlock || '', billCity: b.billCity, billZip: b.billZip || '',
      billState: b.billState || '', billCountry: b.billCountry || 'India',
      sameAsBill: b.sameAsBill || false,
      shipAddressName: b.sameAsBill ? (b.billAddressName || b.cardName) : (b.shipAddressName || b.billAddressName || b.cardName),
      shipStreet: b.sameAsBill ? b.billStreet : (b.shipStreet || b.billStreet),
      shipBlock: b.sameAsBill ? b.billBlock : (b.shipBlock || b.billBlock || ''),
      shipCity: b.sameAsBill ? b.billCity : (b.shipCity || b.billCity),
      shipZip: b.sameAsBill ? b.billZip : (b.shipZip || b.billZip || ''),
      shipState: b.sameAsBill ? b.billState : (b.shipState || b.billState || ''),
      shipCountry: b.sameAsBill ? b.billCountry : (b.shipCountry || b.billCountry || 'India'),
      allBillAddresses: Array.isArray(b.allBillAddresses) ? b.allBillAddresses : [],
      allShipAddresses: Array.isArray(b.allShipAddresses) ? b.allShipAddresses : [],
      currency: b.currency || 'Indian Rupee', gstin: b.gstin || '', pan: b.pan || '',
      remarks: b.remarks || '', hasMsme: b.hasMsme || false, msmeNo: b.msmeNo || '',
      msmeType: b.msmeType || '', msmeBType: b.msmeBType || '', attachments: b.attachments || {},
      mgrCardCodePrefix: 'CUSTA', mgrArAccount: '1101001',
      mgrArAccountName: 'SUNDRY DEBTORS GT', mgrCurrency: 'Indian Rupee', mgrLanguage: 'English (UK)',
      company: companyDB,
    }, companyDB);
    res.json({ success: true, message: 'Submitted', id: customer.id });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

custRouter.post('/direct-approve', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const store = getStore(); const sap = getSap();
    if (!store || !sap) return res.status(503).json({ success: false, message: 'Service not ready' });
    const b = req.body;
    const companyDB = resolveCompany(b.company);
    const customer = await store.insertCustomer({
      customerType: b.customerType || 'B2B', cardName: b.cardName, foreignName: b.foreignName || '',
      typeOfBusiness: b.typeOfBusiness || 'Company', industry: b.industry || '',
      mobile: b.mobile, email: b.email, website: b.website || '',
      contactFirst: b.contactFirst, contactLast: b.contactLast,
      contactMobile: b.contactMobile || b.mobile, contactEmail: b.contactEmail || b.email || '',
      contactTitle: b.contactTitle || '',
      billAddressName: b.billAddressName || b.cardName, billStreet: b.billStreet || '',
      billBlock: b.billBlock || '', billCity: b.billCity || '', billZip: b.billZip || '',
      billState: b.billState || '', billCountry: b.billCountry || 'India',
      sameAsBill: b.sameAsBill || false,
      shipAddressName: b.shipAddressName || b.billAddressName || b.cardName,
      shipStreet: b.shipStreet || b.billStreet || '', shipBlock: b.shipBlock || b.billBlock || '',
      shipCity: b.shipCity || b.billCity || '', shipZip: b.shipZip || b.billZip || '',
      shipState: b.shipState || b.billState || '', shipCountry: b.shipCountry || b.billCountry || 'India',
      allBillAddresses: Array.isArray(b.allBillAddresses) ? b.allBillAddresses : [],
      allShipAddresses: Array.isArray(b.allShipAddresses) ? b.allShipAddresses : [],
      currency: b.currency || 'Indian Rupee', gstin: b.gstin || '', pan: b.pan || '',
      remarks: b.remarks || '', hasMsme: b.hasMsme || false, msmeNo: b.msmeNo || '',
      msmeType: b.msmeType || '', msmeBType: b.msmeBType || '', attachments: b.attachments || {},
      mgrCardCodePrefix: b.mgrCardCodePrefix || 'CUSTA', mgrArAccount: b.mgrArAccount || '1101001',
      mgrArAccountName: b.mgrArAccountName || 'SUNDRY DEBTORS GT',
      mgrCurrency: b.mgrCurrency || b.currency || 'Indian Rupee', mgrLanguage: b.mgrLanguage || 'English (UK)',
      mgrGroupCode: b.mgrGroupCode || null, mgrGroup: b.mgrGroup || '',
      mgrChain: b.mgrChain || '', mgrMainGroup: b.mgrMainGroup || '',
      mgrSalesEmployee: b.mgrSalesEmployee || '', mgrSalesPersonCode: b.mgrSalesPersonCode || null,
      mgrPayTerms: b.mgrPayTerms || '', mgrPayTermsCode: b.mgrPayTermsCode || null,
      mgrCreditLimit: b.mgrCreditLimit || 0, status: 'VERIFIED',
      company: companyDB,
    }, companyDB);
    const { cardCode, cardName } = await doCreateCustomerInSAP(store, sap, customer, b, req, companyDB);
    res.json({ success: true, message: 'Customer created directly in SAP B1!', cardCode, cardName });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

custRouter.get('/', verifyToken, async (req, res) => {
  const st = (req.query.status || 'PENDING').toUpperCase();
  const companyDB = resolveCompany(req.query.company);
  try {
    const data = await getStore().listByStatus(st, companyDB);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

custRouter.get('/:id', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.query.company);
  try {
    const c = await getStore().findById(req.params.id, companyDB);
    if (!c) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: c });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

custRouter.patch('/:id/verify', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const c = await getStore().findById(req.params.id, companyDB);
    if (!c) return res.status(404).json({ success: false, message: 'Not found' });
    if (c.status !== 'PENDING')
      return res.status(400).json({ success: false, message: 'Only PENDING can be verified. Current: ' + c.status });
    const patch = extractPatch(req.body, ALL_EDITABLE);
    patch.status = req.body.approved ? 'VERIFIED' : 'REJECTED';
    patch.verifiedAt = new Date().toISOString();
    patch.verifiedBy = req.user.username;
    await getStore().updateCustomer(c.id, patch, companyDB);
    res.json({ success: true, message: `Customer ${patch.status.toLowerCase()}` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

custRouter.patch('/:id/approve', verifyToken, requireRole('sap_adder'), async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const store = getStore(); const sap = getSap();
    const c = await store.findById(req.params.id, companyDB);
    if (!c) return res.status(404).json({ success: false, message: 'Not found' });
    if (!req.body.approved) {
      await store.updateCustomer(c.id, { status: 'REJECTED', rejectedBy: req.user.username, rejectedAt: new Date().toISOString() }, companyDB);
      return res.json({ success: true, message: 'Customer rejected' });
    }
    if (c.status !== 'VERIFIED')
      return res.status(400).json({ success: false, message: `Must be VERIFIED. Current: ${c.status}` });
    const patch = extractPatch(req.body, ALL_EDITABLE);
    const { cardCode, cardName } = await doCreateCustomerInSAP(store, sap, c, patch, req, companyDB);
    res.json({ success: true, message: 'Customer created in SAP B1!', cardCode, cardName });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

custRouter.patch('/:id/admin-approve', verifyToken, requireRole('admin'), async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const store = getStore(); const sap = getSap();
    const c = await store.findById(req.params.id, companyDB);
    if (!c) return res.status(404).json({ success: false, message: 'Not found' });
    if (c.status === 'APPROVED') return res.status(400).json({ success: false, message: 'Already approved' });
    if (c.status === 'REJECTED') return res.status(400).json({ success: false, message: 'Cannot approve rejected customer' });
    await store.updateCustomer(c.id, { status: 'VERIFIED' }, companyDB);
    const refreshed = await store.findById(c.id, companyDB);
    const patch = extractPatch(req.body, ALL_EDITABLE);
    const { cardCode, cardName } = await doCreateCustomerInSAP(store, sap, refreshed, patch, req, companyDB);
    res.json({ success: true, message: 'Customer approved and pushed to SAP B1!', cardCode, cardName });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

custRouter.patch('/:id/draft', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const c = await getStore().findById(req.params.id, companyDB);
    if (!c) return res.status(404).json({ success: false, message: 'Not found' });
    if (c.status === 'APPROVED' || c.status === 'REJECTED')
      return res.status(400).json({ success: false, message: 'Cannot edit ' + c.status + ' records' });
    const patch = extractPatch(req.body, ALL_EDITABLE);
    await getStore().updateCustomer(c.id, patch, companyDB);
    res.json({ success: true, message: 'Draft saved' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.use('/api/customers', custRouter);

// ════════════════════════════════════════════════════════════════
//  HEALTH & STATS
// ════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', hana: global._hanaReady === true, approvalLevels: APPROVAL_LEVELS, time: new Date().toISOString() })
);

app.get('/api/stats', verifyToken, async (req, res) => {
  try {
    const store = getBomStore();
    if (!store) return res.json({ success: true, data: {} });
    const stats = await store.getStats();
    res.json({ success: true, data: stats });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ════════════════════════════════════════════════════════════════
//  404 + ERROR HANDLERS  (must be LAST)
// ════════════════════════════════════════════════════════════════
app.use((req, res) => res.status(404).json({ success: false, message: 'Not found: ' + req.path }));
app.use((err, req, res, next) => {
  console.error('[SERVER] Error:', err.message);
  if (err.type === 'entity.too.large')
    return res.status(413).json({ success: false, message: 'Request too large.' });
  res.status(500).json({ success: false, message: err.message || 'Internal server error' });
});

// ════════════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════════════
function getLocalIP() {
  try {
    const ifaces = require('os').networkInterfaces();
    for (const name of Object.keys(ifaces))
      for (const iface of ifaces[name])
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  } catch {}
  return '0.0.0.0';
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n✅ SAP B1 Portal — Multi-Level BOM Approval`);
  console.log(`   🔢 Approval Levels : ${APPROVAL_LEVELS}`);
  console.log(`   🖥  Local          : http://localhost:${PORT}`);
  console.log(`   🌐 Network         : http://${ip}:${PORT}`);
  console.log(`   📝 Customer Form   : http://${ip}:${PORT}/register`);
  console.log(`   📋 BOM Portal      : http://${ip}:${PORT}/bom`);
  console.log(`   ✅ Approvals       : http://${ip}:${PORT}/approvals`);
  console.log(`   📒 Journal Entries : http://${ip}:${PORT}/journal-entries`);
  console.log(`   🔐 Admin           : http://${ip}:${PORT}/admin`);
  console.log(`   ⏳ Connecting to HANA...\n`);
  runBootstrap();
});

async function runBootstrap() {
  try {
    hanaStore       = require('./services/hanaStore');
    hanaUsers       = require('./services/hanaUsers');
    sapSvc          = require('./services/sapServiceLayer');
    bomStore        = require('./services/bomRequestStore');
    hanaVendorStore = require('./services/hanaVendorStore');

    await hanaStore.bootstrap();
    await hanaUsers.bootstrap();
    await bomStore.bootstrap();
    await hanaVendorStore.bootstrap();

    global._hanaReady = true;
    console.log('✅ HANA ready — all features available\n');
  } catch (err) {
    console.error(`\n⚠️  HANA error: ${err.message}`);
    console.error('   Retrying in 30s...\n');
    setTimeout(runBootstrap, 30000);
  }
}
