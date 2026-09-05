const express = require('express');
const { bridgeCoordinator } = require('../../bridge/runtime');

function createBridgeRouter(coordinator = bridgeCoordinator) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!coordinator.enabled) {
      return res.status(404).json({ ok: false, error: 'bridge_disabled' });
    }
    if (!coordinator.authenticate(req.get('authorization'))) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return next();
  });

  router.post('/poll', async (req, res) => {
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.once('close', onClose);
    try {
      const job = await coordinator.poll({
        agentId: req.body?.agentId,
        status: req.body?.status,
        signal: controller.signal,
      });
      res.off('close', onClose);
      if (res.destroyed || res.writableEnded) return;
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, job });
    } catch (err) {
      res.off('close', onClose);
      if (res.destroyed || res.writableEnded) return;
      const status = err.bridgeCode === 'unknown_agent' ? 403 : 400;
      return res.status(status).json({ ok: false, error: err.bridgeCode || 'invalid_request' });
    }
  });

  router.post('/jobs/:jobId/result', (req, res) => {
    try {
      const accepted = coordinator.complete({
        agentId: req.body?.agentId,
        jobId: req.params.jobId,
        result: req.body?.result,
      });
      if (!accepted) {
        return res.status(410).json({ ok: false, error: 'job_not_pending' });
      }
      return res.json({ ok: true });
    } catch (err) {
      const status = err.bridgeCode === 'unknown_agent' ? 403 : 400;
      return res.status(status).json({ ok: false, error: err.bridgeCode || 'invalid_request' });
    }
  });

  return router;
}

module.exports = createBridgeRouter();
module.exports.createBridgeRouter = createBridgeRouter;
