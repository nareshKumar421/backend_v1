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

async function hanaQuery(sql){
  console.log('[HANA]',sql.slice(0,120).replace(/\s+/g,' '));
  const conn=await getHanaConn();
  return new Promise((resolve,reject)=>{
    conn.exec(sql,(err,rows)=>{
      if(err){
        try{conn.disconnect();}catch(_){}
        _hanaConn=null;
        return reject(err);
      }
      console.log(`[HANA] ✅ ${(rows||[]).length} rows`);
      resolve(rows||[]);
    });
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
};

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
    res.json({success:true,data:result});
  }catch(e){res.status(404).json({success:false,message:e.message});}
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
const OBJ_TYPE_MAP={'112':'Draft','13':'AR Invoice','14':'AR Credit Memo','18':'AP Invoice','19':'AP Credit Note','22':'Purchase Order','20':'Goods Receipt PO','21':'Goods Return','59':'Goods Issue','60':'Goods Receipt','46':'Blanket Agreement','17':'Order','15':'Delivery','16':'Return','1470000113':'Inventory Transfer'};

function normalizeSapUserId(v){
  const n=parseInt(v,10);
  return Number.isFinite(n)&&n>0?n:null;
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
  return !s||s==='ardpending'||s==='arspending'||s==='pending';
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
  return (r?.ApprovalRequestLines||[]).some(line=>approvalLineUserId(line)===sapUserId);
}

function canSapUserApproveRequest(r,sapUserId){
  if(!isRequestPending(r)) return false;
  return (r?.ApprovalRequestLines||[]).some(line=>
    approvalLineUserId(line)===sapUserId&&
    isPendingApprovalStatus(line?.Status)&&
    sameApprovalStage(line,r)
  );
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

async function listVisibleApprovalRequests(co,filters,top,skip,sapUserId,requestedStatus){
  const visible=[];
  const pageTop=Math.max(50,top);
  let sapSkip=0;
  for(let page=0;page<40&&visible.length<skip+top;page++){
    const rows=await fetchApprovalRequestPage(co,filters,pageTop,sapSkip);
    if(!rows.length) break;
    const hydrated=await Promise.all(rows.map(r=>withApprovalRequestLines(r,co).catch(e=>{
      console.warn('[SAP-APPROVAL] Detail load skipped for Code',r?.Code,e.message);
      return r;
    })));
    hydrated.forEach(r=>{
      if(isApprovalVisibleToSapUser(r,sapUserId,requestedStatus)) visible.push(r);
    });
    sapSkip+=rows.length;
    if(rows.length<pageTop) break;
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
  const top=Number(req.query.top)||30;
  const skip=Number(req.query.skip)||0;
  try{
    const sapUserId=await getMappedSapUserId(req);
    if(!sapUserId) return res.status(403).json({success:false,message:'No SAP user is linked to your portal account. Ask an admin to set SAP User ID for this user.'});
    const filters=[];
    if(status==='Pending')filters.push(`Status eq 'arsPending'`);
    else if(status==='Approved')filters.push(`Status eq 'arsApproved'`);
    else if(status==='Rejected')filters.push(`Status eq 'arsNotApproved'`);
    else if(status==='Generated')filters.push(`Status eq 'arsGenerated'`);
    else if(status==='Cancelled')filters.push(`Status eq 'arsCancelled'`);
    if(objectType)filters.push(`ObjectType eq '${objectType}'`);
    if(originatorId)filters.push(`OriginatorID eq ${parseInt(originatorId)}`);
    if(dateFrom)filters.push(`CreationDate ge '${dateFrom}'`);
    if(dateTo)filters.push(`CreationDate le '${dateTo}'`);
    if(code)filters.push(`Code eq ${parseInt(code)}`);
    const data=await listVisibleApprovalRequests(co,filters,top,skip,sapUserId,status);
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
    const result=await fetchApprovalRequestDetail(req.params.id,co);
    if(!isApprovalVisibleToSapUser(result,sapUserId)) {
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
    const approvalRequest=await fetchApprovalRequestDetail(id,co);
    if(!canSapUserApproveRequest(approvalRequest,sapUserId)) {
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

module.exports = router;
