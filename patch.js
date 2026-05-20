/**
 * patch.js  —  run ONCE from your backend folder:
 *
 *   node patch.js
 *
 * What it does:
 *   1. Patches public/index.html    — fixes BACKEND constant (fixed port → current origin)
 *   2. Patches public/register.html — fixes BACKEND constant (fixed port → current origin)
 *
 * Safe to run multiple times — checks if patch already applied before writing.
 */

const fs   = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');

const patches = [
  {
    file: path.join(PUBLIC, 'index.html'),
    // The portal should call the same origin it was loaded from, including
    // the active port. This keeps login working on 5000, 5002, or any port.
    old:  `const BACKEND = 'http://localhost:5000/api';`,
    new:  `const BACKEND = \`\${window.location.origin}/api\`;`,
  },
  {
    file: path.join(PUBLIC, 'register.html'),
    // Same issue in the customer registration form.
    old:  `return localStorage.getItem('BACKEND_URL') || 'http://localhost:5000/api';`,
    new:  `return localStorage.getItem('BACKEND_URL') || \`\${window.location.origin}/api\`;`,
  },
];

let anyFailed = false;

for (const { file, old: oldStr, new: newStr } of patches) {
  const name = path.basename(file);

  if (!fs.existsSync(file)) {
    console.error(`❌  ${name} — file not found at ${file}`);
    anyFailed = true;
    continue;
  }

  let content = fs.readFileSync(file, 'utf8');

  if (content.includes(newStr)) {
    console.log(`✓   ${name} — already patched, skipping`);
    continue;
  }

  if (!content.includes(oldStr)) {
    console.error(`❌  ${name} — target string not found. Was the file already manually edited?`);
    console.error(`    Looking for: ${oldStr}`);
    anyFailed = true;
    continue;
  }

  content = content.replace(oldStr, newStr);
  fs.writeFileSync(file, content, 'utf8');
  console.log(`✅  ${name} — patched successfully`);
}

if (anyFailed) {
  console.log('\n⚠️  Some files could not be patched — see errors above.');
  process.exit(1);
} else {
  console.log('\n🎉  All patches applied. Restart the server:\n    node server.js\n');
}
