const express = require('express');
const AuditLog = require('../../db/models/AuditLog');

const router = express.Router();

const PAGE_SIZE = 50;

router.get('/', async (req, res) => {
  const { from, to, decision, actor } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);

  const query = {};
  if (decision) query.decision = decision;
  if (from || to) {
    query.at = {};
    if (from) query.at.$gte = new Date(from);
    if (to) query.at.$lte = new Date(to);
  }
  if (actor) {
    const needle = new RegExp(String(actor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ actorName: needle }, { actorPhone: needle }, { actorWaId: needle }];
  }

  const [entries, total, counts] = await Promise.all([
    AuditLog.find(query)
      .sort({ at: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean(),
    AuditLog.countDocuments(query),
    AuditLog.aggregate([
      { $match: query },
      { $group: { _id: '$decision', count: { $sum: 1 } } },
    ]),
  ]);

  res.json({
    ok: true,
    entries,
    total,
    page,
    pageSize: PAGE_SIZE,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: Object.fromEntries(counts.map((c) => [c._id, c.count])),
  });
});

module.exports = router;
