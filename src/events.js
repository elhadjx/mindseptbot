const { EventEmitter } = require('events');

// Single in-process bus. The WhatsApp client publishes state changes here and
// the panel's SSE endpoint subscribes, so neither has to know about the other.
const bus = new EventEmitter();

// Panel tabs can outnumber the default listener cap during a reconnect storm.
bus.setMaxListeners(50);

const EVENTS = {
  WA_STATE: 'wa:state',
  DOOR_OPENED: 'door:opened',
  DOOR_OFFLINE: 'door:offline',
  DOOR_ONLINE: 'door:online',
  WA_MESSAGE: 'wa:message',
};

module.exports = { bus, EVENTS };
