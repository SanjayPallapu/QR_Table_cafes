const EventEmitter = require('events');

class OrderEvents extends EventEmitter { }

const orderEvents = new OrderEvents();
orderEvents.setMaxListeners(100); // Support many concurrent SSE clients

module.exports = orderEvents;
