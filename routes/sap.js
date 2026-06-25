// backend/routes/sap.js
'use strict';
const express    = require('express');
const router     = express.Router();
const { verifyToken } = require('../middleware/auth');
const { resolve: resolveCompany } = require('../services/companyConfig');
const { fetchFileFromArchive, contentDispositionFilename } = require('../services/fileServiceClient');

// ── Lazy-load services ──────────────────────────────────────────
let _sapSvc       = null;
let _hanaConn     = null;
let _hanaConnecting = false;

function getSap(){
  if(!_sapSvc) _sapSvc = require('../services/sapServiceLayer');
  return _sapSvc;
}

const hana = require('@sap/hana-client');

async function getHanaConn(){
  if(_hanaConn) return _hanaConn;
  if(_hanaConnecting){
    for(let i=0;i<10;i++){
      await new Promise(r=>setTimeout(r,500));
      if(_hanaConn) return _hanaConn;
    }
    throw new Error('HANA connection timeout');
  }
  _hanaConnecting=true;
  try{
    const conn=hana.createConnection();
    await new Promise((resolve,reject)=>{
      conn.connect({
        serverNode:`${process.env.HANA_HOST}:${process.env.HANA_PORT}`,
        uid:process.env.HANA_USER,
        pwd:process.env.HANA_PASSWORD,
        encrypt:'true',
        sslValidateCertificate:'false',
      },err=>err?reject(err):resolve());
    });
    _hanaConn=conn;
    console.log('[SAP-ROUTE] HANA connected');
  }catch(err){
    console.error('[SAP-ROUTE] HANA connection failed:',err.message);
    throw err;
  }finally{_hanaConnecting=false;}
  return _hanaConn;
}

async function hanaQuery(sql, params = []){
  console.log('[HANA]',sql.slice(0,120).replace(/\s+/g,' '));
  const conn=await getHanaConn();
  return new Promise((resolve,reject)=>{
    const done=(err,rows)=>{
      if(err){
        try{conn.disconnect();}catch(_){}
        _hanaConn=null;
        return reject(err);
      }
      console.log(`[HANA] ✅ ${(rows||[]).length} rows`);
      resolve(rows||[]);
    };
    if(params.length) conn.exec(sql,params,done);
    else conn.exec(sql,done);
  });
}

const DB=(c)=>`"${resolveCompany(c)}"`;
const cq =(req)=>req.query?.company||req.body?.company||null;  // extract company from request

function attachmentFileName(line) {
  const stem = String(line?.FileName || '').trim();
  const ext = String(line?.FileExtension || '').trim().replace(/^\./, '');
  if (!stem) return '';
  if (!ext || stem.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return stem;
  return `${stem}.${ext}`;
}

function resolveSapCompany(c) {
  const value = String(c || '').trim().toUpperCase();
  if (value === 'JIVO_BEREAGE_HANADB' || value === 'JIVO_BEVERAGE_HANADB') return 'JIVO_BEVERAGES_HANADB';
  return resolveCompany(c);
}

async function safeLookup(res,sql,mapFn){
  try{
    const rows=await hanaQuery(sql);
    return res.json({success:true,data:rows.map(mapFn)});
  }catch(err){
    console.warn('[SAP-ROUTE] safeLookup fallback:',err.message);
    return res.json({success:true,data:[],warning:err.message});
  }
}

function firstValue(obj, keys, fallback = null) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return fallback;
}

