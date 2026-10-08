const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = '7d';

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function checkPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function createToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: user.role === 'door' ? '20h' : JWT_EXPIRES_IN }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    // Door staff accounts may only use the check-in screen.
    if (decoded.role === 'door' && String(req.originalUrl || '').indexOf('/api/admin/checkin/') !== 0) {
      return res.status(403).json({ error: 'Door staff accounts can only use the check-in screen.' });
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required for this action' });
  }
  next();
}

module.exports = { hashPassword, checkPassword, createToken, requireAuth, requireAdmin };
