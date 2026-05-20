// backend/routes/users.js
// User management API — only sap_adder role can manage users
const express  = require('express');
const router   = express.Router();
const { verifyToken } = require('../middleware/auth');
const userDb   = require('../services/hanaUsers');

const VALID_ROLES = ['manager', 'sr_manager', 'sap_adder'];

// Middleware: only sap_adder can manage users
function requireSapAdder(req, res, next) {
  if (req.user?.role !== 'sap_adder')
    return res.status(403).json({ success: false, message: 'Only SAP Adder role can manage users' });
  next();
}

// ── GET /users — list all users ───────────────────────────────────────────────
router.get('/', verifyToken, requireSapAdder, async (req, res) => {
  try {
    const users = await userDb.listUsers();
    res.json({ success: true, data: users });
  } catch (err) {
    console.error('[USERS] list error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /users — create user ─────────────────────────────────────────────────
router.post('/', verifyToken, requireSapAdder, async (req, res) => {
  const { username, password, fullName, email, role } = req.body;

  if (!username || !username.trim())
    return res.status(400).json({ success: false, message: 'Username is required' });
  if (!password || password.length < 6)
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  if (!VALID_ROLES.includes(role))
    return res.status(400).json({
      success: false,
      message: `Role must be one of: ${VALID_ROLES.join(', ')}`,
    });

  try {
    const id = await userDb.createUser({ username: username.trim().toLowerCase(), password, fullName, email, role });
    res.json({ success: true, message: `User "${username}" created successfully`, id });
  } catch (err) {
    const isDuplicate = (err.message || '').toLowerCase().includes('unique')
      || (err.message || '').toLowerCase().includes('duplicate');
    const msg = isDuplicate ? `Username "${username}" already exists` : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

// ── PATCH /users/:id — update user ───────────────────────────────────────────
router.patch('/:id', verifyToken, requireSapAdder, async (req, res) => {
  try {
    const existing = await userDb.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'User not found' });

    // Validate role if being updated
    if (req.body.role !== undefined && !VALID_ROLES.includes(req.body.role))
      return res.status(400).json({ success: false, message: `Role must be one of: ${VALID_ROLES.join(', ')}` });

    // Validate password if being updated
    if (req.body.password !== undefined && req.body.password.length < 6)
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    await userDb.updateUser(req.params.id, req.body);
    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    console.error('[USERS] update error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /users/:id — delete user ──────────────────────────────────────────
router.delete('/:id', verifyToken, requireSapAdder, async (req, res) => {
  try {
    // Prevent deleting yourself
    if (parseInt(req.params.id) === req.user.id)
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });

    const existing = await userDb.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'User not found' });

    await userDb.deleteUser(req.params.id);
    res.json({ success: true, message: `User "${existing.username}" deleted` });
  } catch (err) {
    console.error('[USERS] delete error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;