function cleanString(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dateOnly(v) {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s ? s.slice(0, 10) : null;
}

function parsePositiveInt(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || !/^\d+$/.test(String(value).trim()) || n < 0) {
    const err = new Error(`${fieldName} must be a positive number`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function normalizeDateFilter(value, fieldName) {
  if (!value) return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const err = new Error(`${fieldName} must be in YYYY-MM-DD format`);
    err.statusCode = 400;
    throw err;
  }
  return s;
}

function requireModule(moduleName) {
  return (req,res,next)=>{
    const role=req.user?.role;
    const modules=req.user?.modules;
    if(role==='admin'||role==='sap_adder') return next();
    if(!Array.isArray(modules)||modules.includes(moduleName)) return next();
    return res.status(403).json({
      success:false,
      message:`You do not have access to ${moduleName}. Ask an admin to enable this module for your user.`,
    });
  };
}

// ════════════════════════════════════════════════════════════════
//  JOURNAL ENTRIES — OJDT header + JDT1 lines + OACT account names
// ════════════════════════════════════════════════════════════════
router.get('/journal-entries', verifyToken, requireModule('journal-entries'), async(req,res)=>{
  const co=cq(req);
  try{
    const db=DB(co);
    const limitRaw=req.query.limit ?? req.query.top;
    const limit=Math.min(Math.max(parseInt(limitRaw || '5',10) || 5,1),100);
    const transId=parsePositiveInt(req.query.transId ?? req.query.trans_id,'TransId');
    const number=parsePositiveInt(req.query.number ?? req.query.jeNumber ?? req.query.journalEntryNumber,'Journal Entry Number');
    const baseRef=cleanString(req.query.baseRef ?? req.query.docRef ?? req.query.reference);
    const transType=cleanString(req.query.transType ?? req.query.sapType);
    const fromDate=normalizeDateFilter(req.query.fromDate ?? req.query.dateFrom,'From Date');
    const toDate=normalizeDateFilter(req.query.toDate ?? req.query.dateTo,'To Date');

    const where=[];
    const params=[];
    if(transId !== null){ where.push('H."TransId" = ?'); params.push(transId); }
    if(number !== null){ where.push('H."Number" = ?'); params.push(number); }
    if(baseRef){
      const refLike=`%${baseRef.toUpperCase()}%`;
      where.push(`(
        UPPER(COALESCE(H."BaseRef",'')) LIKE ?
        OR UPPER(COALESCE(H."Ref1",'')) LIKE ?
        OR UPPER(COALESCE(H."Ref2",'')) LIKE ?
        OR UPPER(COALESCE(H."Ref3",'')) LIKE ?
      )`);
      params.push(refLike,refLike,refLike,refLike);
    }
    if(transType){
      where.push('CAST(H."TransType" AS NVARCHAR) = ?');
      params.push(transType);
    }
    if(fromDate){ where.push('H."RefDate" >= ?'); params.push(fromDate); }
    if(toDate){ where.push('H."RefDate" <= ?'); params.push(toDate); }

    const whereSql=where.length?`WHERE ${where.join(' AND ')}`:'';
    const headerRows=await hanaQuery(`
      SELECT TOP ${limit}
        H."TransId" AS "trans_id",
        H."Number" AS "number",
        H."RefDate" AS "ref_date",
        H."DueDate" AS "due_date",
        H."TaxDate" AS "tax_date",
        H."Memo" AS "memo",
        H."BaseRef" AS "base_ref",
        H."TransType" AS "trans_type",
        CAST(COALESCE(SUM(L."Debit"),0) AS DECIMAL(19,2)) AS "total_debit",
        CAST(COALESCE(SUM(L."Credit"),0) AS DECIMAL(19,2)) AS "total_credit"
      FROM ${db}."OJDT" H
      LEFT JOIN ${db}."JDT1" L ON L."TransId" = H."TransId"
      ${whereSql}
      GROUP BY H."TransId",H."Number",H."RefDate",H."DueDate",H."TaxDate",H."Memo",H."BaseRef",H."TransType"
      ORDER BY H."TransId" DESC
    `,params);

    const transIds=headerRows.map(r=>asNumber(firstValue(r,['trans_id','TRANS_ID','TransId']))).filter(Boolean);
    let linesByTransId=new Map();
    if(transIds.length){
      const placeholders=transIds.map(()=>'?').join(',');
      const lineRows=await hanaQuery(`
        SELECT
          L."TransId" AS "trans_id",
          L."Line_ID" AS "line_id",
          L."Account" AS "account",
          A."AcctName" AS "account_name",
          L."ShortName" AS "short_name",
          CAST(COALESCE(L."Debit",0) AS DECIMAL(19,2)) AS "debit",
          CAST(COALESCE(L."Credit",0) AS DECIMAL(19,2)) AS "credit",
          L."ContraAct" AS "contra_account",
          L."LineMemo" AS "line_memo",
          L."Project" AS "project",
          L."ProfitCode" AS "cost_center",
          L."OcrCode2" AS "cost_center_2",
          L."OcrCode3" AS "cost_center_3",
          L."OcrCode4" AS "cost_center_4",
          L."OcrCode5" AS "cost_center_5"
        FROM ${db}."JDT1" L
        LEFT JOIN ${db}."OACT" A ON A."AcctCode" = L."Account"
        WHERE L."TransId" IN (${placeholders})
        ORDER BY L."TransId" DESC,L."Line_ID" ASC
      `,transIds);
      linesByTransId=lineRows.reduce((map,row)=>{
        const id=asNumber(firstValue(row,['trans_id','TRANS_ID','TransId']));
        const line={
          line_id:asNumber(firstValue(row,['line_id','LINE_ID','Line_ID'])),
          account:cleanString(firstValue(row,['account','ACCOUNT','Account'])),
          account_name:cleanString(firstValue(row,['account_name','ACCOUNT_NAME','AcctName'])),
          short_name:cleanString(firstValue(row,['short_name','SHORT_NAME','ShortName'])),
          debit:asNumber(firstValue(row,['debit','DEBIT','Debit'])),
          credit:asNumber(firstValue(row,['credit','CREDIT','Credit'])),
          contra_account:cleanString(firstValue(row,['contra_account','CONTRA_ACCOUNT','ContraAct'])),
          line_memo:cleanString(firstValue(row,['line_memo','LINE_MEMO','LineMemo'])),
          project:cleanString(firstValue(row,['project','PROJECT','Project'])),
          cost_center:cleanString(firstValue(row,['cost_center','COST_CENTER','ProfitCode'])),
          cost_center_2:cleanString(firstValue(row,['cost_center_2','COST_CENTER_2','OcrCode2'])),
          cost_center_3:cleanString(firstValue(row,['cost_center_3','COST_CENTER_3','OcrCode3'])),
          cost_center_4:cleanString(firstValue(row,['cost_center_4','COST_CENTER_4','OcrCode4'])),
      cost_center_5:cleanString(firstValue(row,['cost_center_5','COST_CENTER_5','OcrCode5'])),
          cost_center_5:cleanString(firstValue(row,['cost_center_5','COST_CENTER_5','OcrCode5'])),
        };
        if(!map.has(id)) map.set(id,[]);
        map.get(id).push(line);
        return map;
      },new Map());
    }

    const data=headerRows.map(row=>{
      const id=asNumber(firstValue(row,['trans_id','TRANS_ID','TransId']));
      return {
        trans_id:id,
        number:asNumber(firstValue(row,['number','NUMBER','Number'])),
        ref_date:dateOnly(firstValue(row,['ref_date','REF_DATE','RefDate'])),
        due_date:dateOnly(firstValue(row,['due_date','DUE_DATE','DueDate'])),
        tax_date:dateOnly(firstValue(row,['tax_date','TAX_DATE','TaxDate'])),
        memo:cleanString(firstValue(row,['memo','MEMO','Memo'])),
        base_ref:cleanString(firstValue(row,['base_ref','BASE_REF','BaseRef'])),
        trans_type:cleanString(firstValue(row,['trans_type','TRANS_TYPE','TransType'])),
        total_debit:asNumber(firstValue(row,['total_debit','TOTAL_DEBIT'])),
        total_credit:asNumber(firstValue(row,['total_credit','TOTAL_CREDIT'])),
        lines:linesByTransId.get(id)||[],
      };
    });

    res.json({
      success:true,
      data,
      count:data.length,
      source:{header:'OJDT',lines:'JDT1',accounts:'OACT'},
      filters:{company:resolveCompany(co),transId,number,baseRef,transType,fromDate,toDate,limit},
    });
  }catch(e){
    console.error('[JOURNAL-ENTRIES] Error:',e.message);
    res.status(e.statusCode||500).json({success:false,message:e.message});
  }
});

// ════════════════════════════════════════════════════════════════
//  ITEM SEARCH
// ════════════════════════════════════════════════════════════════
router.get('/lookup/items', verifyToken, async(req,res)=>{
  const q=(req.query.q||'').trim().toUpperCase();
  const co=cq(req);
  if(!q||q.length<2) return res.json({success:true,data:[]});
  try{
    const safeQ=q.replace(/'/g,"''");
    const rows=await hanaQuery(`
      SELECT TOP 20 "ItemCode","ItemName","InvntryUom","LastPurPrc"
      FROM ${DB(co)}."OITM"
      WHERE UPPER("ItemCode") LIKE '%${safeQ}%' OR UPPER("ItemName") LIKE '%${safeQ}%'
      ORDER BY "ItemCode"`);
    if(rows.length) return res.json({success:true,data:rows.map(i=>({
      ItemCode:i.ItemCode,ItemName:i.ItemName,UoM:i.InvntryUom||'PCS',Price:Number(i.LastPurPrc)||0,
    }))});
  }catch{console.warn('[SAP] HANA items → fallback SL');}
  try{
    const safeQ=q.replace(/'/g,"''");
    const filter=encodeURIComponent(`substringof('${safeQ}',ItemCode) eq true or substringof('${safeQ}',ItemName) eq true`);
    const result=await getSap().sapRequest('GET',`Items?$filter=${filter}&$select=ItemCode,ItemName,InventoryUOM,LastPurchasePrice&$top=20`,null,co);
    res.json({success:true,data:(result?.value||[]).map(i=>({
      ItemCode:i.ItemCode,ItemName:i.ItemName,UoM:i.InventoryUOM||'PCS',Price:Number(i.LastPurchasePrice)||0,
    }))});
  }catch(err){res.json({success:true,data:[],warning:err.message});}
});

// ════════════════════════════════════════════════════════════════
//  SAC CODES  (OSAC — Service/Expense Accounting Codes, India GST)
//  SACEntry on service lines is mandatory when a GST tax code is set.
// ════════════════════════════════════════════════════════════════
router.get('/lookup/sac-codes', verifyToken, async(req,res)=>{
  const q=(req.query.q||'').replace(/'/g,"''").toUpperCase();
  const co=cq(req);
  try{
    const rows=await hanaQuery(`
      SELECT TOP 50 "AbsEntry","ServCode","ServName"
      FROM ${DB(co)}."OSAC"
      WHERE (UPPER("ServCode") LIKE '%${q}%' OR UPPER("ServName") LIKE '%${q}%')
      ORDER BY "ServCode"`);
    if(rows.length){
      console.log(`[SAP] SAC codes (OSAC): ${rows.length}`);
      return res.json({success:true,data:rows.map(r=>({
        AbsEntry: r.AbsEntry, SACCode: r.ServCode, SACName: r.ServName||r.ServCode,
      }))});
    }
    throw new Error('OSAC returned 0 rows');
  }catch(e){
    console.warn('[SAP] OSAC fallback to SL:', e.message);
    try{
      const result=await getSap().sapRequest('GET',`SACCollection?$select=AbsEntry,ServCode,ServName&$top=50`,null,co);
      res.json({success:true,data:(result?.value||[]).map(r=>({
        AbsEntry: r.AbsEntry, SACCode: r.ServCode, SACName: r.ServName||r.ServCode,
      }))});
    }catch(err){res.json({success:true,data:[],warning:err.message});}
  }
});

// ════════════════════════════════════════════════════════════════
//  LOCATIONS  (OLCT — Location Master Data)
// ════════════════════════════════════════════════════════════════
router.get('/lookup/locations', verifyToken, async(req,res)=>{
  const q=(req.query.q||'').replace(/'/g,"''").toUpperCase();
  const co=cq(req);
  try{
    const rows=await hanaQuery(`
      SELECT TOP 40 "AbsEntry","Name"
      FROM ${DB(co)}."OLCT"
      WHERE "Inactive"='N'
        AND (UPPER(CAST("AbsEntry" AS NVARCHAR)) LIKE '%${q}%' OR UPPER("Name") LIKE '%${q}%')
      ORDER BY "AbsEntry"`);
    if(rows.length){
      console.log(`[SAP] Locations (OLCT): ${rows.length}`);
      return res.json({success:true,data:rows.map(r=>({code:String(r.AbsEntry),name:r.Name||String(r.AbsEntry)}))});
    }
    throw new Error('OLCT empty or not found');
  }catch(e){
    console.warn('[SAP] OLCT fallback to OWHS:', e.message);
    try{
      const rows2=await hanaQuery(`
        SELECT TOP 40 "WhsCode","WhsName"
        FROM ${DB(co)}."OWHS"
        WHERE "Inactive"='N'
          AND (UPPER("WhsCode") LIKE '%${q}%' OR UPPER("WhsName") LIKE '%${q}%')
        ORDER BY "WhsCode"`);
      return res.json({success:true,data:rows2.map(r=>({code:r.WhsCode,name:r.WhsName||r.WhsCode})),warning:'Fallback to OWHS'});
    }catch(e2){ res.json({success:true,data:[],warning:e2.message}); }
  }
});

// ════════════════════════════════════════════════════════════════
//  WAREHOUSES
// ════════════════════════════════════════════════════════════════
router.get('/lookup/warehouses', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const rows=await hanaQuery(`SELECT "WhsCode","WhsName" FROM ${DB(co)}."OWHS" WHERE "Inactive"='N' ORDER BY "WhsCode"`);
    if(rows.length) return res.json({success:true,data:rows.map(r=>({code:r.WhsCode,name:r.WhsName}))});
  }catch{console.warn('[SAP] HANA warehouse → fallback SL');}
  try{
    const result=await getSap().sapRequest('GET',`Warehouses?$select=WarehouseCode,WarehouseName&$top=100`,null,co);
    res.json({success:true,data:(result?.value||[]).map(w=>({code:w.WarehouseCode,name:w.WarehouseName}))});
  }catch(err){res.json({success:true,data:[],warning:err.message});}
});

// ════════════════════════════════════════════════════════════════
//  GL ACCOUNTS
// ════════════════════════════════════════════════════════════════
router.get('/lookup/gl-accounts', verifyToken, async(req,res)=>{
  const q=(req.query.q||'').replace(/'/g,"''").toUpperCase();
  const co=cq(req);
  try{
    const rows=await hanaQuery(`
      SELECT TOP 30 "AcctCode","AcctName"
      FROM ${DB(co)}."OACT"
      WHERE "Postable"='Y'
        AND (UPPER("AcctCode") LIKE '%${q}%' OR UPPER("AcctName") LIKE '%${q}%')
      ORDER BY "AcctCode"`);
    res.json({success:true,data:rows.map(r=>({AcctCode:r.AcctCode,AcctName:r.AcctName}))});
  }catch(e){res.json({success:true,data:[],warning:e.message});}
});

// Combined account picker for the General Ledger page: searches BOTH the chart of
// accounts (OACT) and business partners (OCRD), since the GL ledger accepts either a
// G/L account code or a BP code. Vendors/customers like "AWL Agri Business Limited"
// only exist in OCRD, so the plain gl-accounts lookup never surfaces them.
router.get('/lookup/gl-search', verifyToken, async(req,res)=>{
  const q=(req.query.q||'').replace(/'/g,"''").toUpperCase();
  const co=cq(req);
  try{
    const [accts,bps]=await Promise.all([
      hanaQuery(`
        SELECT TOP 20 "AcctCode" AS "code","AcctName" AS "name"
        FROM ${DB(co)}."OACT"
        WHERE "Postable"='Y'
          AND (UPPER("AcctCode") LIKE '%${q}%' OR UPPER("AcctName") LIKE '%${q}%')
        ORDER BY "AcctCode"`).catch(()=>[]),
      hanaQuery(`
        SELECT TOP 20 "CardCode" AS "code","CardName" AS "name","CardType" AS "cardType"
        FROM ${DB(co)}."OCRD"
        WHERE "validFor"='Y'
          AND (UPPER("CardCode") LIKE '%${q}%' OR UPPER("CardName") LIKE '%${q}%')
        ORDER BY "CardName"`).catch(()=>[]),
    ]);
    const bpKind=t=>t==='S'?'Vendor':t==='C'?'Customer':'BP';
    const data=[
      ...accts.map(r=>({code:r.code,name:r.name,kind:'G/L'})),
      ...bps.map(r=>({code:r.code,name:r.name,kind:bpKind(r.cardType)})),
    ];
    res.json({success:true,data});
  }catch(e){res.json({success:true,data:[],warning:e.message});}
});

// General ledger / account statement — all journal postings to a single G/L account.
// The running balance is anchored on the live account balance (OACT."CurrTotal") and
// walked backwards from the most recent posting, so it stays correct even when the
// returned rows are capped.
router.get('/gl-ledger', verifyToken, async(req,res)=>{
  const co=cq(req);
  const account=cleanString(req.query.account);
  if(!account) return res.status(400).json({success:false,message:'account is required'});
  const top=Math.min(Math.max(parseInt(req.query.top,10)||200,1),1000);
  const {dateFrom,dateTo}=req.query;
  try{
    let acctRows=await hanaQuery('SELECT "AcctName","CurrTotal" FROM '+DB(co)+'."OACT" WHERE "AcctCode"=?',[account]);
    // Not a G/L account? Fall back to a business partner (BP control ledger, e.g. a vendor).
    if(!acctRows.length){
      try{ acctRows=await hanaQuery('SELECT "CardName" AS "AcctName","Balance" AS "CurrTotal" FROM '+DB(co)+'."OCRD" WHERE "CardCode"=?',[account]); }catch(_e){}
    }
    const acct=acctRows[0]||{};
    // Match the G/L account directly OR the BP short name (SAP's General Ledger lists both).
    const where=['(J."Account"=? OR J."ShortName"=?)']; const params=[account,account];
    if(dateFrom){ where.push('J."RefDate">=?'); params.push(dateFrom); }
    if(dateTo){ where.push('J."RefDate"<=?'); params.push(dateTo); }
    const whereSql=where.join(' AND ');
    const cntRows=await hanaQuery('SELECT COUNT(*) AS "C" FROM '+DB(co)+'."JDT1" J WHERE '+whereSql,params);
    const total=Number(firstValue(cntRows[0]||{},['C','c'])||0);
    const rows=await hanaQuery(
      'SELECT TOP '+top+' J."TransId" AS "transId", J."RefDate" AS "date", J."DueDate" AS "dueDate", '+
      'J."TaxDate" AS "docDate", J."Debit" AS "debit", '+
      'J."Credit" AS "credit", J."LineMemo" AS "memo", J."BaseRef" AS "ref", '+
      'H."Ref2" AS "billNo", H."TransType" AS "type" '+
      'FROM '+DB(co)+'."JDT1" J JOIN '+DB(co)+'."OJDT" H ON H."TransId"=J."TransId" '+
      'WHERE '+whereSql+' ORDER BY J."RefDate" DESC, J."TransId" DESC',params);
    // Anchor running balance on the current account balance and walk older.
    let running=Number(firstValue(acct,['CurrTotal','currtotal'])||0);
    const lines=rows.map(r=>{
      const r2=n=>Math.round(n*100)/100;
      const debit=r2(Number(firstValue(r,['debit','Debit'])||0));
      const credit=r2(Number(firstValue(r,['credit','Credit'])||0));
      const balance=r2(running);        // balance AFTER this posting
      running=running-(debit-credit);   // balance after the next-older posting
      return {
        transId:cleanString(firstValue(r,['transId','TransId'])),
        date:firstValue(r,['date','RefDate']),
        dueDate:firstValue(r,['dueDate','DueDate']),
        docDate:firstValue(r,['docDate','TaxDate']),
        debit, credit, balance,
        memo:cleanString(firstValue(r,['memo','LineMemo'])),
        ref:cleanString(firstValue(r,['ref','BaseRef'])),
        billNo:cleanString(firstValue(r,['billNo','Ref2'])),
        type:cleanString(firstValue(r,['type','TransType'])),
      };
    });
    res.json({success:true,data:{
      account, name:cleanString(firstValue(acct,['AcctName','ACCTNAME'])),
      balance:Number(firstValue(acct,['CurrTotal','currtotal'])||0),
      currency:'INR', total, lines,
    }});
  }catch(e){ res.json({success:false,message:e.message}); }
});

// ════════════════════════════════════════════════════════════════
//  TAX CODES — query OSTC
// ════════════════════════════════════════════════════════════════
router.get('/lookup/tax-codes', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const rows=await hanaQuery(`
      SELECT "Code","Name","Rate"
      FROM ${DB(co)}."OSTC"
      WHERE "Locked"='N'
      ORDER BY "Code"`);
    console.log(`[SAP] Tax codes from HANA: ${rows.length}`);
    if(rows.length){
      return res.json({success:true,data:rows.map(r=>({
        Code:r.Code,
        Name:r.Name||r.Code,
        Rate:Number(r.Rate)||0
      }))});
    }
    throw new Error('No rows from OSTC');
  }catch(e){
    console.warn('[SAP] HANA OSTC failed → trying VatGroups SL:', e.message);
    try{
      const result=await getSap().sapRequest('GET',
        `VatGroups?$select=Code,Name,VatGroups_Lines&$filter=Inactive eq tNO&$top=200`,null,co);
      const items=(result?.value||[]).map(r=>{
        const rate=r.VatGroups_Lines?.[0]?.Rate||0;
        return {Code:r.Code,Name:r.Name||r.Code,Rate:Number(rate)};
      });
      console.log(`[SAP] VatGroups SL fallback: ${items.length}`);
      return res.json({success:true,data:items});
    }catch(e2){
      console.warn('[SAP] VatGroups SL also failed:', e2.message);
      return res.json({success:true,data:[
        {Code:'CG+SG@0',  Name:'CGST+SGST 0%',  Rate:0},
        {Code:'CG+SG@5',  Name:'CGST+SGST 5%',  Rate:5},
        {Code:'CG+SG@12', Name:'CGST+SGST 12%', Rate:12},
        {Code:'CG+SG@18', Name:'CGST+SGST 18%', Rate:18},
        {Code:'CG+SG@28', Name:'CGST+SGST 28%', Rate:28},
        {Code:'IGST@0',   Name:'IGST 0%',        Rate:0},
        {Code:'IGST@5',   Name:'IGST 5%',         Rate:5},
        {Code:'IGST@12',  Name:'IGST 12%',        Rate:12},
        {Code:'IGST@18',  Name:'IGST 18%',        Rate:18},
        {Code:'IGST@28',  Name:'IGST 28%',        Rate:28},
        {Code:'EXEMPT',   Name:'Exempt',           Rate:0},
        {Code:'NIL',      Name:'NIL Rated',        Rate:0},
      ],warning:'Fallback codes — HANA/SL unavailable'});
    }
  }
});

// ════════════════════════════════════════════════════════════════
//  COSTING CODES  (by dimension)
//  Dim1=Budget  Dim2=Eff.Month  Dim3=Variety  Dim4=Sub Budget  Dim5=Location
// ════════════════════════════════════════════════════════════════
router.get('/lookup/costing-codes', verifyToken, async(req,res)=>{
  const q=(req.query.q||'').replace(/'/g,"''").toUpperCase();
  const dim=parseInt(req.query.dim)||1;
  const co=cq(req);
  try{
    const rows=await hanaQuery(`
      SELECT TOP 100 "PrcCode","PrcName"
      FROM ${DB(co)}."OPRC"
      WHERE "DimCode"=${dim}
        AND "Locked"='N'
        AND (UPPER("PrcCode") LIKE '%${q}%' OR UPPER("PrcName") LIKE '%${q}%')
      ORDER BY "PrcCode"`);
    res.json({success:true,data:rows.map(r=>({PrcCode:r.PrcCode,PrcName:r.PrcName}))});
  }catch(e){res.json({success:true,data:[],warning:e.message});}
});

// ════════════════════════════════════════════════════════════════
//  BRANCHES
// ════════════════════════════════════════════════════════════════
router.get('/lookup/branches', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const rows=await hanaQuery(`
      SELECT "BPLId","BPLName","TaxIdNum"
      FROM ${DB(co)}."OBPL"
      WHERE "Disabled"='N'
      ORDER BY "BPLName"`);
    res.json({success:true,data:rows.map(r=>({BPLId:r.BPLId,BPLName:r.BPLName,TaxIdNum:r.TaxIdNum}))});
  }catch(e){res.json({success:true,data:[],warning:e.message});}
});

// ════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ════════════════════════════════════════════════════════════════
router.get('/lookup/customers', verifyToken, async(req,res)=>{
  const q=(req.query.q||'').replace(/'/g,"''").toUpperCase();
  const co=cq(req);
  try{
    const rows=await hanaQuery(`
      SELECT TOP 30 "CardCode","CardName"
      FROM ${DB(co)}."OCRD"
      WHERE "CardType"='C' AND "validFor"='Y'
        AND (UPPER("CardCode") LIKE '%${q}%' OR UPPER("CardName") LIKE '%${q}%')
      ORDER BY "CardName"`);
    res.json({success:true,data:rows.map(r=>({CardCode:r.CardCode,CardName:r.CardName}))});
  }catch(e){res.json({success:true,data:[],warning:e.message});}
});

// ════════════════════════════════════════════════════════════════
//  VENDORS
// ════════════════════════════════════════════════════════════════
router.get('/lookup/vendors', verifyToken, async(req,res)=>{
  const q=(req.query.q||'').replace(/'/g,"''").toUpperCase();
  const co=cq(req);
  try{
    const rows=await hanaQuery(`
      SELECT TOP 30 "CardCode","CardName"
      FROM ${DB(co)}."OCRD"
      WHERE "CardType"='S' AND "validFor"='Y'
        AND (UPPER("CardCode") LIKE '%${q}%' OR UPPER("CardName") LIKE '%${q}%')
      ORDER BY "CardName"`);
    res.json({success:true,data:rows.map(r=>({CardCode:r.CardCode,CardName:r.CardName}))});
  }catch(e){res.json({success:true,data:[],warning:e.message});}
});

// ════════════════════════════════════════════════════════════════
//  SALES EMPLOYEES
// ════════════════════════════════════════════════════════════════
router.get('/lookup/sales-employees', verifyToken, (req,res)=>
  safeLookup(res,
    `SELECT "SlpCode","SlpName" FROM ${DB(cq(req))}."OSLP" WHERE "SlpCode">0 AND "Locked"='N' ORDER BY "SlpName"`,
    r=>({SlpCode:r.SlpCode,SlpName:r.SlpName}))
);

// ════════════════════════════════════════════════════════════════
//  PAYMENT TERMS
// ════════════════════════════════════════════════════════════════
router.get('/lookup/payment-terms', verifyToken, (req,res)=>
  safeLookup(res,
    `SELECT "GroupNum","PymntGroup" FROM ${DB(cq(req))}."OCTG" ORDER BY "PymntGroup"`,
    r=>({Code:r.GroupNum,Name:r.PymntGroup}))
);

// ════════════════════════════════════════════════════════════════
//  AR ACCOUNTS
// ════════════════════════════════════════════════════════════════
router.get('/lookup/ar-accounts', verifyToken, (req,res)=>
  safeLookup(res,
    `SELECT "AcctCode","AcctName" FROM ${DB(cq(req))}."OACT" WHERE "FatherNum"='1101000' ORDER BY "AcctCode"`,
    r=>({AcctCode:r.AcctCode,AcctName:r.AcctName}))
);

// ════════════════════════════════════════════════════════════════
//  AP ACCOUNTS
// ════════════════════════════════════════════════════════════════
router.get('/lookup/ap-accounts', verifyToken, (req,res)=>
  safeLookup(res,
    `SELECT "AcctCode","AcctName" FROM ${DB(cq(req))}."OACT" WHERE "FatherNum"='2101000' ORDER BY "AcctCode"`,
    r=>({AcctCode:r.AcctCode,AcctName:r.AcctName}))
);

// ════════════════════════════════════════════════════════════════
//  MAIN GROUP / CHAIN (UDT)
// ════════════════════════════════════════════════════════════════
router.get('/lookup/main-group', verifyToken, (req,res)=>
  safeLookup(res,
    `SELECT "Code","Name" FROM ${DB(cq(req))}."@MAIN_GROUP" ORDER BY "Code"`,
    r=>({Code:r.Code,Name:r.Name||r.Code}))
);

router.get('/lookup/chain', verifyToken, (req,res)=>
  safeLookup(res,
    `SELECT "Code","Name" FROM ${DB(cq(req))}."@CHAIN" ORDER BY "Code"`,
    r=>({Code:r.Code,Name:r.Name||r.Code}))
);

// ════════════════════════════════════════════════════════════════
//  STATES (paginated)
// ════════════════════════════════════════════════════════════════
router.get('/lookup/states', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    let allStates=[];
    let url=`States?$filter=Country eq 'IN'&$select=Code,Name&$orderby=Name`;
    while(url){
      const result=await getSap().sapRequest('GET',url,null,co);
      allStates=allStates.concat(result?.value||[]);
      const nextLink=result?.['@odata.nextLink'];
      url=nextLink?nextLink.replace(/^.*\/b1s\/v2\//,''):null;
    }
    res.json({success:true,data:allStates.map(r=>({Code:r.Code,Name:r.Name}))});
  }catch(err){res.json({success:true,data:[],warning:err.message});}
});

// ════════════════════════════════════════════════════════════════
//  BP GROUPS (Customer)
// ════════════════════════════════════════════════════════════════
router.get('/lookup/bp-groups', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const result=await getSap().sapRequest('GET',
      `BusinessPartnerGroups?$filter=Type eq 'bbpgt_CustomerGroup'&$select=Code,Name&$orderby=Name`,null,co);
    res.json({success:true,data:(result?.value||[]).map(r=>({GroupCode:r.Code,GroupName:r.Name}))});
  }catch(err){res.json({success:true,data:[],warning:err.message});}
});

// ════════════════════════════════════════════════════════════════
//  BOM SEARCH
// ════════════════════════════════════════════════════════════════
router.get('/bom/search', verifyToken, async(req,res)=>{
  const co=cq(req);
  const q=(req.query.q||'').toUpperCase();
  try{
    // Fetch first page from SL
    console.log('[BOM-SEARCH] Searching q='+q+' co='+co);
    const result=await getSap().sapRequest('GET',`ProductTrees?$select=TreeCode,TreeType,Quantity,Warehouse,ProductDescription&$top=100`,null,co);
    const all=result?.value||[];
    console.log('[BOM-SEARCH] Got '+all.length+' BOMs');
    const filtered=q?all.filter(r=>(r.TreeCode||'').toUpperCase().includes(q)||(r.ProductDescription||'').toUpperCase().includes(q)):all;
    console.log('[BOM-SEARCH] Filtered to '+filtered.length);
    res.json({success:true,data:filtered.slice(0,30)});
  }catch(e){
    console.error('[BOM-SEARCH] Error:',e.message);
    res.json({success:true,data:[],warning:e.message});
  }
});

// ════════════════════════════════════════════════════════════════
//  BOM LIST + DETAIL
// ════════════════════════════════════════════════════════════════
router.get('/bom/list', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const top=Number(req.query.top)||50;
    const skip=Number(req.query.skip)||0;
    const result=await getSap().sapRequest('GET',
      `ProductTrees?$select=TreeCode,TreeType,Quantity,Warehouse,ProductDescription&$top=${top}&$skip=${skip}`,null,co);
    res.json({success:true,data:result.value||[]});
  }catch(err){res.status(500).json({success:false,message:err.message});}
});

router.get('/bom/:treeCode', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const code=encodeURIComponent(req.params.treeCode);
    const result=await getSap().sapRequest('GET',`ProductTrees('${code}')`,null,co);
    res.json({success:true,data:result});
  }catch(err){res.status(404).json({success:false,message:err.message});}
});

