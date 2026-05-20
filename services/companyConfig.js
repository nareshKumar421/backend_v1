'use strict';

const COMPANIES = {
  'JIVO_OIL_HANADB':       { display: 'Jivo Oil',       short: 'OIL'  },
  'JIVO_BEVERAGES_HANADB': { display: 'Jivo Beverages', short: 'BEV'  },
  'JIVO_MART_HANADB':      { display: 'Jivo Mart',      short: 'MART' },
  'TEST_OIL_15122025':     { display: 'Test Oil',       short: 'TEST' },
};

const DEFAULT_COMPANY = process.env.SAP_B1_COMPANY || 'JIVO_OIL_HANADB';

function isValid(c) { return !!COMPANIES[c]; }
function resolve(c) { return isValid(c) ? c : DEFAULT_COMPANY; }

module.exports = { COMPANIES, DEFAULT_COMPANY, isValid, resolve };
