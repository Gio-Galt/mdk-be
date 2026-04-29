import { EventEmitter } from 'events';

/**
 * A mock transport that uses an in-memory EventEmitter.
 * Useful for local testing or same-process ORK/Client deployments.
 */
export class EventEmitterTransport extends EventEmitter {
  constructor(bus = new EventEmitter()) {
    super();
    this.bus = bus;
    this.connected = false;
    
    // Listen for messages targeted at us
    this._onMessage = (msg) => {
      this.emit('message', msg);
    };
  }

  async connect() {
    this.bus.on('network_message', this._onMessage);
    this.connected = true;
  }

  async disconnect() {
    this.bus.off('network_message', this._onMessage);
    this.connected = false;
    this.emit('close');
  }

  async send(msg) {
    if (!this.connected) {
      throw new Error('Transport is not connected');
    }
    // Simulate network delay
    setTimeout(() => {
      this.bus.emit('network_message', msg);
    }, 0);
  }
  
  /**
   * Test utility to simulate receiving a message from the network.
   */
  simulateReceive(msg) {
    this.emit('message', msg);
  }
}