// ════════════════════════════════════════════════════════════════
//  HELPER — resolve LocationCode
//
//  ONLY use an explicit integer LocationCode field sent by the
//  frontend.  Do NOT fall back to CostingCode5 — that field is a
//  costing-dimension string (e.g. "DL", "Factory") and has nothing
//  to do with OLCT.AbsEntry.  Treating it as a location integer
//  causes SAP error -5002 "Linked value N does not exist".
//
//  The GRPO frontend must send LocationCode as a proper integer
//  obtained from the /api/sap/lookup/locations endpoint.
// ════════════════════════════════════════════════════════════════
function resolveLocationCode(line, idx){
  const loc = parseInt(line.LocationCode);
  if(!isNaN(loc) && loc > 0){
    console.log(`[GRPO] Line ${idx}: LocationCode=${loc}`);
    return loc;
  }
  console.warn(`[GRPO] Line ${idx}: LocationCode missing or invalid — field will be omitted`);
  return undefined;
}

// ════════════════════════════════════════════════════════════════
//  GRPO POST PROXY  →  POST /api/sap/grpo
//
//  Dimension mapping:
//    CostingCode  = Dim1 → Budget
//    CostingCode2 = Dim2 → Eff. Month
//    CostingCode3 = Dim3 → Variety
//    CostingCode4 = Dim4 → Sub Budget
//    CostingCode5 = Dim5 → Location dimension code (string)
//
//  LocationCode  = separate integer field → OLCT.AbsEntry
//                  must be supplied explicitly by the frontend
//                  via the /lookup/locations picker.
//
//  UDF: U_Litres mapped from litres field on each line.
// ════════════════════════════════════════════════════════════════
router.post('/grpo', verifyToken, async(req,res)=>{
  try{
    const sap=getSap();
    if(!sap) return res.status(503).json({success:false,message:'SAP service not ready'});

    const body=req.body;
    const co=cq(req);
    console.log('[GRPO] Posting DocType:',body.DocType,'Lines:',body.DocumentLines?.length);

    // Remove null/empty date fields — SAP rejects null ISO strings
    if(!body.DocDate)    delete body.DocDate;
    if(!body.DocDueDate) delete body.DocDueDate;
    if(!body.TaxDate)    delete body.TaxDate;

    // ── Service type: clean each line ──────────────────────────
    if(body.DocType==='dDocument_Service' && Array.isArray(body.DocumentLines)){
      body.DocumentLines=body.DocumentLines.map((line,idx)=>{
        const clean={...line};

        // Remove item-only fields that cause errors on service lines
        delete clean.ItemCode;
        delete clean.WarehouseCode;

        // Remove empty costing codes (SAP rejects empty string for dim fields)
        ['CostingCode','CostingCode2','CostingCode3','CostingCode4','CostingCode5'].forEach(k=>{
          if(clean[k]===''||clean[k]===null||clean[k]===undefined) delete clean[k];
        });

        // ── LocationCode ─────────────────────────────────────────
        // Must be an explicit OLCT.AbsEntry integer from the frontend.
        // Resolved from the original `line` (before the cleanup above)
        // so nothing is lost even if CostingCode5 was on the same object.
        const locCode=resolveLocationCode(line, idx);
        if(locCode!==undefined){
          clean.LocationCode=locCode;
        } else {
          delete clean.LocationCode;
        }

        // U_Litres UDF — only set if > 0
        if(clean.U_Litres && Number(clean.U_Litres)>0){
          clean.U_Litres=Number(clean.U_Litres);
        } else {
          delete clean.U_Litres;
        }

        // Ensure LineNum is sequential
        clean.LineNum=idx;
        return clean;
      });
    }

    // ── Items type: clean each line ─────────────────────────────
    if(body.DocType==='dDocument_Items' && Array.isArray(body.DocumentLines)){
      body.DocumentLines=body.DocumentLines.map((line,idx)=>{
        const clean={...line};

        // Remove service-only fields
        delete clean.AccountCode;

        ['CostingCode','CostingCode2','CostingCode3','CostingCode4','CostingCode5'].forEach(k=>{
          if(clean[k]===''||clean[k]===null||clean[k]===undefined) delete clean[k];
        });

        // ── LocationCode (same logic as service lines) ───────────
        const locCode=resolveLocationCode(line, idx);
        if(locCode!==undefined){
          clean.LocationCode=locCode;
        } else {
          delete clean.LocationCode;
        }

        // U_Litres UDF
        if(clean.U_Litres && Number(clean.U_Litres)>0){
          clean.U_Litres=Number(clean.U_Litres);
        } else {
          delete clean.U_Litres;
        }

        clean.LineNum=idx;
        return clean;
      });
    }

    // ── Attachment upload (optional) ─────────────────────────────
    // attachments sent as { bilty:[{name,size,type,data},...], invoice:[...], ... }
    // uploadAttachmentsToSAP expects the same shape used by vendor/customer forms.
    const attachments = body.attachments;
    delete body.attachments;   // remove before sending to SAP
    if(attachments && typeof attachments === 'object'){
      const hasFiles = Object.values(attachments).some(v => (Array.isArray(v)?v:[v]).some(f=>f?.data));
      if(hasFiles){
        try{
          const vendorName = body.CardCode || 'GRPO';
          const absEntry = await sap.uploadAttachmentsToSAP(attachments, vendorName, co);
          if(absEntry){
            body.AttachmentEntry = parseInt(absEntry);
            console.log('[GRPO] AttachmentEntry:', body.AttachmentEntry);
          }
        }catch(attErr){
          console.warn('[GRPO] ⚠ Attachment upload failed (non-fatal):', attErr.message);
        }
      }
    }

    console.log('[GRPO] Final payload:\n', JSON.stringify(body,null,2));
    const result=await sap.sapRequest('POST','PurchaseDeliveryNotes',body,co);
    console.log('[GRPO] ✅ Posted DocEntry:',result?.DocEntry,'DocNum:',result?.DocNum);
    res.json(result);
  }catch(err){
    const sapMsg=err.message||'Unknown SAP error';
    console.error('[GRPO] ❌',sapMsg);
    res.status(400).json({success:false,message:sapMsg,error:{message:{value:sapMsg}}});
  }
});

// ════════════════════════════════════════════════════════════════
//  PRODUCTION ORDER POST  →  POST /api/sap/production-order
// ════════════════════════════════════════════════════════════════
router.post('/production-order', verifyToken, async(req,res)=>{
  try{
    const sap=getSap();
    if(!sap) return res.status(503).json({success:false,message:'SAP service not ready'});
    const body=req.body;
    const co=cq(req);
    console.log('[PROD] Posting Production Order, ItemNo:',body.ItemNo,'Qty:',body.PlannedQuantity);

    // Clean empty dates
    if(!body.DueDate)     delete body.DueDate;
    if(!body.PostingDate) delete body.PostingDate;
    if(!body.StartDate)   delete body.StartDate;

    // Clean lines
    if(Array.isArray(body.ProductionOrderLines)){
      body.ProductionOrderLines=body.ProductionOrderLines.map((line,idx)=>{
        const clean={...line};
        // Remove empty string fields
        ['DistributionRule','DistributionRule2','DistributionRule3','DistributionRule4','DistributionRule5','Project','WipAccount'].forEach(k=>{
          if(clean[k]===''||clean[k]===null||clean[k]===undefined) delete clean[k];
        });
        if(!clean.Warehouse) delete clean.Warehouse;
        clean.VisualOrder=idx;
        return clean;
      });
    }

    // Remove company from payload (not a SAP field)
    delete body.company;

    console.log('[PROD] Final payload:\n',JSON.stringify(body,null,2));
    const result=await sap.sapRequest('POST','ProductionOrders',body,co);
    console.log('[PROD] ✅ Created AbsEntry:',result?.AbsoluteEntry,'DocNum:',result?.DocumentNumber);
    res.json({success:true,data:result});
  }catch(err){
    const sapMsg=err.message||'Unknown SAP error';
    console.error('[PROD] ❌',sapMsg);
    res.status(400).json({success:false,message:sapMsg});
  }
});

// ════════════════════════════════════════════════════════════════
//  PRODUCTION ORDER RELEASE  →  POST /api/sap/production-order/:id/release
// ════════════════════════════════════════════════════════════════
router.post('/production-order/:id/release', verifyToken, async(req,res)=>{
  try{
    const sap=getSap();
    const co=cq(req);
    const id=parseInt(req.params.id);
    console.log('[PROD] Releasing Production Order:',id);
    const result=await sap.sapRequest('PATCH',`ProductionOrders(${id})`,{ProductionOrderStatus:'boposReleased'},co);
    console.log('[PROD] ✅ Released:',id);
    res.json({success:true,data:result});
  }catch(err){
    console.error('[PROD] ❌ Release failed:',err.message);
    res.status(400).json({success:false,message:err.message});
  }
});

// ════════════════════════════════════════════════════════════════
//  PRODUCTION ORDER LIST  →  GET /api/sap/production-orders
// ════════════════════════════════════════════════════════════════
// GET single production order by AbsoluteEntry
router.get('/production-orders/:id', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const id=parseInt(req.params.id);
    const result=await getSap().sapRequest('GET',`ProductionOrders(${id})`,null,co);
    res.json({success:true,data:result});
  }catch(err){res.status(404).json({success:false,message:err.message});}
});

// GET issues (InventoryGenExits) linked to a production order
router.get('/production-orders/:id/issues', verifyToken, async(req,res)=>{
  const co=cq(req);
  const id=parseInt(req.params.id);
  try{
    const filter=encodeURIComponent(`DocumentLines/any(d:d/BaseEntry eq ${id} and d/BaseType eq 202)`);
    const result=await getSap().sapRequest('GET',
      `InventoryGenExits?$filter=${filter}&$select=DocEntry,DocNum,DocDate,DocTotal,Comments,DocumentLines&$orderby=DocEntry desc&$top=50`,null,co);
    res.json({success:true,data:result?.value||[]});
  }catch(err){
    // Fallback: some SAP versions don't support /any filter on lines
    res.json({success:true,data:[],warning:err.message});
  }
});

router.get('/production-orders', verifyToken, async(req,res)=>{
  const co=cq(req);
  const top=Number(req.query.top)||50;
  const skip=Number(req.query.skip)||0;
  const status=req.query.status||'';
  try{
    let filter='';
    if(status==='Planned') filter=`&$filter=ProductionOrderStatus eq 'boposPlanned'`;
    else if(status==='Released') filter=`&$filter=ProductionOrderStatus eq 'boposReleased'`;
    else if(status==='Closed') filter=`&$filter=ProductionOrderStatus eq 'boposClosed'`;
    const result=await getSap().sapRequest('GET',
      `ProductionOrders?$select=AbsoluteEntry,DocumentNumber,ItemNo,ProductDescription,PlannedQuantity,CompletedQuantity,ProductionOrderStatus,Warehouse,DueDate,CustomerCode,ProductionOrderLines&$orderby=AbsoluteEntry desc&$top=${top}&$skip=${skip}${filter}`,null,co);
    // Compute issue/receipt status from lines + HANA check
    const orderIds=(result?.value||[]).map(o=>o.AbsoluteEntry);
    let issueMap={},receiptMap={};
    if(orderIds.length){
      try{
        const idList=orderIds.join(',');
        // Check IGE1 for issues linked to these production orders
        const issueRows=await hanaQuery(`SELECT "BaseEntry",SUM("Quantity") AS "TotalIssued" FROM ${DB(co)}."IGE1" WHERE "BaseType"=202 AND "BaseEntry" IN (${idList}) GROUP BY "BaseEntry"`);
        issueRows.forEach(r=>{issueMap[r.BaseEntry]=Number(r.TotalIssued)||0;});
        // Check IGN1 for receipts linked to these production orders
        const rcptRows=await hanaQuery(`SELECT "BaseEntry",SUM("Quantity") AS "TotalReceipt" FROM ${DB(co)}."IGN1" WHERE "BaseType"=202 AND "BaseEntry" IN (${idList}) GROUP BY "BaseEntry"`);
        rcptRows.forEach(r=>{receiptMap[r.BaseEntry]=Number(r.TotalReceipt)||0;});
      }catch(e){console.warn('[PROD] HANA status check failed:',e.message);}
    }
    const orders=(result?.value||[]).map(o=>{
      const issued=issueMap[o.AbsoluteEntry]||0;
      const received=receiptMap[o.AbsoluteEntry]||0;
      const planned=o.PlannedQuantity||1;
      o._issueStatus=issued>=planned?'full':issued>0?'partial':'';
      o._receiptStatus=received>=planned?'done':received>0?'partial':'';
      delete o.ProductionOrderLines;
      return o;
    });
    res.json({success:true,data:orders});
  }catch(err){res.status(500).json({success:false,message:err.message});}
});

