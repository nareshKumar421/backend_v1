const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { sapRequest } = require('../services/sapServiceLayer');
const { verifyToken } = require('../middleware/auth');
const { resolve: resolveCompany } = require('../services/companyConfig');

// ─── TreeType enum ─────────────────────────────────────────
const TREE_TYPE_MAP = {
  production: 'iProductionTree',
  sales: 'iSalesTree',
  assembly: 'iAssemblyTree',
  template: 'iTemplateTree',
  disassembly: 'iDisassemblyTree',
};

// ─── IssueMethod map ───────────────────────────────────────
const ISSUE_METHOD_MAP = {
  Manual: 'im_Manual',
  Backflush: 'im_Backflush',

  // backward compatibility
  Stock: 'im_Backflush',
  'Non-Stock': 'im_Manual',
  Phantom: 'im_Manual',
  Fixed: 'im_Backflush',
};

// ──────────────────────────────────────────────────────────
// CREATE BOM
// ──────────────────────────────────────────────────────────
router.post(
  '/create',
  verifyToken,
  [
    body('itemCode').notEmpty(),
    body('itemName').notEmpty(),
    body('qty').isFloat({ gt: 0 }),
    body('components').isArray({ min: 1 }),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) {
      return res.status(400).json({ success: false, errors: errs.array() });
    }

    try {
      const b = req.body;
      const companyDB = resolveCompany(b.company);
      const treeCode = b.itemCode.trim().toUpperCase();

      const productTreeLines = (b.components || []).map((c) => {
        const issueRaw = c.issueMethod || c.compType || 'Manual';

        const line = {
          ItemCode: c.itemCode?.trim().toUpperCase(),
          Quantity: Number(c.qty) || 1,
          IssueMethod: ISSUE_METHOD_MAP[issueRaw] || 'im_Manual',
        };

        if (c.warehouse?.trim()) {
          line.Warehouse = c.warehouse.trim();
        } else if (b.warehouse?.trim()) {
          line.Warehouse = b.warehouse.trim();
        }

        if (Number(c.unitCost) > 0) {
          line.Price = Number(c.unitCost);
          line.Currency = 'INR';
        }

        if (c.note?.trim()) {
          line.Comment = c.note.trim().slice(0, 100);
        }

        return line;
      });

      const payload = {
        TreeCode: treeCode,
        TreeType:
          TREE_TYPE_MAP[(b.bomType || 'production').toLowerCase()] ||
          'iProductionTree',
        Quantity: Number(b.qty) || 1,
        ProductDescription: b.itemName.trim().toUpperCase().slice(0, 100),
        ProductTreeLines: productTreeLines,
      };

      if (b.warehouse?.trim()) payload.Warehouse = b.warehouse.trim();
      if (b.distrRule?.trim()) payload.DistributionRule = b.distrRule.trim();
      if (b.project?.trim()) payload.Project = b.project.trim();

      if (b.drawingNo) payload.U_DrawingNo = b.drawingNo.slice(0, 50);
      if (b.revision) payload.U_Revision = b.revision.slice(0, 20);
      if (b.remarks) payload.Remark = b.remarks.slice(0, 254);

      console.log('[BOM CREATE]', JSON.stringify(payload, null, 2));

      const result = await sapRequest('POST', 'ProductTrees', payload, companyDB);

      res.json({
        success: true,
        message: 'BOM created successfully',
        treeCode: result?.TreeCode || treeCode,
      });
    } catch (err) {
      console.error('[BOM ERROR]', err.message);

      let msg = err.message;

      if (msg.includes('-1035')) msg = 'BOM already exists';
      else if (msg.includes('-1020')) msg = 'Item not found';
      else if (msg.includes('-1034')) msg = 'Invalid warehouse';
      else if (msg.includes('IssueMethod')) msg = 'Invalid issue method';

      res.status(500).json({ success: false, message: msg });
    }
  }
);

// ──────────────────────────────────────────────────────────
// LIST BOM
// ──────────────────────────────────────────────────────────
router.get('/list', verifyToken, async (req, res) => {
  try {
    const top = Number(req.query.top) || 50;
    const skip = Number(req.query.skip) || 0;
    const companyDB = resolveCompany(req.query.company);

    const result = await sapRequest(
      'GET',
      `ProductTrees?$select=TreeCode,TreeType,Quantity,Warehouse,ProductDescription&$top=${top}&$skip=${skip}`,
      null, companyDB
    );

    res.json({
      success: true,
      data: result.value || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// GET SINGLE
// ──────────────────────────────────────────────────────────
router.get('/:treeCode', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.query.company);
  try {
    const code = encodeURIComponent(req.params.treeCode);
    const result = await sapRequest('GET', `ProductTrees('${code}')`, null, companyDB);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// UPDATE BOM
// ──────────────────────────────────────────────────────────
router.patch('/:treeCode', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.body.company);
  try {
    const code = req.params.treeCode.trim();
    const b = req.body;

    const patch = {};

    if (b.qty != null) patch.Quantity = Number(b.qty);
    if (b.warehouse) patch.Warehouse = b.warehouse;
    if (b.itemName)
      patch.ProductDescription = b.itemName.toUpperCase().slice(0, 100);

    if (b.bomType) {
      const type = TREE_TYPE_MAP[b.bomType.toLowerCase()];
      if (type) patch.TreeType = type;
    }

    if (b.components?.length) {
      patch.ProductTreeLines = b.components.map((c) => ({
        ItemCode: c.itemCode.toUpperCase(),
        Quantity: Number(c.qty) || 1,
        IssueMethod: ISSUE_METHOD_MAP[c.issueMethod] || 'im_Manual',
      }));
    }

    await sapRequest(
      'PATCH',
      `ProductTrees('${encodeURIComponent(code)}')`,
      patch, companyDB
    );

    res.json({ success: true, message: 'BOM updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// DELETE BOM
// ──────────────────────────────────────────────────────────
router.delete('/:treeCode', verifyToken, async (req, res) => {
  const companyDB = resolveCompany(req.query.company);
  try {
    const code = req.params.treeCode.trim();
    await sapRequest(
      'DELETE',
      `ProductTrees('${encodeURIComponent(code)}')`,
      null, companyDB
    );
    res.json({ success: true, message: 'BOM deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;