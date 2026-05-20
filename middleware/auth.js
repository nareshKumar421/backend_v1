// backend/middleware/auth.js
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'sap-portal-secret';

function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// Only sap_adder can approve → push to SAP B1
function verifyAdmin(req, res, next) {
  if (req.user?.role === 'admin' || req.user?.role === 'sap_adder')
    return next();
  return res.status(403).json({ success: false, message: 'SAP Adder or Admin role required' });
}

module.exports = { verifyToken, verifyAdmin };