// ════════════════════════════════════════════════════════════════
//  BATCH LOOKUP  (OIBT — batch inventory by item + warehouse)
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
//  RESOURCES (ORSC — Resource Master Data)
// ════════════════════════════════════════════════════════════════
router.get('/lookup/resources', verifyToken, async(req,res)=>{
  const co=cq(req);
  const q=(req.query.q||'').replace(/'/g,"''").toUpperCase();
  // Try HANA first
  try{
    const rows=await hanaQuery(`
      SELECT TOP 30 "VisResCode","ResName"
      FROM ${DB(co)}."ORSC"
      WHERE (UPPER("VisResCode") LIKE '%${q}%' OR UPPER("ResName") LIKE '%${q}%')
      ORDER BY "VisResCode"`);
    if(rows.length) return res.json({success:true,data:rows.map(r=>({ResCode:r.VisResCode,ResName:r.ResName}))});
  }catch(e){console.warn('[SAP] HANA ORSC failed:',e.message);}
  // Fallback to Service Layer — fields are Code, VisCode, Name
  try{
    const result=await getSap().sapRequest('GET',`Resources?$select=Code,VisCode,Name&$top=50`,null,co);
    const all=(result?.value||[]).filter(r=>(r.VisCode||r.Code||'').toUpperCase().includes(q)||(r.Name||'').toUpperCase().includes(q));
    res.json({success:true,data:all.map(r=>({ResCode:r.VisCode||r.Code,ResName:r.Name}))});
  }catch(e2){
    console.warn('[SAP] SL Resources failed:',e2.message);
    res.json({success:true,data:[],warning:e2.message});
  }
});

router.get('/lookup/batches', verifyToken, async(req,res)=>{
  const co=cq(req);
  const itemCode=(req.query.item||'').replace(/'/g,"''");
  const whsCode=(req.query.warehouse||'').replace(/'/g,"''");
  if(!itemCode) return res.json({success:true,data:[]});
  try{
    let where=`"ItemCode"='${itemCode}' AND "Quantity">0`;
    if(whsCode) where+=` AND "WhsCode"='${whsCode}'`;
    const rows=await hanaQuery(`
      SELECT "BatchNum","ItemCode","WhsCode","Quantity","ExpDate"
      FROM ${DB(co)}."OIBT"
      WHERE ${where}
      ORDER BY "ExpDate","BatchNum"`);
    res.json({success:true,data:rows.map(r=>({
      BatchNumber:r.BatchNum,ItemCode:r.ItemCode,Warehouse:r.WhsCode,
      Quantity:Number(r.Quantity),ExpiryDate:r.ExpDate
    }))});
  }catch(e){res.json({success:true,data:[],warning:e.message});}
});

// ════════════════════════════════════════════════════════════════
//  ISSUE FOR PRODUCTION  →  POST /api/sap/issue-production
//  Creates InventoryGenExits linked to a Production Order (BaseType 202)
// ════════════════════════════════════════════════════════════════
router.post('/issue-production', verifyToken, async(req,res)=>{
  try{
    const sap=getSap();
    if(!sap) return res.status(503).json({success:false,message:'SAP service not ready'});
    const body=req.body;
    const co=cq(req);
    console.log('[ISSUE-PROD] Posting Issue for Production, Lines:',body.DocumentLines?.length);

    // Set branch if not provided (default 2 = FACTORY)
    if(!body.BPL_IDAssignedToInvoice) body.BPL_IDAssignedToInvoice = parseInt(body.branchId) || 2;
    delete body.company;
    delete body.branchId;

    if(Array.isArray(body.DocumentLines)){
      body.DocumentLines=body.DocumentLines.map((line,idx)=>{
        const clean={...line};
        clean.BaseEntry=parseInt(clean.BaseEntry);
        clean.BaseLine=parseInt(clean.BaseLine);
        clean.BaseType=202;
        clean.Quantity=parseFloat(clean.Quantity)||0;
        // SAP rejects ItemCode when referencing a production order — it auto-derives from base doc
        delete clean.ItemCode;
        delete clean.ItemDescription;
        ['CostingCode','CostingCode2','CostingCode3','CostingCode4','CostingCode5','ProjectCode'].forEach(k=>{
          if(clean[k]===''||clean[k]===null||clean[k]===undefined) delete clean[k];
        });
        if(!clean.WarehouseCode) delete clean.WarehouseCode;
        if(Array.isArray(clean.BatchNumbers)){
          clean.BatchNumbers=clean.BatchNumbers.filter(b=>b.BatchNumber && b.Quantity>0);
          if(!clean.BatchNumbers.length) delete clean.BatchNumbers;
        } else { delete clean.BatchNumbers; }
        if(Array.isArray(clean.SerialNumbers)){
          clean.SerialNumbers=clean.SerialNumbers.filter(s=>s.InternalSerialNumber);
          if(!clean.SerialNumbers.length) delete clean.SerialNumbers;
        } else { delete clean.SerialNumbers; }
        return clean;
      });
    }

    console.log('[ISSUE-PROD] Final payload:\n',JSON.stringify(body,null,2));
    const result=await sap.sapRequest('POST','InventoryGenExits',body,co);
    console.log('[ISSUE-PROD] ✅ DocEntry:',result?.DocEntry,'DocNum:',result?.DocNum);
    res.json({success:true,data:result});
  }catch(err){
    const sapMsg=err.message||'Unknown SAP error';
    console.error('[ISSUE-PROD] ❌',sapMsg);
    res.status(400).json({success:false,message:sapMsg});
  }
});

// ════════════════════════════════════════════════════════════════
//  RECEIPT FROM PRODUCTION  →  POST /api/sap/receipt-production
//  Creates InventoryGenEntries linked to a Production Order (BaseType 202)
//  This receives the finished product into inventory.
// ════════════════════════════════════════════════════════════════
router.post('/receipt-production', verifyToken, async(req,res)=>{
  try{
    const sap=getSap();
    if(!sap) return res.status(503).json({success:false,message:'SAP service not ready'});
    const body=req.body;
    const co=cq(req);
    console.log('[RECEIPT-PROD] Posting Receipt from Production');

    if(!body.BPL_IDAssignedToInvoice) body.BPL_IDAssignedToInvoice=parseInt(body.branchId)||2;
    delete body.company;
    delete body.branchId;

    if(Array.isArray(body.DocumentLines)){
      body.DocumentLines=body.DocumentLines.map(line=>{
        const clean={...line};
        clean.BaseEntry=parseInt(clean.BaseEntry);
        delete clean.BaseLine;  // omit BaseLine for receipt — SAP derives from production order
        clean.BaseType=202;
        clean.Quantity=parseFloat(clean.Quantity)||0;
        // SAP derives ItemCode from the production order
        delete clean.ItemCode;
        delete clean.ItemDescription;
        if(!clean.WarehouseCode) delete clean.WarehouseCode;
        // Remove TransactionType from lines — will be set via PATCH after creation
        delete clean.TransactionType;
        ['CostingCode','CostingCode2','CostingCode3','CostingCode4','CostingCode5'].forEach(k=>{
          if(clean[k]===''||clean[k]===null||clean[k]===undefined) delete clean[k];
        });
        // BatchNumbers — user-entered batch for produced item
        if(Array.isArray(clean.BatchNumbers)){
          clean.BatchNumbers=clean.BatchNumbers.filter(b=>b.BatchNumber&&b.Quantity>0);
          if(!clean.BatchNumbers.length) delete clean.BatchNumbers;
        } else { delete clean.BatchNumbers; }
        return clean;
      });
    }

    const transType=req.body._transType||'C';
    delete body._transType;

    console.log('[RECEIPT-PROD] Final payload:\n',JSON.stringify(body,null,2));
    const result=await sap.sapRequest('POST','InventoryGenEntries',body,co);
    const docEntry=result?.DocEntry;
    console.log('[RECEIPT-PROD] ✅ DocEntry:',docEntry,'DocNum:',result?.DocNum);

    // Step 2: Update TranType via HANA SQL (Service Layer doesn't support it on POST)
    if(docEntry){
      try{
        const tt=transType==='R'?'R':'C';
        await hanaQuery(`UPDATE ${DB(co)}."IGN1" SET "TranType" = '${tt}' WHERE "DocEntry" = ${docEntry} AND "BaseType" = 202`);
        console.log(`[RECEIPT-PROD] ✅ TranType='${tt}' set via HANA for DocEntry=${docEntry}`);
      }catch(sqlErr){
        console.warn('[RECEIPT-PROD] ⚠ TranType HANA update failed (non-fatal):',sqlErr.message);
      }
    }
    res.json({success:true,data:result});
  }catch(err){
    const sapMsg=err.message||'Unknown SAP error';
    console.error('[RECEIPT-PROD] ❌',sapMsg);
    res.status(400).json({success:false,message:sapMsg});
  }
});

// ════════════════════════════════════════════════════════════════
//  CLOSE PRODUCTION ORDER  →  POST /api/sap/production-order/:id/close
// ════════════════════════════════════════════════════════════════
router.post('/production-order/:id/close', verifyToken, async(req,res)=>{
  try{
    const sap=getSap();
    const co=cq(req);
    const id=parseInt(req.params.id);
    console.log('[PROD] Closing Production Order:',id);
    const result=await sap.sapRequest('PATCH',`ProductionOrders(${id})`,{ProductionOrderStatus:'L'},co);
    console.log('[PROD] ✅ Closed:',id);
    res.json({success:true,data:result});
  }catch(err){
    console.error('[PROD] ❌ Close failed:',err.message);
    res.status(400).json({success:false,message:err.message});
  }
});

// ════════════════════════════════════════════════════════════════
//  BUDGET — UDO (SAP Service Layer)
// ════════════════════════════════════════════════════════════════
// List all budgets via Service Layer
router.get('/budget/list', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    let all=[],url=`BUDGET?$select=DocEntry,DocNum,U_BUDGET,U_SUB_BUDGET,CreateDate&$orderby=DocEntry desc&$top=100`;
    while(url){
      const result=await getSap().sapRequest('GET',url,null,co);
      all=all.concat(result?.value||[]);
      const next=result?.['@odata.nextLink'];
      url=next?next.replace(/^.*\/b1s\/v2\//,''):null;
    }
    res.json({success:true,data:all});
  }catch(e){res.json({success:true,data:[],warning:e.message});}
});

// Get single budget with lines via Service Layer
router.get('/budget/:id', verifyToken, async(req,res)=>{
  const co=cq(req);
  const id=parseInt(req.params.id);
  try{
    const result=await getSap().sapRequest('GET',`BUDGET(${id})`,null,co);
    res.json({success:true,data:result});
  }catch(e){res.status(404).json({success:false,message:e.message});}
});

// Budget (Dim3) and Sub Budget (Dim4) lookups already exist via /lookup/costing-codes?dim=3 and dim=4

// Create/Update budget via SAP Service Layer UDO
router.post('/budget', verifyToken, async(req,res)=>{
  try{
    const sap=getSap();
    const co=cq(req);
    const body=req.body;
    delete body.company;
    console.log('[BUDGET] Creating budget:', JSON.stringify(body,null,2));
    const result=await sap.sapRequest('POST','BUDGET',body,co);
    console.log('[BUDGET] ✅ Created DocEntry:',result?.DocEntry);
    res.json({success:true,data:result});
  }catch(err){
    console.error('[BUDGET] ❌',err.message);
    res.status(400).json({success:false,message:err.message});
  }
});

// Update budget — PUT requires all fields, so fetch existing first and merge
router.put('/budget/:id', verifyToken, async(req,res)=>{
  try{
    const sap=getSap();
    const co=cq(req);
    const id=parseInt(req.params.id);
    const body=req.body;
    delete body.company;
    const payload={
      U_BUDGET:body.U_BUDGET,
      U_SUB_BUDGET:body.U_SUB_BUDGET||null,
      BUDGET1Collection:body.BUDGET1Collection||[],
    };
    console.log('[BUDGET] Updating budget',id,'with',payload.BUDGET1Collection.length,'lines');
    // Use PATCH with ReplaceCollectionsOnPatch header to delete removed lines
    const result=await sap.sapRequest('PATCH',`BUDGET(${id})`,payload,co,true,{'B1S-ReplaceCollectionsOnPatch':'true'});
    console.log('[BUDGET] ✅ Updated DocEntry:',id);
    res.json({success:true,data:result});
  }catch(err){
    console.error('[BUDGET] ❌',err.message);
    res.status(400).json({success:false,message:err.message});
  }
});

// Delete budget
router.delete('/budget/:id', verifyToken, async(req,res)=>{
  try{
    const sap=getSap();
    const co=cq(req);
    const id=parseInt(req.params.id);
    console.log('[BUDGET] Deleting budget',id);
    await sap.sapRequest('DELETE',`BUDGET(${id})`,null,co);
    console.log('[BUDGET] ✅ Deleted DocEntry:',id);
    res.json({success:true});
  }catch(err){
    console.error('[BUDGET] ❌',err.message);
    res.status(400).json({success:false,message:err.message});
  }
});

// ════════════════════════════════════════════════════════════════
//  DOCUMENTS VIEWER — Generic endpoint for all SAP document types
// ════════════════════════════════════════════════════════════════
const DOC_TYPES={
  'Drafts':{select:'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,Comments,DocumentStatus,AttachmentEntry,ObjType',label:'Draft'},
  'PurchaseOrders':{select:'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,Comments,DocumentStatus,BPL_IDAssignedToInvoice,AttachmentEntry',label:'Purchase Order'},
  'PurchaseDeliveryNotes':{select:'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,Comments,DocumentStatus,BPL_IDAssignedToInvoice,AttachmentEntry',label:'GRPO'},
  'PurchaseInvoices':{select:'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,Comments,DocumentStatus,BPL_IDAssignedToInvoice,AttachmentEntry',label:'AP Invoice'},
  'PurchaseCreditNotes':{select:'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,Comments,DocumentStatus,BPL_IDAssignedToInvoice,AttachmentEntry',label:'AP Credit Note'},
  'PurchaseReturns':{select:'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,Comments,DocumentStatus,BPL_IDAssignedToInvoice,AttachmentEntry',label:'Goods Return'},
  'Invoices':{select:'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,Comments,DocumentStatus,BPL_IDAssignedToInvoice,AttachmentEntry',label:'AR Invoice'},
  'CreditNotes':{select:'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,Comments,DocumentStatus,BPL_IDAssignedToInvoice,AttachmentEntry',label:'AR Credit Memo'},
  'Returns':{select:'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,Comments,DocumentStatus,BPL_IDAssignedToInvoice,AttachmentEntry',label:'Return Notes'},
  'JournalEntries':{select:'JdtNum,Number,ReferenceDate,DueDate,Memo,Reference,Reference2,StornoToDate',label:'Journal Entry'},
  'VendorPayments':{select:'DocEntry,DocNum,DocDate,CardCode,CardName,DocCurrency,CashSum,TransferSum,CheckSum,DocTotal,Remarks,JournalRemarks,TransferAccount,TransferDate,TransferReference,AuthorizationStatus,BPLID,BPLName,AttachmentEntry',label:'Outgoing Payment'},
  'PaymentDrafts':{select:'DocEntry,DocNum,DocDate,CardCode,CardName,DocCurrency,CashSum,TransferSum,CheckSum,DocTotal,Remarks,JournalRemarks,TransferAccount,TransferDate,TransferReference,AuthorizationStatus,BPLID,BPLName,AttachmentEntry',label:'Outgoing Payment Draft'},
};

function documentLines(doc){
  return doc?.DocumentLines || doc?.StockTransferLines || doc?.ProductionOrderLines || [];
}

const DOCUMENT_LINE_TABLES={
  Drafts:'DRF1',
  PurchaseOrders:'POR1',
  PurchaseDeliveryNotes:'PDN1',
  PurchaseInvoices:'PCH1',
  PurchaseCreditNotes:'RPC1',
  PurchaseReturns:'RPD1',
  Invoices:'INV1',
  CreditNotes:'RIN1',
  Orders:'RDR1',
  DeliveryNotes:'DLN1',
  Returns:'RDN1',
  InventoryGenEntries:'IGN1',
  InventoryGenExits:'IGE1',
  StockTransfers:'WTR1',
};

async function tableColumnSet(co, table){
  const rows=await hanaQuery(
    'SELECT "COLUMN_NAME" FROM "SYS"."TABLE_COLUMNS" WHERE "SCHEMA_NAME" = ? AND "TABLE_NAME" = ?',
    [resolveCompany(co), table]
  );
  return new Set(rows.map(r=>cleanString(firstValue(r,['COLUMN_NAME','ColumnName','column_name']))).filter(Boolean));
}

function lineValueMissing(v){
  return v===undefined||v===null||v==='';
}

function setLineValue(line, keys, value){
  if(lineValueMissing(value)) return;
  if(Array.isArray(keys)){
    const hasExisting=keys.some(k=>!lineValueMissing(line?.[k]));
    if(hasExisting) return;
    line[keys[0]]=value;
    return;
  }
  if(lineValueMissing(line?.[keys])) line[keys]=value;
}

// Service Layer can omit custom row UDFs in approval/draft reads. Pull the
// full line rows from HANA and fill only fields that are missing in the response.
function rowValue(row, keys){
  for(const key of keys){
    const value=firstValue(row,[key,key.toUpperCase(),key.toLowerCase()]);
    if(!lineValueMissing(value)) return value;
  }
  return undefined;
}

function rowValueLike(row, keys, fragmentGroups){
  const explicit=rowValue(row,keys);
  if(!lineValueMissing(explicit)) return explicit;
  const rowKeys=Object.keys(row||{});
  for(const fragments of fragmentGroups){
    const found=rowKeys.find(k=>{
      const nk=String(k).toLowerCase().replace(/[^a-z0-9]/g,'');
      return fragments.every(f=>nk.includes(f));
    });
    if(found&&!lineValueMissing(row[found])) return row[found];
  }
  return undefined;
}

async function enrichDocumentLineFields(co, type, doc){
  const table=DOCUMENT_LINE_TABLES[type];
  const entry=asNumber(doc?.DocEntry);
  const lines=documentLines(doc);
  if(!table||!entry||!lines.length) return doc;
  try{
    const rows=await hanaQuery(
      'SELECT * FROM '+DB(co)+'."'+table+'" WHERE "DocEntry" = ? ORDER BY "LineNum" ASC',
      [entry]
    );
    if(!rows.length) return doc;
    const byLine=new Map(rows.map(r=>[asNumber(rowValue(r,['LineNum'])),r]));
    lines.forEach((line,idx)=>{
      const lineNum=asNumber(line?.LineNum??line?.LineNumber??idx);
      const row=byLine.get(lineNum) || rows[idx];
      if(!row) return;
      setLineValue(line,['AccountCode','GLAccount','AcctCode'],rowValue(row,['AcctCode','AccountCode','GLAccount','Account']));
      setLineValue(line,['ItemDescription','Description'],rowValue(row,['Dscription','ItemDescription','Description']));
      setLineValue(line,['WarehouseCode','Warehouse','WhsCode'],rowValue(row,['WhsCode','WarehouseCode','Warehouse']));
      setLineValue(line,['LocationCode','LocCode'],rowValue(row,['LocCode','LocationCode','Location']));
      setLineValue(line,['CostingCode','OcrCode'],rowValue(row,['OcrCode','CostingCode']));
      setLineValue(line,['CostingCode2','OcrCode2'],rowValue(row,['OcrCode2','CostingCode2']));
      setLineValue(line,['CostingCode3','OcrCode3'],rowValue(row,['OcrCode3','CostingCode3']));
      setLineValue(line,['CostingCode4','OcrCode4'],rowValue(row,['OcrCode4','CostingCode4']));
      setLineValue(line,['CostingCode5','OcrCode5'],rowValue(row,['OcrCode5','CostingCode5']));
      setLineValue(line,'Project',rowValue(row,['Project']));
      setLineValue(line,['U_UNE_LTS','U_Litres','U_Litre'],rowValueLike(row,['U_UNE_LTS','U_Litres','U_Litre','U_LitreS'],[['u','lts'],['litre'],['liter']]));
      setLineValue(line,['U_BilltyNumber','U_BiltyNumber'],rowValueLike(row,['U_BilltyNumber','U_BiltyNumber','U_BilltyNo','U_BiltyNo'],[['billty'],['bilty']]));
      setLineValue(line,'U_ARNO',rowValueLike(row,['U_ARNO','U_Arno'],[['arno']]));
      const subAccount=rowValueLike(row,[
        'U_Sub_Account','U_SubAccount','U_SubAcct','U_SubAcc','U_Sub_Acc','U_Sub_Accnt','U_Sub_Acco',
        'U_SUB_ACCOUNT','U_SUBACCOUNT','U_SUBACCT','U_SUBACC','U_SUB_ACC','U_SUB_ACCNT','U_SUB_ACCO',
        'SubAccount','SubAcct','SubAcc','Sub_Account','Sub_Acc'
      ],[['sub','account'],['sub','acct'],['sub','acnt'],['sub','acc']]);
      setLineValue(line,['U_Sub_Account','U_SubAccount','U_SubAcct','U_SubAcc','SubAccount'],subAccount);
      if(!lineValueMissing(subAccount)) line.SubAccount=subAccount;
      setLineValue(line,'U_CardCode',rowValueLike(row,['U_CardCode','U_CustomerCode','CardCode','CustomerCode'],[['card','code'],['customer','code']]));
      setLineValue(line,'U_Purpose',rowValueLike(row,['U_Purpose','Purpose'],[['purpose']]));
      setLineValue(line,['U_Remarks','Remarks','FreeText'],rowValue(row,['U_Remarks','FreeTxt','FreeText','Remarks']));
    });
  }catch(e){
    console.warn('[SAP-DOC] line field enrichment skipped:',e.message);
  }
  return doc;
}


function lineAccountCode(line){
  return cleanString(
    line?.GLAccount ||
    line?.AccountCode ||
    line?.AcctCode ||
    line?.['G/L Account'] ||
    line?.Account
  );
}

async function enrichDocumentGlNames(doc, co){
  const lines=documentLines(doc);
  const codes=[...new Set(lines.map(lineAccountCode).filter(Boolean))];
  if(!codes.length) return doc;
  try{
    const quoted=codes.map(c=>"'"+c.replace(/'/g,"''")+"'").join(',');
    const rows=await hanaQuery(
      'SELECT "AcctCode","AcctName" FROM ' + DB(co) + '."OACT" WHERE "AcctCode" IN (' + quoted + ')'
    );
    const names=new Map(rows.map(r=>[cleanString(r.AcctCode),cleanString(r.AcctName)]));
    lines.forEach(line=>{
      const code=lineAccountCode(line);
      if(code&&names.has(code)&&!line.GLName&&!line.AccountName&&!line.AcctName) line.GLName=names.get(code);
    });
  }catch(e){
    console.warn('[SAP-DOC] GL name enrichment skipped:',e.message);
  }
  return doc;
}

// Per-document withholding-tax (TDS) line table by endpoint
const TDS_WT_TABLE={Invoices:'INV5',CreditNotes:'RIN5',PurchaseInvoices:'PCH5',PurchaseCreditNotes:'RPC5'};
function extractTdsSection(name){
  const m=String(name||'').match(/\b(19[0-9][A-Z]{0,2}|20[0-9][A-Z]{0,2}|206C[A-Z]?)\b/);
  return m?m[1].toUpperCase():'';
}
// Resolve the TDS section/rate/amount for a document from its WT table joined to OWHT
async function enrichDocumentTds(co, type, doc){
  const table=TDS_WT_TABLE[type];
  const entry=asNumber(doc?.DocEntry);
  if(!table||!entry) return doc;
  try{
    const rows=await hanaQuery(
      'SELECT X."WTCode" AS "code", X."Rate" AS "rate", X."WTAmnt" AS "amount", X."TaxbleAmnt" AS "taxable", W."WTName" AS "name" FROM '+DB(co)+'."'+table+'" X LEFT JOIN '+DB(co)+'."OWHT" W ON W."WTCode"=X."WTCode" WHERE X."AbsEntry"=?',
      [entry]
    );
    if(!rows.length) return doc;
    doc.TDSDetails=rows.map(r=>{
      const name=cleanString(firstValue(r,['name','NAME','WTName']));
      return {
        code:cleanString(firstValue(r,['code','CODE','WTCode'])),
        name, section:extractTdsSection(name),
        rate:asNumber(firstValue(r,['rate','RATE'])),
        amount:asNumber(firstValue(r,['amount','AMOUNT','WTAmnt'])),
        taxable:asNumber(firstValue(r,['taxable','TAXABLE','TaxbleAmnt'])),
      };
    });
    doc.TDSSection=[...new Set(doc.TDSDetails.map(d=>d.section).filter(Boolean))].join(', ');
  }catch(e){ console.warn('[SAP-DOC] TDS enrichment skipped:',e.message); }
  return doc;
}
// Build a ship-from entry from the document's vendor / counterparty (the "other"
// party — not our own branch). Used as a fallback for service / GL-only documents
// that have no source warehouse. The address text is already on the document; the
// GSTIN / state come from the BP address master (CRD1).
async function shipFromFromVendor(co, doc){
  const cardCode=cleanString(firstValue(doc||{},['CardCode','CARDCODE']));
  if(!cardCode) return null;
  const cardName=cleanString(firstValue(doc||{},['CardName','CARDNAME']));
  const addrCode=cleanString(firstValue(doc||{},['ShipFrom','ShipToCode','PayToCode']));
  let gstin='',state='',address='';
  const where=addrCode?'"CardCode"=? AND "Address"=?':'"CardCode"=?';
  const params=addrCode?[cardCode,addrCode]:[cardCode];
  try{
    // BP address master: GSTIN is CRD1."GSTRegnNo", state is CRD1."State"
    const rows=await hanaQuery(
      'SELECT TOP 1 "GSTRegnNo","State","Street","Block","City","ZipCode","Country" '+
      'FROM '+DB(co)+'."CRD1" WHERE '+where,params);
    const r=rows[0]||{};
    gstin=cleanString(firstValue(r,['GSTRegnNo','GSTREGNNO']));
    state=cleanString(firstValue(r,['State','STATE']));
    address=[firstValue(r,['Street','STREET']),firstValue(r,['Block','BLOCK']),firstValue(r,['City','CITY']),firstValue(r,['State','STATE']),firstValue(r,['ZipCode','ZIPCODE']),firstValue(r,['Country','COUNTRY'])]
      .map(cleanString).filter(Boolean).join(', ');
  }catch(e){ console.warn('[SAP-DOC] Vendor ship-from lookup skipped:',e.message); }
  // fall back to the document's own address text if CRD1 yielded nothing
  if(!address){
    address=cleanString(firstValue(doc||{},['Address','Address2']))
      .replace(/\r\n?/g,', ').replace(/\s*,\s*,+/g,', ').replace(/^,\s*|,\s*$/g,'');
  }
  if(!gstin&&!address&&!cardName) return null;
  // code shows as the heading; leave branch blank so the frontend doesn't repeat it
  return {code:cardName||cardCode,name:'',gstin,branch:'',state,address};
}
// Resolve the full ship-from list (warehouse, GSTIN, branch, state, address) from the document lines
async function enrichWarehouseNames(co, doc){
  const lines=documentLines(doc);
  const codes=[...new Set(lines.map(l=>cleanString(l.WarehouseCode||l.Warehouse||l.WhsCode)).filter(Boolean))];
  if(!codes.length){
    // Service / GL-only documents carry no source warehouse, so derive the
    // ship-from (GSTIN, state, address) from the vendor / counterparty instead.
    const vendorShip=await shipFromFromVendor(co,doc);
    if(vendorShip) doc.ShipFromList=[vendorShip];
    return doc;
  }
  const info=new Map();
  try{
    const quoted=codes.map(c=>"'"+c.replace(/'/g,"''")+"'").join(',');
    const rows=await hanaQuery(
      'SELECT W."WhsCode", W."WhsName", W."Street", W."StreetNo", W."Block", W."City", W."State", W."ZipCode", W."Country", B."BPLName", B."TaxIdNum" AS "gstin", B."State" AS "bpl_state" '+
      'FROM '+DB(co)+'."OWHS" W LEFT JOIN '+DB(co)+'."OBPL" B ON B."BPLId"=W."BPLid" WHERE W."WhsCode" IN ('+quoted+')'
    );
    rows.forEach(r=>{
      const code=cleanString(firstValue(r,['WhsCode','WHSCODE']));
      const addr=[firstValue(r,['StreetNo','STREETNO']),firstValue(r,['Street','STREET']),firstValue(r,['Block','BLOCK']),firstValue(r,['City','CITY']),firstValue(r,['State','STATE']),firstValue(r,['ZipCode','ZIPCODE']),firstValue(r,['Country','COUNTRY'])]
        .map(cleanString).filter(Boolean).join(', ');
      info.set(code,{
        code,
        name:cleanString(firstValue(r,['WhsName','WHSNAME'])),
        gstin:cleanString(firstValue(r,['gstin','GSTIN','TaxIdNum'])),
        branch:cleanString(firstValue(r,['BPLName','BPLNAME'])),
        state:cleanString(firstValue(r,['State','STATE','bpl_state'])),
        address:addr,
      });
    });
    lines.forEach(l=>{const c=cleanString(l.WarehouseCode||l.Warehouse||l.WhsCode); if(c&&info.has(c)&&!l.WarehouseName) l.WarehouseName=info.get(c).name;});
  }catch(e){ console.warn('[SAP-DOC] Warehouse/ship-from enrichment skipped:',e.message); }
  doc.ShipFromList=codes.map(c=>info.get(c)||{code:c,name:'',gstin:'',branch:'',state:'',address:''});
  return doc;
}

async function enrichDocumentBranchName(co, doc){
  const branchId=cleanString(firstValue(doc||{},['BPL_IDAssignedToInvoice','BPLId','BPLID','BranchID']));
  if(!branchId||doc?.BPLName||doc?.BranchName) return doc;
  try{
    const rows=await hanaQuery(
      'SELECT TOP 1 "BPLId","BPLName" FROM '+DB(co)+'."OBPL" WHERE "BPLId" = ?',
      [parseInt(branchId,10)]
    );
    const name=cleanString(firstValue(rows[0]||{},['BPLName','BPLNAME']));
    if(name) doc.BPLName=name;
  }catch(e){ console.warn('[SAP-DOC] Branch name enrichment skipped:',e.message); }
  return doc;
}

// Resolve the "Loc." display name for each document line from the SAP location
// master first. If a legacy payload used a branch id in LocationCode, keep the
// branch name as a fallback instead of showing only a numeric code.
async function enrichLocationNames(co, doc){
  const lines=documentLines(doc);
  const codes=[...new Set(lines.map(l=>cleanString(l.LocationCode)).filter(c=>/^\d+$/.test(c)))];
  if(!codes.length) return doc;
  const locationNames=new Map();
  const branchNames=new Map();
  const idList=codes.join(',');
  try{
    // OLCT (Locations master): the line's LocationCode maps to OLCT."Code", and the
    // display name is OLCT."Location" (e.g. 5 -> "DELHI ISD"). This is the authoritative
    // source — do NOT use OBPL here, which has different names for the same numeric id.
    const rows=await hanaQuery(
      'SELECT "Code","Location" FROM '+DB(co)+'."OLCT" WHERE "Code" IN ('+idList+')'
    );
    rows.forEach(r=>{
      const c=cleanString(firstValue(r,['Code','CODE']));
      const n=cleanString(firstValue(r,['Location','LOCATION']));
      if(c&&n) locationNames.set(c,n);
    });
  }catch(e){ console.warn('[SAP-DOC] Location (OLCT) name lookup skipped:',e.message); }
  try{
    const rows=await hanaQuery(
      'SELECT "BPLId","BPLName" FROM '+DB(co)+'."OBPL" WHERE "BPLId" IN ('+idList+')'
    );
    rows.forEach(r=>{
      const c=cleanString(firstValue(r,['BPLId','BPLID']));
      const n=cleanString(firstValue(r,['BPLName','BPLNAME']));
      if(c&&n) branchNames.set(c,n);
    });
  }catch(e){ console.warn('[SAP-DOC] Branch (OBPL) name lookup skipped:',e.message); }
  lines.forEach(l=>{
    const c=cleanString(l.LocationCode);
    if(!c) return;
    if(branchNames.get(c)&&!l.LocationBranchName) l.LocationBranchName=branchNames.get(c);
    if(locationNames.get(c)){
      l.LocationName=locationNames.get(c);
    }else if(branchNames.get(c)&&!l.LocationName){
      l.LocationName=branchNames.get(c);
    }
  });
  return doc;
}

// Resolve the cost-center dimension codes on each line (CostingCode..CostingCode5,
// i.e. OcrCode..OcrCode5) to their human names from OPRC so the line table can
// show "Haryana"/"Delhi" instead of the raw dimension code (e.g. "DL").
const DIMENSION_FIELDS=['CostingCode','CostingCode2','CostingCode3','CostingCode4','CostingCode5'];
async function enrichDimensionNames(co, doc){
  const lines=documentLines(doc);
  if(!lines.length) return doc;
  const codes=new Set();
  lines.forEach(l=>DIMENSION_FIELDS.forEach(f=>{const v=cleanString(l?.[f]); if(v) codes.add(v);}));
  if(!codes.size) return doc;
  const names=new Map();
  try{
    const quoted=[...codes].map(c=>"'"+c.replace(/'/g,"''")+"'").join(',');
    const rows=await hanaQuery(
      'SELECT "PrcCode","PrcName" FROM '+DB(co)+'."OPRC" WHERE "PrcCode" IN ('+quoted+')'
    );
    rows.forEach(r=>{
      const c=cleanString(firstValue(r,['PrcCode','PRCCODE']));
      const n=cleanString(firstValue(r,['PrcName','PRCNAME']));
      if(c&&n) names.set(c,n);
    });
  }catch(e){ console.warn('[SAP-DOC] Dimension (OPRC) name lookup skipped:',e.message); }
  if(!names.size) return doc;
  lines.forEach(l=>DIMENSION_FIELDS.forEach(f=>{
    const v=cleanString(l?.[f]);
    if(v&&names.has(v)) l[f+'Name']=names.get(v);
  }));
  return doc;
}

function journalTransTypeForDocument(type, doc){
  const byType={
    Invoices:'13', CreditNotes:'14', PurchaseInvoices:'18', PurchaseCreditNotes:'19',
    PurchaseOrders:'22', PurchaseDeliveryNotes:'20', PurchaseReturns:'21', Returns:'16',
    Orders:'17', DeliveryNotes:'15', StockTransfers:'67', ProductionOrders:'202',
    InventoryGenExits:'59', InventoryGenEntries:'60',
    VendorPayments:'46', PaymentDrafts:'46', IncomingPayments:'24',
  };
  const fromDoc=cleanString(doc?.ObjType||doc?.ObjectType||doc?.DocObjectCode);
  if(type==='Drafts'&&fromDoc) return fromDoc;
  return byType[type]||fromDoc||'';
}
function journalReferenceCandidates(doc){
  const values=new Set();
  [
    doc?.TransId, doc?.TransNum, doc?.JournalEntry, doc?.JdtNum,
    doc?.DocNum, doc?.DocEntry, doc?.DraftEntry,
    doc?.NumAtCard, doc?.SupplierRefNo, doc?.VendorRefNo,
    doc?.InvoiceNo, doc?.InvoiceNumber, doc?.TaxInvoiceNo,
    doc?.U_InvoiceNo, doc?.U_InvNo,
  ].forEach(v=>cleanString(v)&&values.add(cleanString(v)));
  const text=cleanString(doc?.Comments||doc?.Remarks);
  const invoice=text.match(/invoice\s*(?:no|number|#)?\.?\s*[:\-]?\s*([A-Z0-9/\-]+)/i);
  if(invoice?.[1]) values.add(cleanString(invoice[1]));
  return [...values].filter(Boolean).slice(0,20);
}

async function fetchJournalEntryByReference(co, refs, transType=null){
  const cleanRefs=[...new Set((refs||[]).map(cleanString).filter(Boolean))];
  if(!cleanRefs.length) return null;
  const db=DB(co);
  const whereParts=[];
  const params=[];
  cleanRefs.forEach(ref=>{
    whereParts.push("(CAST(H.\"BaseRef\" AS NVARCHAR) = ? OR CAST(H.\"Number\" AS NVARCHAR) = ? OR UPPER(COALESCE(H.\"Ref1\",'')) LIKE ? OR UPPER(COALESCE(H.\"Ref2\",'')) LIKE ? OR UPPER(COALESCE(H.\"Ref3\",'')) LIKE ? OR UPPER(COALESCE(H.\"Memo\",'')) LIKE ?)");
    const like='%'+ref.toUpperCase()+'%';
    params.push(ref,ref,like,like,like,like);
  });
  const typeFilter=cleanString(transType);
  const whereSql='('+whereParts.join(' OR ')+')'+(typeFilter?' AND CAST(H."TransType" AS NVARCHAR) = ?':'');
  if(typeFilter) params.push(typeFilter);
  const rows=await hanaQuery(
    'SELECT TOP 1 H."TransId" AS "trans_id" FROM '+db+'."OJDT" H WHERE '+whereSql+' ORDER BY H."TransId" DESC',
    params
  );
  const id=asNumber(firstValue(rows[0]||{},['trans_id','TRANS_ID','TransId']));
  return id?fetchJournalEntryByTransId(co,id):null;
}

function inTransitTransTypeForDocument(type, doc){
  const target=journalTransTypeForDocument(type,doc);
  if(target==='18'||target==='19') return '20';
  if(target==='13'||target==='14') return '15';
  return '';
}

async function fetchJournalEntryForDocument(co, doc, transType=null){
  const transId=doc?.TransId||doc?.TransNum||doc?.JournalEntry||doc?.JdtNum;
  if(transId){
    const direct=await fetchJournalEntryByTransId(co,transId);
    if(direct) return direct;
  }
  return fetchJournalEntryByReference(co,journalReferenceCandidates(doc),transType);
}
async function fetchJournalEntryByTransId(co, transId){
  const id=parseInt(transId,10);
  if(!Number.isFinite(id)||id<=0) return null;
  const db=DB(co);
  const headerRows=await hanaQuery(
    'SELECT TOP 1 H."TransId" AS "trans_id", H."Number" AS "number", H."RefDate" AS "ref_date", H."DueDate" AS "due_date", H."TaxDate" AS "tax_date", H."Memo" AS "memo", H."BaseRef" AS "base_ref", H."TransType" AS "trans_type", CAST(COALESCE(SUM(L."Debit"),0) AS DECIMAL(19,2)) AS "total_debit", CAST(COALESCE(SUM(L."Credit"),0) AS DECIMAL(19,2)) AS "total_credit" FROM ' + db + '."OJDT" H LEFT JOIN ' + db + '."JDT1" L ON L."TransId" = H."TransId" WHERE H."TransId" = ? GROUP BY H."TransId",H."Number",H."RefDate",H."DueDate",H."TaxDate",H."Memo",H."BaseRef",H."TransType"',
    [id]
  );
  if(!headerRows.length) return null;
  const lineRows=await hanaQuery(
    'SELECT L."Line_ID" AS "line_id", L."Account" AS "account", A."AcctName" AS "account_name", L."ShortName" AS "short_name", CAST(COALESCE(L."Debit",0) AS DECIMAL(19,2)) AS "debit", CAST(COALESCE(L."Credit",0) AS DECIMAL(19,2)) AS "credit", L."ContraAct" AS "contra_account", L."LineMemo" AS "line_memo", L."ProfitCode" AS "cost_center", L."OcrCode2" AS "cost_center_2", L."OcrCode3" AS "cost_center_3", L."OcrCode4" AS "cost_center_4" FROM ' + db + '."JDT1" L LEFT JOIN ' + db + '."OACT" A ON A."AcctCode" = L."Account" WHERE L."TransId" = ? ORDER BY L."Line_ID" ASC',
    [id]
  );
  const h=headerRows[0];
  return {
    trans_id:asNumber(firstValue(h,['trans_id','TRANS_ID','TransId'])),
    number:asNumber(firstValue(h,['number','NUMBER','Number'])),
    ref_date:dateOnly(firstValue(h,['ref_date','REF_DATE','RefDate'])),
    due_date:dateOnly(firstValue(h,['due_date','DUE_DATE','DueDate'])),
    tax_date:dateOnly(firstValue(h,['tax_date','TAX_DATE','TaxDate'])),
    memo:cleanString(firstValue(h,['memo','MEMO','Memo'])),
    base_ref:cleanString(firstValue(h,['base_ref','BASE_REF','BaseRef'])),
    trans_type:cleanString(firstValue(h,['trans_type','TRANS_TYPE','TransType'])),
    total_debit:asNumber(firstValue(h,['total_debit','TOTAL_DEBIT'])),
    total_credit:asNumber(firstValue(h,['total_credit','TOTAL_CREDIT'])),
    lines:lineRows.map(row=>({
      line_id:asNumber(firstValue(row,['line_id','LINE_ID','Line_ID'])),
      account:cleanString(firstValue(row,['account','ACCOUNT','Account'])),
      account_name:cleanString(firstValue(row,['account_name','ACCOUNT_NAME','AcctName'])),
      short_name:cleanString(firstValue(row,['short_name','SHORT_NAME','ShortName'])),
      debit:asNumber(firstValue(row,['debit','DEBIT','Debit'])),
      credit:asNumber(firstValue(row,['credit','CREDIT','Credit'])),
      contra_account:cleanString(firstValue(row,['contra_account','CONTRA_ACCOUNT','ContraAct'])),
      line_memo:cleanString(firstValue(row,['line_memo','LINE_MEMO','LineMemo'])),
      cost_center:cleanString(firstValue(row,['cost_center','COST_CENTER','ProfitCode'])),
      cost_center_2:cleanString(firstValue(row,['cost_center_2','COST_CENTER_2','OcrCode2'])),
      cost_center_3:cleanString(firstValue(row,['cost_center_3','COST_CENTER_3','OcrCode3'])),
      cost_center_4:cleanString(firstValue(row,['cost_center_4','COST_CENTER_4','OcrCode4'])),
    })),
  };
}

// ── Draft journal reconstruction ──────────────────────────────────────────
// A document awaiting approval is held as a DRAFT (ODRF/DRF1/DRF3); SAP has not
// posted an OJDT/JDT1 journal yet, so there is nothing to read back. SAP computes
// the journal live from its G/L account determination. We reproduce that result
// from the draft itself: each document line already carries its determined G/L
// account (DRF1."AcctCode"), the BP control account comes from OCRD."DebPayAcct",
// GST is split per tax-code component (STC1) and matched to the chart of accounts,
// additional expenses come from DRF3, and any residual lands on the rounding
// (Short & Excess) account so the preview always balances — mirroring SAP exactly.
const AP_JOURNAL_TYPES=new Set(['18','19','20','22']);  // AP invoice/credit, GRPO, PO → BP credited
function gstAccountKind(staCode){
  const c=String(staCode||'').toUpperCase();
  if(c.includes('IGST')||c.startsWith('IG'))return 'IGST';
  if(c.includes('CGST')||c.startsWith('CG')||c.startsWith('RCG'))return 'CGST';
  if(c.includes('SGST')||c.startsWith('SG')||c.startsWith('RSG'))return 'SGST';
  if(c.includes('CESS'))return 'CESS';
  return null;
}
// GST G/L accounts follow a naming convention ("INPUT IGST @ 18 %", "OUTPUT CGST @ 2.5 %").
// OSTA/OSTT carry no account here, so the chart of accounts is the determination source.
async function resolveGstAccount(co,direction,kind,rate){
  const rateStr=String(Number(rate));  // "18.000000" → "18", "2.500000" → "2.5"
  const rows=await hanaQuery(
    'SELECT "AcctCode","AcctName" FROM '+DB(co)+'."OACT" WHERE UPPER("AcctName") LIKE ? AND UPPER("AcctName") LIKE ? AND UPPER("AcctName") LIKE ? AND UPPER("AcctName") NOT LIKE \'%RCM%\' ORDER BY LENGTH("AcctName") ASC',
    ['%'+direction+'%','%'+kind+'%','%'+rateStr+'%']
  );
  return rows[0]||null;
}
async function buildDraftJournalEntryFromHana(co,draftEntry){
  const id=parseInt(draftEntry,10);
  if(!Number.isFinite(id)||id<=0) return null;
  const db=DB(co);
  const hRows=await hanaQuery('SELECT TOP 1 "CardCode","CardName","DocTotal","DocDate","DocDueDate","TaxDate","ObjType","NumAtCard","JrnlMemo" FROM '+db+'."ODRF" WHERE "DocEntry"=?',[id]);
  if(!hRows.length) return null;
  const h=hRows[0];
  const objType=cleanString(firstValue(h,['ObjType']));
  const isAP=AP_JOURNAL_TYPES.has(objType);
  const dir=isAP?'INPUT':'OUTPUT';
  const expenseSide=isAP?'D':'C';   // GRNI/expense (AP debit, AR credit)
  const taxSide=isAP?'D':'C';       // input tax debit / output tax credit
  const bpSide=isAP?'C':'D';        // vendor credit / customer debit
  const ctlRows=await hanaQuery('SELECT TOP 1 "DebPayAcct" FROM '+db+'."OCRD" WHERE "CardCode"=?',[cleanString(h.CardCode)]);
  const ctlAcct=cleanString(ctlRows[0]?.DebPayAcct);
  const lineRows=await hanaQuery('SELECT "LineNum","AcctCode","LineTotal","LineVat","TaxCode" FROM '+db+'."DRF1" WHERE "DocEntry"=? ORDER BY "LineNum"',[id]);
  const expRows=await hanaQuery('SELECT "ExpnsCode","LineTotal","LineVat","TaxCode","Stock" FROM '+db+'."DRF3" WHERE "DocEntry"=?',[id]).catch(()=>[]);

  const lines=[];
  const r2=(v)=>Math.round(asNumber(v)*10000)/10000;
  const nameCache={};
  async function acctName(code){
    const c=cleanString(code); if(!c) return '';
    if(nameCache[c]!==undefined) return nameCache[c];
    const r=await hanaQuery('SELECT TOP 1 "AcctName" FROM '+db+'."OACT" WHERE "AcctCode"=?',[c]);
    return (nameCache[c]=cleanString(r[0]?.AcctName));
  }
  const add=(acct,name,amt,side)=>{ const v=r2(amt); if(!v) return; lines.push({account:cleanString(acct),account_name:cleanString(name),short_name:'',debit:side==='D'?v:0,credit:side==='C'?v:0,line_memo:'',cost_center:'',cost_center_2:'',cost_center_3:'',cost_center_4:'',cost_center_5:''}); };
  async function addTax(taxCode,lineVat){
    if(!asNumber(lineVat)) return;
    const comps=await hanaQuery('SELECT "STACode","EfctivRate" FROM '+db+'."STC1" WHERE "STCCode"=? ORDER BY "Line_ID"',[cleanString(taxCode)]).catch(()=>[]);
    const total=comps.reduce((s,c)=>s+asNumber(c.EfctivRate),0)||1;
    for(const c of comps){
      const kind=gstAccountKind(c.STACode); if(!kind) continue;
      const amt=r2(asNumber(lineVat)*asNumber(c.EfctivRate)/total);
      const acc=await resolveGstAccount(co,dir,kind,c.EfctivRate);
      add(acc?.AcctCode||(dir+' '+kind),acc?.AcctName||(dir+' '+kind+' @ '+Number(c.EfctivRate)+'%'),amt,taxSide);
    }
  }
  for(const l of lineRows){ add(l.AcctCode,await acctName(l.AcctCode),l.LineTotal,expenseSide); }
  for(const l of lineRows){ await addTax(l.TaxCode,l.LineVat); }
  for(const e of expRows){
    let acct,name;
    if(cleanString(e.Stock)==='Y'){  // stock freight clears through Expense Clearing
      const ec=await hanaQuery('SELECT TOP 1 "AcctCode","AcctName" FROM '+db+'."OACT" WHERE UPPER("AcctName") LIKE \'%EXPENSE CLEARING%\' ORDER BY "AcctCode"');
      acct=ec[0]?.AcctCode; name=ec[0]?.AcctName;
    }else{
      const od=await hanaQuery('SELECT TOP 1 "ExpnsAcct" FROM '+db+'."OEXD" WHERE "ExpnsCode"=?',[asNumber(e.ExpnsCode)]);
      acct=cleanString(od[0]?.ExpnsAcct); name=await acctName(acct);
    }
    add(acct,name,e.LineTotal,expenseSide);
    await addTax(e.TaxCode,e.LineVat);
  }
  add(ctlAcct||cleanString(h.CardCode),cleanString(h.CardName),h.DocTotal,bpSide);
  const dr=lines.reduce((s,x)=>s+x.debit,0), cr=lines.reduce((s,x)=>s+x.credit,0);
  const diff=r2(cr-dr);
  if(Math.abs(diff)>=0.0001){
    const ra=await hanaQuery('SELECT TOP 1 "LinkAct_24" FROM '+db+'."OACP" ORDER BY "AbsEntry"').catch(()=>[]);
    let se=null;
    const raCode=cleanString(ra[0]?.LinkAct_24);
    if(raCode){ const r=await hanaQuery('SELECT TOP 1 "AcctCode","AcctName" FROM '+db+'."OACT" WHERE "AcctCode"=?',[raCode]); se=r[0]; }
    if(!se){ const r=await hanaQuery('SELECT TOP 1 "AcctCode","AcctName" FROM '+db+'."OACT" WHERE UPPER("AcctName") LIKE \'%SHORT%EXCESS%\' AND UPPER("AcctName") NOT LIKE \'%STOCK%\' ORDER BY "AcctCode"'); se=r[0]; }
    add(se?.AcctCode||'Rounding',se?.AcctName||'Rounding / Short & Excess',Math.abs(diff),diff>0?'D':'C');
  }
  if(!lines.length) return null;
  lines.forEach((l,i)=>l.line_id=i+1);
  return {
    trans_id:'Draft', number:'Preview',
    ref_date:dateOnly(firstValue(h,['DocDate'])),
    due_date:dateOnly(firstValue(h,['DocDueDate'])),
    tax_date:dateOnly(firstValue(h,['TaxDate'])),
    memo:cleanString(h.JrnlMemo)||'Reconstructed journal preview — SAP posts the final entry on approval',
    base_ref:cleanString(h.NumAtCard),
    trans_type:objType,
    total_debit:r2(lines.reduce((s,x)=>s+x.debit,0)),
    total_credit:r2(lines.reduce((s,x)=>s+x.credit,0)),
    lines,
  };
}

// List documents
router.get('/documents/:type', verifyToken, async(req,res)=>{
  const co=cq(req);
  const type=req.params.type;
  const cfg=DOC_TYPES[type];
  if(!cfg)return res.status(400).json({success:false,message:'Unknown document type: '+type});
  const top=Number(req.query.top)||20;
  const skip=Number(req.query.skip)||0;
  const {q:search,bp,dateFrom,dateTo,status:docStatus}=req.query;
  const isJE=type==='JournalEntries';
  try{
    const filters=[];
    if(search){
      if(isJE)filters.push(`Number eq ${parseInt(search)||0}`);
      else filters.push(`DocNum eq ${parseInt(search)||0}`);
    }
    if(bp&&!isJE){
      const safeBp=bp.replace(/'/g,"''");
      filters.push(`contains(CardName,'${safeBp}')`);
    }
    if(dateFrom&&!isJE)filters.push(`DocDate ge '${dateFrom}'`);
    if(dateTo&&!isJE)filters.push(`DocDate le '${dateTo}'`);
    if(dateFrom&&isJE)filters.push(`ReferenceDate ge '${dateFrom}'`);
    if(dateTo&&isJE)filters.push(`ReferenceDate le '${dateTo}'`);
    if(docStatus&&!isJE){
      const stMap={'O':'bost_Open','C':'bost_Close','L':'bost_Cancel'};
      if(stMap[docStatus])filters.push(`DocumentStatus eq '${stMap[docStatus]}'`);
    }
    const filterStr=filters.length?`&$filter=${encodeURIComponent(filters.join(' and '))}`:'';
    const orderBy=isJE?'JdtNum desc':'DocEntry desc';
    const result=await getSap().sapRequest('GET',`${type}?$select=${cfg.select}&$orderby=${orderBy}&$top=${top}&$skip=${skip}${filterStr}`,null,co);
    res.json({success:true,data:result?.value||[],label:cfg.label});
  }catch(e){res.json({success:true,data:[],warning:e.message});}
});

// Single document detail
router.get('/documents/:type/:id', verifyToken, async(req,res)=>{
  const co=cq(req);
  const type=req.params.type;
  const id=req.params.id;
  const cfg=DOC_TYPES[type];
  if(!cfg)return res.status(400).json({success:false,message:'Unknown document type'});
  try{
    const key=type==='JournalEntries'?id:`${id}`;
    const result=await getSap().sapRequest('GET',`${type}(${key})`,null,co);
    await enrichDocumentLineFields(co,type,result);
    await enrichDocumentGlNames(result,co);
    await enrichDocumentTds(co,type,result);
    await enrichDocumentBranchName(co,result);
    await enrichWarehouseNames(co,result);
    await enrichLocationNames(co,result);
    await enrichDimensionNames(co,result);
    try{ result.LinkedJournalEntry=await fetchJournalEntryForDocument(co,result,journalTransTypeForDocument(type,result)); }
    catch(e){ console.warn('[SAP-DOC] Journal entry load skipped:',e.message); }
    // A pending draft has no posted OJDT yet — reconstruct SAP's journal from the draft itself.
    if(!result.LinkedJournalEntry && type==='Drafts'){
      try{ result.LinkedJournalEntry=await buildDraftJournalEntryFromHana(co,result?.DocEntry); }
      catch(e){ console.warn('[SAP-DOC] Draft journal reconstruction skipped:',e.message); }
    }
    const inTransitType=inTransitTransTypeForDocument(type,result);
    if(inTransitType){
      try{ result.LinkedInTransitEntry=await fetchJournalEntryByReference(co,journalReferenceCandidates(result),inTransitType); }
      catch(e){ console.warn('[SAP-DOC] In-transit entry load skipped:',e.message); }
    }
    res.json({success:true,data:result});
  }catch(e){res.status(404).json({success:false,message:e.message});}
});

// ════════════════════════════════════════════════════════════════
//  OUTGOING PAYMENT DRAFT (OPDF) — full detail like SAP B1
//  Pending outgoing-payment approvals are held as drafts (OPDF), which
//  the Service Layer does not expose as a payment, so we assemble the
//  complete document straight from HANA: header + G/L accounts (PDF4)
//  + applied invoices (PDF2) + checks (PDF1) + withholding/TDS (PDF6).
// ════════════════════════════════════════════════════════════════
const PAYMENT_INV_TABLE={'13':'OINV','14':'ORIN','18':'OPCH','19':'ORPC','24':'ORCT','46':'OVPM'};
const PAYMENT_DRAFT_STATUS={'N':'Open','Y':'Closed','C':'Cancelled','W':'Pending Approval','D':'Draft'};

async function resolvePaymentInvoiceNumbers(co, invLines){
  const byType={};
  invLines.forEach(l=>{
    const t=cleanString(l.InvType);const e=asNumber(l.DocEntry);
    if(!t||!e)return;
    (byType[t]=byType[t]||new Set()).add(e);
  });
  const map={};
  for(const [type,set] of Object.entries(byType)){
    const table=PAYMENT_INV_TABLE[type];
    if(!table)continue;
    const ids=[...set];
    try{
      const rows=await hanaQuery(
        'SELECT "DocEntry","DocNum","DocDate","DocTotal" FROM '+DB(co)+'."'+table+'" WHERE "DocEntry" IN ('+ids.join(',')+')'
      );
      rows.forEach(r=>{map[type+'-'+asNumber(firstValue(r,['DocEntry','DOCENTRY']))]={
        docNum:asNumber(firstValue(r,['DocNum','DOCNUM'])),
        docDate:dateOnly(firstValue(r,['DocDate','DOCDATE'])),
        docTotal:asNumber(firstValue(r,['DocTotal','DOCTOTAL'])),
      };});
    }catch(e){console.warn('[SAP-PDRAFT] invoice number lookup skipped ('+table+'):',e.message);}
  }
  return map;
}

async function fetchPaymentDraft(co, entry){
  const id=parseInt(entry,10);
  if(!Number.isFinite(id)||id<=0) return null;
  const db=DB(co);
  const headerRows=await hanaQuery(
    'SELECT "DocEntry","DocNum","DocType","DocDate","DocDueDate","TaxDate","CardCode","CardName","Address","DocCurr","CashAcct","CashSum","CheckAcct","CheckSum","CreditSum","TrsfrAcct","TrsfrSum","TrsfrDate","TrsfrRef","CounterRef","NoDocSum","DocTotal","Ref1","Ref2","Comments","JrnlMemo","WtSum","WtAccount","VatSum","BPLId","BPLName","PrjCode","PayToCode","Series","Status","WddStatus","Submitted","confirmed","Attachment","TransId","U_Pymnt_Mode" FROM '+db+'."OPDF" WHERE "DocEntry" = ?',
    [id]
  );
  if(!headerRows.length) return null;
  const h=headerRows[0];
  const gv=(k)=>firstValue(h,[k,k.toUpperCase()]);

  const acctRows=await hanaQuery(
    'SELECT "LineId","AcctCode","AcctName","Descrip","SumApplied","GrossAmnt","VatGroup","VatPrcnt","OcrCode","OcrCode2","OcrCode3","OcrCode4","OcrCode5","Section","Project","U_Remarks" FROM '+db+'."PDF4" WHERE "DocNum" = ? ORDER BY "LineId" ASC',
    [id]
  );
  const invRows=await hanaQuery(
    'SELECT "InvoiceId","DocEntry","InvType","SumApplied","AppliedFC","PaidSum","Dcount","DcntSum","InstId","OcrCode" FROM '+db+'."PDF2" WHERE "DocNum" = ? ORDER BY "InvoiceId" ASC',
    [id]
  );
  const checkRows=await hanaQuery(
    'SELECT "LineID","CheckNum","BankCode","Branch","AcctNum","DueDate","CheckSum","Details" FROM '+db+'."PDF1" WHERE "DocNum" = ? ORDER BY "LineID" ASC',
    [id]
  ).catch(()=>[]);
  const wtRows=await hanaQuery(
    'SELECT X."WTCode", X."Rate", X."TaxbleAmnt", X."WTSum", X."TdsAmnt", W."WTName" FROM '+db+'."PDF6" X LEFT JOIN '+db+'."OWHT" W ON W."WTCode"=X."WTCode" WHERE X."DocNum" = ? ORDER BY X."Line" ASC',
    [id]
  ).catch(()=>[]);

  const invNumMap=await resolvePaymentInvoiceNumbers(co, invRows);
  const currency=cleanString(gv('DocCurr'))||'INR';

  const PaymentAccounts=acctRows.map(r=>({
    AccountCode:cleanString(firstValue(r,['AcctCode','ACCTCODE'])),
    AccountName:cleanString(firstValue(r,['AcctName','ACCTNAME'])),
    Description:cleanString(firstValue(r,['Descrip','DESCRIP']))||cleanString(firstValue(r,['U_Remarks','U_REMARKS'])),
    SumPaid:asNumber(firstValue(r,['SumApplied','SUMAPPLIED'])),
    GrossAmount:asNumber(firstValue(r,['GrossAmnt','GROSSAMNT'])),
    TaxCode:cleanString(firstValue(r,['VatGroup','VATGROUP'])),
    ProfitCenter:cleanString(firstValue(r,['OcrCode','OCRCODE'])),
    ProfitCenter2:cleanString(firstValue(r,['OcrCode2','OCRCODE2'])),
    ProfitCenter3:cleanString(firstValue(r,['OcrCode3','OCRCODE3'])),
    ProfitCenter4:cleanString(firstValue(r,['OcrCode4','OCRCODE4'])),
    ProfitCenter5:cleanString(firstValue(r,['OcrCode5','OCRCODE5'])),
    Section:cleanString(firstValue(r,['Section','SECTION'])),
  }));
  const PaymentInvoices=invRows.map(r=>{
    const type=cleanString(firstValue(r,['InvType','INVTYPE']));
    const docEntry=asNumber(firstValue(r,['DocEntry','DOCENTRY']));
    const resolved=invNumMap[type+'-'+docEntry]||{};
    return {
      DocEntry:docEntry,
      DocNum:resolved.docNum||docEntry,
      DocDate:resolved.docDate||null,
      InvoiceType:OBJ_TYPE_MAP[type]||('Type '+type),
      SumApplied:asNumber(firstValue(r,['SumApplied','SUMAPPLIED'])),
      AppliedSum:asNumber(firstValue(r,['SumApplied','SUMAPPLIED'])),
      DiscountPercent:asNumber(firstValue(r,['Dcount','DCOUNT'])),
      TotalDiscount:asNumber(firstValue(r,['DcntSum','DCNTSUM'])),
      DocTotal:resolved.docTotal||null,
    };
  });
  const PaymentChecks=checkRows.map(r=>({
    CheckNumber:cleanString(firstValue(r,['CheckNum','CHECKNUM'])),
    BankCode:cleanString(firstValue(r,['BankCode','BANKCODE'])),
    BankName:cleanString(firstValue(r,['BankCode','BANKCODE'])),
    DueDate:dateOnly(firstValue(r,['DueDate','DUEDATE'])),
    CheckSum:asNumber(firstValue(r,['CheckSum','CHECKSUM'])),
  }));
  const wtAmount=wtRows.reduce((s,r)=>s+Number(asNumber(firstValue(r,['WTSum','WTSUM']))||0),0)||asNumber(gv('WtSum'));
  const wtRate=wtRows.length?asNumber(firstValue(wtRows[0],['Rate','RATE'])):null;
  const TDSDetails=wtRows.map(r=>{
    const name=cleanString(firstValue(r,['WTName','WTNAME']));
    return {
      code:cleanString(firstValue(r,['WTCode','WTCODE'])),
      name, section:extractTdsSection(name),
      rate:asNumber(firstValue(r,['Rate','RATE'])),
      amount:asNumber(firstValue(r,['WTSum','WTSUM']))||asNumber(firstValue(r,['TdsAmnt','TDSAMNT'])),
      taxable:asNumber(firstValue(r,['TaxbleAmnt','TAXBLEAMNT'])),
    };
  }).filter(d=>d.code||d.amount);
  const TDSSection=[...new Set(TDSDetails.map(d=>d.section).filter(Boolean))].join(', ');

  const doc={
    DocEntry:asNumber(gv('DocEntry')),
    DocNum:asNumber(gv('DocNum')),
    DocDate:dateOnly(gv('DocDate')),
    DocDueDate:dateOnly(gv('DocDueDate')),
    DueDate:dateOnly(gv('DocDueDate')),
    TaxDate:dateOnly(gv('TaxDate')),
    CardCode:cleanString(gv('CardCode')),
    CardName:cleanString(gv('CardName')),
    Address:cleanString(gv('Address')),
    DocCurrency:currency,
    CashSum:asNumber(gv('CashSum')),
    CheckSum:asNumber(gv('CheckSum')),
    CreditSum:asNumber(gv('CreditSum')),
    TransferSum:asNumber(gv('TrsfrSum')),
    TransferAccount:cleanString(gv('TrsfrAcct')),
    TransferReference:cleanString(gv('TrsfrRef')),
    TransferDate:dateOnly(gv('TrsfrDate')),
    CounterReference:cleanString(gv('CounterRef')),
    NoDocSum:asNumber(gv('NoDocSum')),
    DocTotal:asNumber(gv('DocTotal')),
    WTAmount:wtAmount,
    WTRate:wtRate,
    WTaxAmount:wtAmount,
    TDSDetails,
    TDSSection,
    Remarks:cleanString(gv('Comments')),
    JournalRemarks:cleanString(gv('JrnlMemo')),
    BPLID:asNumber(gv('BPLId')),
    BPLName:cleanString(gv('BPLName')),
    ProjectCode:cleanString(gv('PrjCode')),
    PayToCode:cleanString(gv('PayToCode')),
    Series:asNumber(gv('Series')),
    AuthorizationStatus:PAYMENT_DRAFT_STATUS[cleanString(gv('WddStatus'))]||PAYMENT_DRAFT_STATUS[cleanString(gv('Status'))]||cleanString(gv('Status')),
    DocumentStatus:cleanString(gv('Status'))==='Y'?'bost_Close':'bost_Open',
    U_Pymnt_Mode:cleanString(gv('U_Pymnt_Mode')),
    AttachmentEntry:asNumber(gv('Attachment')),
    TransId:asNumber(gv('TransId')),
    PaymentAccounts,
    PaymentInvoices,
    PaymentChecks,
    _sapEndpoint:'PaymentDrafts',
    IsDraft:true,
  };
  // Attach the journal entry: real one if already posted, otherwise a preview
  try{
    if(doc.TransId) doc.LinkedJournalEntry=await fetchJournalEntryByTransId(co, doc.TransId);
    if(!doc.LinkedJournalEntry) doc.LinkedJournalEntry=await buildPaymentDraftJournalEntry(co, doc, {
      transfer:cleanString(gv('TrsfrAcct')), cash:cleanString(gv('CashAcct')),
      check:cleanString(gv('CheckAcct')), wt:cleanString(gv('WtAccount')),
    });
  }catch(e){ console.warn('[SAP-PDRAFT] JE attach skipped:',e.message); }
  return doc;
}

// Fill missing account_name on JE lines from the chart of accounts (OACT)
async function enrichJeAccountNames(co, lines){
  const codes=[...new Set(lines.filter(l=>!l.account_name).map(l=>cleanString(l.account)).filter(Boolean))];
  if(!codes.length) return;
  try{
    const quoted=codes.map(c=>"'"+c.replace(/'/g,"''")+"'").join(',');
    const rows=await hanaQuery('SELECT "AcctCode","AcctName" FROM '+DB(co)+'."OACT" WHERE "AcctCode" IN ('+quoted+')');
    const names=new Map(rows.map(r=>[cleanString(r.AcctCode),cleanString(r.AcctName)]));
    lines.forEach(l=>{ if(!l.account_name&&names.has(cleanString(l.account))) l.account_name=names.get(cleanString(l.account)); });
  }catch(e){ console.warn('[SAP-PDRAFT] JE name enrichment skipped:',e.message); }
}

// Build an outgoing-payment journal preview.
// Identity: Dr (G/L expenses) + Dr (BP control for the remainder) = Cr (bank/cash/cheque) + Cr (TDS withheld)
async function buildPaymentDraftJournalEntry(co, doc, raw){
  const blank={cost_center:'',cost_center_2:'',cost_center_3:'',cost_center_4:'',cost_center_5:''};
  const lines=[];
  let li=1;
  // Debit: direct G/L lines (with cost centers)
  let glTotal=0;
  (doc.PaymentAccounts||[]).forEach(a=>{
    const amt=Number(a.SumPaid||a.GrossAmount||0);
    if(!amt) return;
    glTotal+=amt;
    lines.push({line_id:li++,account:a.AccountCode||'',account_name:a.AccountName||'',short_name:'',debit:amt,credit:0,line_memo:a.Description||'G/L payment',cost_center:a.ProfitCenter||'',cost_center_2:a.ProfitCenter2||'',cost_center_3:a.ProfitCenter3||'',cost_center_4:a.ProfitCenter4||'',cost_center_5:a.ProfitCenter5||''});
  });
  // Credit: payment means (money actually paid out)
  const means=[[raw.transfer,Number(doc.TransferSum||0),'Bank transfer'],[raw.cash,Number(doc.CashSum||0),'Cash'],[raw.check,Number(doc.CheckSum||0),'Cheque'],[raw.credit,Number(doc.CreditSum||0),'Credit card']];
  let bankTotal=0;
  means.forEach(([acct,amt,memo])=>{ if(amt>0){ bankTotal+=amt; lines.push({line_id:li++,account:cleanString(acct)||memo,account_name:'',short_name:'',debit:0,credit:amt,line_memo:memo,...blank}); } });
  // Credit: TDS / withholding tax payable
  const wt=Number(doc.WTAmount||0);
  if(wt>0) lines.push({line_id:li++,account:cleanString(raw.wt)||'TDS Payable',account_name:cleanString(raw.wt)?'':'TDS / Withholding Tax Payable',short_name:'',debit:0,credit:wt,line_memo:'TDS / withholding tax withheld',...blank});
  // Debit: BP control account for whatever is not a direct G/L expense (settled invoices + on-account)
  const bpDebit=Number((bankTotal+wt-glTotal).toFixed(2));
  if(bpDebit>0.005){
    const settled=(doc.PaymentInvoices||[]).length;
    lines.splice(glTotal>0?(doc.PaymentAccounts||[]).filter(a=>Number(a.SumPaid||a.GrossAmount||0)).length:0,0,{
      line_id:0,account:doc.CardCode||'BP',account_name:doc.CardName||'Business Partner / Control',short_name:cleanString(doc.CardCode),
      debit:bpDebit,credit:0,line_memo:settled?('Settlement of '+settled+' document(s)'):'Payment on account',...blank,
    });
    lines.forEach((l,i)=>l.line_id=i+1);
  }

  if(!lines.length) return null;
  await enrichJeAccountNames(co, lines);
  return {
    trans_id:'Draft', number:'Preview',
    ref_date:doc.DocDate, due_date:doc.DocDueDate, tax_date:doc.TaxDate,
    memo:'Outgoing payment journal preview — the final SAP journal entry is generated after approval.',
    base_ref:String(doc.DocNum||''), trans_type:'46',
    total_debit:lines.reduce((s,l)=>s+Number(l.debit||0),0),
    total_credit:lines.reduce((s,l)=>s+Number(l.credit||0),0),
    lines,
  };
}

// Full draft outgoing-payment detail (assembled from HANA OPDF tables)
router.get('/payment-drafts/:entry', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const doc=await fetchPaymentDraft(co, req.params.entry);
    if(!doc) return res.status(404).json({success:false,message:'Payment draft not found'});
    res.json({success:true,data:doc});
  }catch(e){
    console.error('[SAP-PDRAFT]',e.message);
    res.status(500).json({success:false,message:e.message});
  }
});

// Get attachment by entry
router.get('/attachments/:entry', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const result=await getSap().sapRequest('GET',`Attachments2(${parseInt(req.params.entry)})`,null,co);
    res.json({success:true,data:result});
  }catch(e){res.status(404).json({success:false,message:e.message});}
});

// Download attachment file
router.get('/attachments/:entry/download/:lineId', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const companyDB=resolveSapCompany(co);
    const result=await getSap().sapRequest('GET',`Attachments2(${parseInt(req.params.entry)})`,null,companyDB);
    const lines=result?.Attachments2_Lines||[];
    const line=lines.find(l=>l.LineNum===parseInt(req.params.lineId))||lines[parseInt(req.params.lineId)];
    if(!line) return res.status(404).json({success:false,message:'Attachment line not found'});
    const fileName=attachmentFileName(line);
    const file=await fetchFileFromArchive(fileName,companyDB);
    console.log(`[ATTACH-DL] Served ${file.fileName} via file service company=${file.companyId}`);

    res.setHeader('Content-Type',file.contentType);
    res.setHeader('Content-Length',file.data.length);
    res.setHeader('Content-Disposition',`inline; filename="${contentDispositionFilename(file.fileName)}"`);
    res.setHeader('X-File-Service-Company',file.companyId);
    res.send(file.data);
  }catch(e){
    console.error('[ATTACH-DL] Error:',e.message);
    res.status(500).json({success:false,message:e.message});
  }
});

// ════════════════════════════════════════════════════════════════
//  SAP APPROVAL REQUESTS
// ════════════════════════════════════════════════════════════════
const OBJ_TYPE_MAP={'112':'Draft','13':'AR Invoice','14':'AR Credit Memo','18':'AP Invoice','19':'AP Credit Note','22':'Purchase Order','20':'Goods Receipt PO','21':'Goods Return','59':'Goods Issue','60':'Goods Receipt','46':'Outgoing Payment','17':'Order','15':'Delivery','16':'Return','1470000113':'Inventory Transfer'};

function normalizeSapUserId(v){
  const n=parseInt(v,10);
  return Number.isFinite(n)&&n>0?n:null;
}

function splitUserToken(value){
  if (value === null || value === undefined) return [];
  const raw = String(value).trim();
  if (!raw) return [];
  const values = new Set([raw.toLowerCase()]);
  const num = normalizeSapUserId(raw);
  if (num !== null) values.add(String(num));
  return [...values];
}

function parseDraftEntrySet(value){
  if (value === null || value === undefined) return null;
  const values = new Set();
  String(value)
    .split(',')
    .map(v => String(v).trim())
    .filter(Boolean)
    .forEach(v => {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) values.add(n);
    });
  return values.size ? values : null;
}

function buildSapStatusFilter(status){
  if(status==='Pending') return "Status eq 'arsPending'";
  if(status==='Approved') return "Status eq 'arsApproved' or Status eq 'arsGenerated' or Status eq 'arsGeneratedByAuthorizer'";
  if(status==='Rejected') return "Status eq 'arsNotApproved' or Status eq 'arsRejected'";
  if(status==='Generated') return "Status eq 'arsGenerated' or Status eq 'arsGeneratedByAuthorizer'";
  if(status==='Cancelled') return "Status eq 'arsCancelled'";
  return '';
}

function approvalLineUserTokens(line){
  const values = new Set();
  [
    line?.UserID, line?.ApproverUserID, line?.ApproverID, line?.ApproverId,
    line?.ApproverCode, line?.ApproverUserCode, line?.ApproverLoginName, line?.ApproverUserLoginName,
    line?.UserCode, line?.UserName, line?.ApproverUserName, line?.ApproverName, line?.ApproverFullName,
  ].forEach(v => splitUserToken(v).forEach(t => values.add(t)));
  return [...values];
}

function buildSapUserMatchTokens(req, sapUserId){
  const tokens = new Set();
  splitUserToken(sapUserId).forEach(t => tokens.add(t));
  splitUserToken(req?.user?.username).forEach(t => tokens.add(t));
  splitUserToken(req?.user?.name).forEach(t => tokens.add(t));
  return tokens;
}

async function getMappedSapUserId(req){
  const tokenSapUserId=normalizeSapUserId(req.user?.sapUserId);
  if(!req.user?.id) return tokenSapUserId;
  try{
    const userDb=require('../services/hanaUsers');
    const appUser=await userDb.findById(req.user.id);
    if(!appUser) {
      const e=new Error('Application user was not found');
      e.statusCode=403;
      throw e;
    }
    return normalizeSapUserId(appUser.sapUserId);
  }catch(e){
    if(e.statusCode===403) throw e;
    if(tokenSapUserId) return tokenSapUserId;
    e.statusCode=e.statusCode||503;
    throw e;
  }
}

function approvalRequestCode(r){
  return normalizeSapUserId(r?.Code);
}

function approvalLineUserId(line){
  return normalizeSapUserId(line?.UserID??line?.ApproverUserID??line?.ApproverID??line?.ApproverId);
}

function isPendingApprovalStatus(v){
  const s=String(v||'').toLowerCase();
  return !s||s==='ardpending'||s==='arspending'||s==='arpending'||s==='pending';
}

function isRequestPending(r){
  return isPendingApprovalStatus(r?.Status);
}

function sameApprovalStage(line,r){
  const current=r?.CurrentStage??r?.CurrentStageCode??r?.CurrentStageID;
  if(current===null||current===undefined||current==='') return true;
  return [line?.StageCode,line?.StageID,line?.StageId,line?.StepCode,line?.StepID]
    .some(v=>v!==null&&v!==undefined&&String(v)===String(current));
}

function hasApprovalLineForSapUser(r,sapUserId){
  const userTokens = sapUserId instanceof Set ? sapUserId : buildSapUserMatchTokens({}, sapUserId);
  return (r?.ApprovalRequestLines || []).some(line => {
    const lineTokens = approvalLineUserTokens(line);
    return lineTokens.some(token => userTokens.has(token));
  });
}

function canSapUserApproveRequest(r,sapUserId){
  if(!isRequestPending(r)) return false;
  const userTokens = sapUserId instanceof Set ? sapUserId : buildSapUserMatchTokens({}, sapUserId);
  return (r?.ApprovalRequestLines||[]).some(line=>{
    const lineTokens = approvalLineUserTokens(line);
    return lineTokens.some(token => userTokens.has(token)) &&
      isPendingApprovalStatus(line?.Status)&&
      sameApprovalStage(line,r);
  });
}

function isApprovalVisibleToSapUser(r,sapUserId,requestedStatus){
  if(requestedStatus==='Pending'||isRequestPending(r)) return canSapUserApproveRequest(r,sapUserId);
  return hasApprovalLineForSapUser(r,sapUserId);
}

async function fetchApprovalRequestDetail(code,co){
  return getSap().sapRequest('GET',`ApprovalRequests(${parseInt(code,10)})`,null,co);
}

async function withApprovalRequestLines(r,co){
  if(Array.isArray(r?.ApprovalRequestLines)) return r;
  const code=approvalRequestCode(r);
  return code?fetchApprovalRequestDetail(code,co):r;
}

async function fetchApprovalRequestPage(co,filters,top,skip){
  const filterStr=filters.length?`&$filter=${encodeURIComponent(filters.join(' and '))}`:'';
  const result=await getSap().sapRequest('GET',`ApprovalRequests?$orderby=Code desc&$top=${top}&$skip=${skip}${filterStr}`,null,co);
  return result?.value||[];
}

// Resolve the set of draft DocEntry values whose lines contain a given part name
// (item code or description). Approval requests are drafts, so this lets the
// approvals page be filtered by the part inside the pending document.
async function findDraftEntriesByPartName(co, partName){
  const like='%'+String(partName).toUpperCase()+'%';
  try{
    const rows=await hanaQuery(
      'SELECT DISTINCT TOP 1000 "DocEntry" FROM '+DB(co)+'."DRF1" WHERE UPPER("ItemCode") LIKE ? OR UPPER("Dscription") LIKE ?',
      [like,like]
    );
    return new Set(rows.map(r=>Number(firstValue(r,['DocEntry','DOCENTRY']))).filter(n=>Number.isFinite(n)));
  }catch(e){
    console.warn('[SAP-APPROVAL] Part name search skipped:',e.message);
    return new Set();
  }
}

// Resolve the set of draft DocEntry values whose business partner (card code or
// name) matches — lets the approvals page be filtered by the party on the document.
async function findDraftEntriesByPartyName(co, partyName){
  const like='%'+String(partyName).toUpperCase()+'%';
  try{
    const rows=await hanaQuery(
      'SELECT DISTINCT TOP 1000 "DocEntry" FROM '+DB(co)+'."ODRF" WHERE UPPER("CardCode") LIKE ? OR UPPER("CardName") LIKE ?',
      [like,like]
    );
    return new Set(rows.map(r=>Number(firstValue(r,['DocEntry','DOCENTRY']))).filter(n=>Number.isFinite(n)));
  }catch(e){
    console.warn('[SAP-APPROVAL] Party name search skipped:',e.message);
    return new Set();
  }
}

async function listVisibleApprovalRequests(co,filters,top,skip,sapUserTokens,requestedStatus){
  const visible=[];
  const sapPageTop=Math.min(Math.max(Number(process.env.SAP_APPROVAL_PAGE_SIZE)||20,1),100);
  const maxPages=Math.min(Math.max(Number(process.env.SAP_APPROVAL_MAX_PAGES)||300,1),1000);
  let sapSkip=0;
  for(let page=0;page<maxPages&&visible.length<skip+top;page++){
    const rows=await fetchApprovalRequestPage(co,filters,sapPageTop,sapSkip);
    if(!rows.length) break;
    const hydrated=await Promise.all(rows.map(r=>withApprovalRequestLines(r,co).catch(e=>{
      console.warn('[SAP-APPROVAL] Detail load skipped for Code',r?.Code,e.message);
      return r;
    })));
    hydrated.forEach(r=>{
      if(isApprovalVisibleToSapUser(r,sapUserTokens,requestedStatus)) visible.push(r);
    });
    sapSkip+=rows.length;
  }
  return visible.slice(skip,skip+top);
}

router.get('/mapped-user', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const sapUserId=await getMappedSapUserId(req);
    const portalUser={
      id:req.user?.id||null,
      username:req.user?.username||'',
      name:req.user?.name||'',
      role:req.user?.role||'',
    };
    if(!sapUserId){
      return res.json({
        success:true,
        data:{portalUser,sapUser:null},
        message:'No SAP user is linked to your portal account.',
      });
    }

    let sapUser={id:sapUserId,userCode:String(sapUserId),username:String(sapUserId)};
    try{
      const u=await getSap().sapRequest('GET',`Users(${sapUserId})?$select=UserCode,UserName`,null,co);
      sapUser={
        id:sapUserId,
        userCode:u?.UserCode||String(sapUserId),
        username:u?.UserName||u?.UserCode||String(sapUserId),
      };
    }catch(_e){
      const u=await getSap().sapRequest('GET',`Users(${sapUserId})?$select=UserCode`,null,co);
      sapUser={
        id:sapUserId,
        userCode:u?.UserCode||String(sapUserId),
        username:u?.UserCode||String(sapUserId),
      };
    }

    res.json({success:true,data:{portalUser,sapUser}});
  }catch(e){
    res.status(e.statusCode||500).json({success:false,message:e.message});
  }
});

router.get('/approval-requests', verifyToken, async(req,res)=>{
  const co=cq(req);
  const {status,objectType,originatorId,dateFrom,dateTo,bpCode,code}=req.query;
  const partName=cleanString(req.query.partName||req.query.part||req.query.itemName);
  const partyName=cleanString(req.query.partyName||req.query.party||req.query.bpName||req.query.cardName);
  const top=Number(req.query.top)||30;
  const skip=Number(req.query.skip)||0;
  try{
    const sapUserId=await getMappedSapUserId(req);
    if(!sapUserId) return res.status(403).json({success:false,message:'No SAP user is linked to your portal account. Ask an admin to set SAP User ID for this user.'});
    const sapUserTokens = buildSapUserMatchTokens(req, sapUserId);
    const filters=[];
    const statusFilter=buildSapStatusFilter(status);
    if(statusFilter) filters.push(statusFilter.includes(' or ')?`(${statusFilter})`:statusFilter);
    let draftKeyFilter = parseDraftEntrySet(req.query.draftKeys || req.query.draftEntries || req.query.draftKey || req.query.draft);
    // Each text search narrows the set of draft entries; combine them (and any
    // explicit draft-key filter) by intersection so all supplied criteria must match.
    const narrowByDraftEntries = async (resolver, term) => {
      const matched = await resolver(co, term);
      draftKeyFilter = (draftKeyFilter && draftKeyFilter.size)
        ? new Set([...draftKeyFilter].filter(v => matched.has(Number(v))))
        : matched;
    };
    if (partName)  await narrowByDraftEntries(findDraftEntriesByPartName, partName);
    if (partyName) await narrowByDraftEntries(findDraftEntriesByPartyName, partyName);
    if ((partName || partyName) && (!draftKeyFilter || !draftKeyFilter.size)) {
      return res.json({success:true,data:[]});
    }
    if (draftKeyFilter && draftKeyFilter.size) {
      const draftConditions = [...draftKeyFilter].map(v => `DraftEntry eq ${Number(v)}`).join(' or ');
      filters.push(`(${draftConditions})`);
    }
    if(objectType)filters.push(`ObjectType eq '${objectType}'`);
    if(originatorId)filters.push(`OriginatorID eq ${parseInt(originatorId)}`);
    if(dateFrom)filters.push(`CreationDate ge '${dateFrom}'`);
    if(dateTo)filters.push(`CreationDate le '${dateTo}'`);
    if(code)filters.push(`Code eq ${parseInt(code)}`);
    const data=await listVisibleApprovalRequests(co,filters,top,skip,sapUserTokens,status);
    res.json({success:true,data});
  }catch(e){
    const code=e.statusCode||500;
    res.status(code).json({success:false,data:[],message:e.message});
  }
});

router.get('/approval-requests/:id', verifyToken, async(req,res)=>{
  const co=cq(req);
  try{
    const sapUserId=await getMappedSapUserId(req);
    if(!sapUserId) return res.status(403).json({success:false,message:'No SAP user is linked to your portal account. Ask an admin to set SAP User ID for this user.'});
    const sapUserTokens = buildSapUserMatchTokens(req, sapUserId);
    const result=await fetchApprovalRequestDetail(req.params.id,co);
    if(!isApprovalVisibleToSapUser(result,sapUserTokens)) {
      return res.status(403).json({success:false,message:'You are not authorized to view this SAP approval request.'});
    }
    res.json({success:true,data:result});
  }catch(e){res.status(e.statusCode||404).json({success:false,message:e.message});}
});

router.patch('/approval-requests/:id', verifyToken, async(req,res)=>{
  const co=cq(req);
  const id=parseInt(req.params.id);
  const body=req.body||{};
  const sapPassword=body.sapPassword;
  delete body.company; delete body.sapPassword;
  // Only send ApprovalRequestDecisions — SAP rejects Status/Lines on PATCH
  const payload={};
  if(body.ApprovalRequestDecisions){
    // SAP infers the approver from the SL session — strip ApproverUserID
    payload.ApprovalRequestDecisions=body.ApprovalRequestDecisions.map(d=>{
      const {ApproverUserID,...rest}=d; return rest;
    });
  }
  if(body.Remarks) payload.Remarks=body.Remarks;
  try{
    const sapUserId=await getMappedSapUserId(req);
    if(!sapUserId) return res.status(403).json({success:false,message:'No SAP user is linked to your portal account. Ask an admin to set SAP User ID for this user.'});
    const sapUserTokens = buildSapUserMatchTokens(req, sapUserId);
    const approvalRequest=await fetchApprovalRequestDetail(id,co);
    if(!canSapUserApproveRequest(approvalRequest,sapUserTokens)) {
      return res.status(403).json({success:false,message:'You are not authorized to approve or reject this SAP approval request.'});
    }
    if(!sapPassword) return res.status(400).json({success:false,message:'SAP password required'});
    console.log('[SAP-APPROVAL] PATCH',id,JSON.stringify(payload),'as sapUserId',sapUserId);
    const u=await getSap().sapRequest('GET',`Users(${parseInt(sapUserId)})?$select=UserCode`,null,co);
    const userCode=u?.UserCode;
    if(!userCode) throw new Error('UserCode not found for sapUserId '+sapUserId);
    const result=await getSap().sapRequestAs(userCode,sapPassword,co,'PATCH',`ApprovalRequests(${id})`,payload);
    res.json({success:true,data:result});
  }catch(e){res.status(400).json({success:false,message:e.message});}
});

// ════════════════════════════════════════════════════════════════
//  REPORTS — List and serve report files from configured path
// ════════════════════════════════════════════════════════════════
const REPORT_PATH=process.env.REPORT_PATH||process.env.SAP_ATTACHMENT_PATH||'';

// Run report queries
router.get('/reports/run/:id', verifyToken, async(req,res)=>{
  const co=cq(req);
  const id=req.params.id;
  const {ItemCode,Warehouse,DateFrom,DateTo}=req.query;
  try{
    if(id==='inv-audit'){
      const db=DB(co);
      const safeFrom=DateFrom||new Date().toISOString().slice(0,10);
      const safeTo=DateTo||new Date().toISOString().slice(0,10);
      const itemFilter=ItemCode?` AND A."ItemCode" LIKE '%${(ItemCode||'').replace(/'/g,"''")}%'`:'';
      const whsFilter=Warehouse?` AND A."Warehouse" = '${(Warehouse||'').replace(/'/g,"''")}'`:'';
      const itemFilterOB=ItemCode?` AND T."ItemCode" LIKE '%${(ItemCode||'').replace(/'/g,"''")}%'`:'';
      const whsFilterOB=Warehouse?` AND "Warehouse" = '${(Warehouse||'').replace(/'/g,"''")}'`:'';

      console.log('[REPORT] inv-audit from='+safeFrom+' to='+safeTo);

      // 1. Opening Balance (before DateFrom)
      const obSql=`
        SELECT U."U_Unit" AS "Unit", U."U_Sub_Group" AS "Sub Group", U."U_SKU" AS "SKU",
          T."ItemCode", U."ItemName", T."Warehouse" AS "Godown", U."SalPackMsr" AS "UOM",
          '${safeFrom}' AS "DocDate", 0 AS "DocTime", 'OB' AS "DocNum",
          CAST(SUM(T."InQty"-T."OutQty") AS DECIMAL(19,2)) AS "Quantity",
          CASE WHEN U."U_IsLitre"='Y' THEN CAST(SUM((T."InQty"-T."OutQty")*U."SalPackUn") AS DECIMAL(19,2)) ELSE 0 END AS "Oil Liter"
        FROM ${db}."OINM" T
        INNER JOIN ${db}."OITM" U ON U."ItemCode"=T."ItemCode"
        WHERE T."DocDate" < '${safeFrom}' ${itemFilterOB} ${whsFilterOB}
        GROUP BY U."U_Unit", U."U_Sub_Group", U."U_SKU", T."ItemCode", U."ItemName", T."Warehouse", U."SalPackMsr", U."U_IsLitre", U."SalPackUn"
        HAVING SUM(T."InQty"-T."OutQty") != 0`;

      // 2. Transactions in date range
      const txSql=`
        SELECT B."U_Unit" AS "Unit", B."U_Sub_Group" AS "Sub Group", B."U_SKU" AS "SKU",
          A."ItemCode", B."ItemName", A."Warehouse" AS "Godown", B."SalPackMsr" AS "UOM",
          CAST(A."DocDate" AS DATE) AS "DocDate", A."DocTime" AS "DocTime",
          CASE
            WHEN A."TransType"=67 THEN 'IM' WHEN A."TransType"=20 THEN 'PD'
            WHEN A."TransType"=59 THEN 'SI' WHEN A."TransType"=16 THEN 'RE'
            WHEN A."TransType"=15 THEN 'DL' WHEN A."TransType"=13 THEN 'IN'
            WHEN A."TransType"=10000071 THEN 'ST' WHEN A."TransType"=14 THEN 'CN'
            WHEN A."TransType"=18 THEN 'PU' WHEN A."TransType"=21 THEN 'PR'
            WHEN A."TransType"=19 THEN 'PT' WHEN A."TransType"=60 THEN 'SO'
            ELSE 'OT'
          END || '-' || CAST(A."BASE_REF" AS NVARCHAR(50)) AS "DocNum",
          CAST(SUM(A."InQty"-A."OutQty") AS DECIMAL(19,2)) AS "Quantity",
          CASE WHEN B."U_IsLitre"='Y' THEN CAST(SUM((A."InQty"-A."OutQty")*B."SalPackUn") AS DECIMAL(19,2)) ELSE 0 END AS "Oil Liter"
        FROM ${db}."OINM" A
        INNER JOIN ${db}."OITM" B ON A."ItemCode"=B."ItemCode"
        WHERE A."DocDate" BETWEEN '${safeFrom}' AND '${safeTo}' ${itemFilter} ${whsFilter}
        GROUP BY B."U_Unit", B."U_Sub_Group", B."U_SKU", A."ItemCode", B."ItemName",
          A."Warehouse", B."U_IsLitre", B."SalPackMsr", B."SalPackUn", A."TransType", A."BASE_REF", A."DocDate", A."DocTime"
        HAVING SUM(A."InQty"-A."OutQty") != 0`;

      const obRows=await hanaQuery(obSql);
      const txRows=await hanaQuery(txSql);
      const allRows=[...obRows,...txRows];

      // Sort: by DocDate, Godown, ItemCode
      allRows.sort((a,b)=>{
        const d1=String(a.DocDate||''),d2=String(b.DocDate||'');
        if(d1<d2)return -1;if(d1>d2)return 1;
        const g1=a.Godown||'',g2=b.Godown||'';
        if(g1<g2)return -1;if(g1>g2)return 1;
        return(a.ItemCode||'').localeCompare(b.ItemCode||'');
      });

      const columns=['Godown','Unit','Sub Group','SKU','ItemCode','ItemName','UOM','DocDate','DocTime','DocNum','Quantity','Oil Liter'];
      allRows.forEach(r=>{
        if(r.DocDate&&r.DocNum!=='OB')r.DocDate=new Date(r.DocDate).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'});
        else if(r.DocNum==='OB')r.DocDate='';
        r.Quantity=Number(r.Quantity||0).toFixed(2);
        r['Oil Liter']=Number(r['Oil Liter']||0).toFixed(2);
      });
      res.json({success:true,data:{rows:allRows,columns}});
    }else{
      res.status(400).json({success:false,message:'Unknown report: '+id});
    }
  }catch(e){
    console.error('[REPORT] Error:',e.message);
    res.status(500).json({success:false,message:e.message});
  }
});

router.get('/reports/list', verifyToken, async(req,res)=>{
  const fs=require('fs');
  const pathMod=require('path');
  const reportDir=req.query.path||REPORT_PATH;
  if(!reportDir)return res.json({success:true,data:[],warning:'REPORT_PATH not configured'});
  try{
    // Mount share if UNC
    if(reportDir.startsWith('\\\\')){
      const parts=reportDir.replace(/\\/g,'/').split('/').filter(Boolean);
      const shareRoot=`\\\\${parts[0]}\\${parts[1]}`;
      try{require('child_process').execSync(`net use "${shareRoot}" /persistent:no`,{stdio:'pipe',timeout:5000});}catch(_e){}
    }
    const files=fs.readdirSync(reportDir).filter(f=>{
      const ext=f.split('.').pop().toLowerCase();
      return['rpt','pdf','xlsx','xls','docx','doc','csv'].includes(ext);
    }).map(f=>{
      const stat=fs.statSync(pathMod.join(reportDir,f));
      return{name:f,size:stat.size,modified:stat.mtime?.toISOString(),ext:f.split('.').pop().toLowerCase()};
    });
    res.json({success:true,data:files});
  }catch(e){res.json({success:true,data:[],warning:e.message});}
});

router.get('/reports/download/:filename', verifyToken, async(req,res)=>{
  const fs=require('fs');
  const pathMod=require('path');
  const reportDir=req.query.path||REPORT_PATH;
  const filename=req.params.filename;
  if(!reportDir)return res.status(400).json({success:false,message:'REPORT_PATH not configured'});
  const filePath=pathMod.join(reportDir,filename);
  try{
    if(!fs.existsSync(filePath))return res.status(404).json({success:false,message:'File not found: '+filename});
    const ext=filename.split('.').pop().toLowerCase();
    const mimeMap={pdf:'application/pdf',rpt:'application/octet-stream',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',doc:'application/msword',csv:'text/csv',txt:'text/plain'};
    res.setHeader('Content-Type',mimeMap[ext]||'application/octet-stream');
    res.setHeader('Content-Disposition',ext==='pdf'?`inline; filename="${filename}"`:`attachment; filename="${filename}"`);
    fs.createReadStream(filePath).pipe(res);
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

router.buildSapStatusFilter = buildSapStatusFilter;
router.isApprovalVisibleToSapUser = isApprovalVisibleToSapUser;
router.buildDraftJournalEntryFromHana = buildDraftJournalEntryFromHana;

module.exports = router;
