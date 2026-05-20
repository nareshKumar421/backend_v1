// ════════════════════════════════════════════════════════════════
//  smb-test.js  —  Run on your Node.js server to find correct creds
//
//  Usage:
//    node smb-test.js
//
//  Place this file in your backend/ folder (next to server.js)
//  and run it from the server machine (where Node.js is running).
// ════════════════════════════════════════════════════════════════

require('dotenv').config();
const { execSync } = require('child_process');

const SHARE = process.env.SAP_ATTACHMENT_PATH || '\\\\103.89.45.247\\Attachments';
const USER  = process.env.SMB_USER     || 'USER42';
const PASS  = process.env.SMB_PASSWORD || '';

function run(cmd, label) {
  try {
    const out = execSync(cmd, { stdio: 'pipe', timeout: 10000 }).toString().trim();
    console.log(`✅ ${label}: OK`);
    if (out) console.log('   ', out.split('\n')[0]);
    return true;
  } catch (e) {
    const err = (e.stderr?.toString() || e.message || '').trim();
    console.log(`❌ ${label}: FAILED`);
    console.log('   ', err.split('\n')[0]);
    return false;
  }
}

console.log('\n══ SMB CREDENTIAL TESTER ═══════════════════════════');
console.log('Share  :', SHARE);
console.log('User   :', USER);
console.log('Pass   :', PASS ? '***set***' : '(empty — set SMB_PASSWORD in .env)');
console.log('');

// Clean up any existing mapping
run(`net use "${SHARE}" /delete /y`, 'Delete existing mapping');
console.log('');

// Test 1: plain user
const t1 = run(
  `net use "${SHARE}" /user:${USER} "${PASS}" /persistent:no`,
  `Test 1 — net use /user:${USER}`
);
if (!t1) run(`net use "${SHARE}" /delete /y`, 'Cleanup');

// Test 2: WORKGROUP\user
const t2 = run(
  `net use "${SHARE}" /user:WORKGROUP\\${USER} "${PASS}" /persistent:no`,
  `Test 2 — net use /user:WORKGROUP\\${USER}`
);
if (!t2) run(`net use "${SHARE}" /delete /y`, 'Cleanup');

// Test 3: machine\user (common for local accounts)
let hostname = '';
try { hostname = execSync('hostname', { stdio: 'pipe' }).toString().trim(); } catch (_) {}
if (hostname) {
  const t3 = run(
    `net use "${SHARE}" /user:${hostname}\\${USER} "${PASS}" /persistent:no`,
    `Test 3 — net use /user:${hostname}\\${USER} (local account)`
  );
  if (!t3) run(`net use "${SHARE}" /delete /y`, 'Cleanup');
}

// Test 4: current session (no password)
const t4 = run(
  `net use "${SHARE}" /persistent:no`,
  'Test 4 — current Windows session (no explicit credentials)'
);
if (!t4) run(`net use "${SHARE}" /delete /y`, 'Cleanup');

// Test 5: can we actually list the share?
console.log('');
const t5 = run(`dir "${SHARE}" /b`, 'Test 5 — dir listing of share');

// Test 6: can we write?
if (t5) {
  const testDir = `${SHARE}\\__NODE_WRITE_TEST__`;
  const t6 = run(`mkdir "${testDir}"`, 'Test 6 — mkdir on share');
  if (t6) run(`rmdir "${testDir}"`, 'Cleanup test folder');
}

console.log('\n══ CURRENT NETWORK CONNECTIONS ══════════════════════');
run('net use', 'Current net use mappings');

console.log('\n══ WHAT TO DO ════════════════════════════════════════');
console.log('1. Find which Test above succeeded (✅)');
console.log('2. Use the matching credentials in your .env:');
console.log('     SMB_USER=USER42');
console.log('     SMB_PASSWORD=correct-password-here');
console.log('     SMB_DOMAIN=WORKGROUP   (or your domain, or leave blank)');
console.log('');
console.log('3. To find the correct password:');
console.log('   - Ask the IT admin who manages \\\\103.89.45.247');
console.log('   - Or on that server machine run:');
console.log('       Computer Management → Local Users and Groups → Users → USER42');
console.log('       → right-click → Set Password');
console.log('   - Or check if the share allows guest access:');
console.log(`       net use "${SHARE}" guest "" /persistent:no`);
console.log('══════════════════════════════════════════════════════\n');