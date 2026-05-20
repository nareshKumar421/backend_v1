// backend/routes/auth.js
// Uses HANA ZCUST_USERS table for authentication.
// Roles:
//   manager   → can view list, open detail, verify/reject, fill manager fields
//   sap_adder → all manager perms + approve & push to SAP B1
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const userDb  = require('../services/hanaUsers');

const SECRET  = process.env.JWT_SECRET || 'sap-portal-secret';
const EXPIRES = '12h';

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: 'Username and password required' });

  try {
    const user = await userDb.findByUsername(username);
    if (!user)
      return res.status(401).json({ success: false, message: 'Invalid username or password' });

    const ok = await userDb.verifyPassword(password, user.passwordHash);
    if (!ok)
      return res.status(401).json({ success: false, message: 'Invalid username or password' });

    await userDb.touchLastLogin(user.id);

    const payload = { id: user.id, username: user.username, role: user.role, name: user.fullName };
    const token   = jwt.sign(payload, SECRET, { expiresIn: EXPIRES });

    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, name: user.fullName, role: user.role, email: user.email },
    });
  } catch (err) {
    console.error('[AUTH] login error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false });
  try {
    const user = jwt.verify(token, SECRET);
    res.json({ success: true, user });
  } catch {
    res.status(401).json({ success: false });
  }
});

module.exports = router;