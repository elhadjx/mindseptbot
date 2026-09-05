const { config } = require('../config');
const { DoorBridgeCoordinator } = require('./coordinator');

const bridgeCoordinator = new DoorBridgeCoordinator({
  token: config.bridge.token,
  expectedAgentId: config.bridge.agentId,
  heartbeatTtlMs: config.bridge.heartbeatTtlMs,
  claimTimeoutMs: config.bridge.claimTimeoutMs,
  resultTimeoutMs: config.bridge.resultTimeoutMs,
  pollWaitMs: config.bridge.pollWaitMs,
});

module.exports = { bridgeCoordinator };
