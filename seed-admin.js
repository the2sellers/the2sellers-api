// Run with: node seed-admin.js "Full Name" "email@example.com" "password" "admin"
require('dotenv').config();
const { pool, initSchema } = require('./db');
const { hashPassword } = require('./auth');

const [, , name, email, password, role] = process.argv;

if (!name || !email || !password) {
  console.log('Usage: node seed-admin.js "Full Name" "email@example.com" "password" [admin|reviewer]');
  process.exit(1);
}

(async () => {
  await initSchema();

  const { rows } = await pool.query('SELECT id FROM admin_users WHERE email = $1', [email]);
  if (rows[0]) {
    console.log(`A user with email ${email} already exists (id ${rows[0].id}).`);
    process.exit(1);
  }

  const result = await pool.query(
    'INSERT INTO admin_users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id',
    [name, email, hashPassword(password), role || 'reviewer']
  );

  console.log(`Created admin user "${name}" <${email}> with role "${role || 'reviewer'}" (id ${result.rows[0].id}).`);
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
