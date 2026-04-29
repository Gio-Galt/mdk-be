import { EventEmitter } from 'events';
import { createMessage, validateMessage, MESSAGE_TYPES } from './protocol.js';

export class MDKClient extends EventEmitter {
  /**
   * Initialize the MDK Client SDK.
   * 
   * @param {Object} options
   * @param {string} options.url - e.g., 'ipc:///tmp/mdk.sock' or 'hrpc://<public-key>'
   * @param {string} options.identity - e.g., 'app-node:api:gateway-1'
   * @param {Object} [options.transport] - Injectable transport layer (used for tests)
   */
  constructor({ url, identity, transport = null }) {
    super();
    this.url = url;
    this.identity = identity;
    this.transport = transport; // Abstract transport interface
    this.pendingRequests = new Map(); // Maps message id to { resolve, reject, timer }
    this.defaultTimeout = 10000;
  }

  async connect() {
    if (!this.transport) {
      this.transport = this._resolveTransport(this.url);
    }
    
    this.transport.on('message', this._handleIncomingMessage.bind(this));
    this.transport.on('error', (err) => this.emit('error', err));
    this.transport.on('close', () => this.emit('close'));
    
    await this.transport.connect();
    this.emit('connected');
  }

  async disconnect() {
    if (this.transport) {
      await this.transport.disconnect();
    }
    this.pendingRequests.forEach(({ reject }) => reject(new Error('Client disconnected')));
    this.pendingRequests.clear();
  }

  /**
   * Dispatch a fire-and-forget event.
   */
  async emitEvent(action, payload = {}, target = null, deviceId = null) {
    const msg = createMessage({
      type: MESSAGE_TYPES.EVENT,
      action,
      sender: this.identity,
      target,
      deviceId,
      payload
    });
    
    await this.transport.send(msg);
  }

  /**
   * Send a request and wait for a response.
   */
  async request(action, payload = {}, { target = null, deviceId = null, timeout = this.defaultTimeout } = {}) {
    const msg = createMessage({
      type: MESSAGE_TYPES.REQUEST,
      action,
      sender: this.identity,
      target,
      deviceId,
      payload
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.id);
        reject(new Error(`Request timeout: ${action} after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(msg.id, { resolve, reject, timer });

      this.transport.send(msg).catch(err => {
        clearTimeout(timer);
        this.pendingRequests.delete(msg.id);
        reject(err);
      });
    });
  }

  _handleIncomingMessage(rawMsg) {
    try {
      validateMessage(rawMsg);
    } catch (e) {
      this.emit('error', new Error(`Protocol validation failed: ${e.message}`));
      return;
    }

    if (rawMsg.type === MESSAGE_TYPES.RESPONSE) {
      const pending = this.pendingRequests.get(rawMsg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(rawMsg.id);
        
        if (rawMsg.payload && rawMsg.payload.error) {
          pending.reject(new Error(rawMsg.payload.error));
        } else {
          pending.resolve(rawMsg.payload);
        }
      }
    } else {
      // It's an incoming REQUEST or EVENT. Emit to application.
      this.emit('message', rawMsg);
    }
  }

  _resolveTransport(url) {
    // In a real implementation, this would parse the URL and instantiate 
    // an IPC transport or an HRPC transport.
    // For now, if no transport was injected, throw an error.
    throw new Error(`Transport auto-resolution not implemented. Please provide a transport instance.`);
  }
}

// Export protocol utilities
export * from './protocol.js';
