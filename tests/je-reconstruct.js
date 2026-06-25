// Live verifier for the pending-draft journal reconstruction.
// Exercises the PRODUCTION function (routes/sap.js → buildDraftJournalEntryFromHana)
// against real draft documents and prints the reconstructed, balanced journal entry.
//   node tests/je-reconstruct.js <DRAFT_DOCENTRY> [COMPANY_DB]
// e.g. node tests/je-reconstruct.js 50084   (UNIQUE PACKTECH AP invoice — matches SAP exactly)
require('dotenv').config();
const sapRouter = require('../routes/sap');

const DRAFT = Number(process.argv[2] || 50084);
const CO = process.argv[3] || 'JIVO_OIL_HANADB';

(async () => {
  const je = await sapRouter.buildDraftJournalEntryFromHana(CO, DRAFT);
  if (!je) { console.log(`No journal could be reconstructed for draft ${DRAFT}.`); process.exit(0); }
  console.log(`\nReconstructed JE for draft ${DRAFT} (ObjType ${je.trans_type}):\n`);
  console.table(je.lines.map(l => ({ acct: l.account, name: l.account_name, debit: l.debit || '', credit: l.credit || '' })));
  const ok = je.total_debit === je.total_credit;
  console.log(`Total Debit = ${je.total_debit}   Total Credit = ${je.total_credit}   ${ok ? '✅ BALANCED' : '❌ UNBALANCED'}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
