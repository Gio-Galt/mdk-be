import { v4 as uuidv4 } from 'uuid';

export const PROTOCOL_VERSION = '0.1.0';

export const MESSAGE_TYPES = {
  REQUEST: 'request',
  RESPONSE: 'response',
  EVENT: 'event'
};

/**
 * Creates an MDK Protocol message envelope.
 * 
 * @param {Object} options
 * @param {string} options.type - 'request' | 'response' | 'event'
 * @param {string} options.action - e.g. 'command.request', 'telemetry.pull'
 * @param {string} options.sender - '<component:type:instance>'
 * @param {string} [options.target=null] - '<component:type:instance> | null'
 * @param {string} [options.deviceId=null] - device ID if routing to a device
 * @param {Object} [options.payload={}] - the actual payload
 * @returns {Object} A compliant MDK message envelope.
 */
export function createMessage({
  type,
  action,
  sender,
  target = null,
  deviceId = null,
  payload = {}
}) {
  if (!Object.values(MESSAGE_TYPES).includes(type)) {
    throw new Error(`Invalid message type: ${type}`);
  }
  if (!action || typeof action !== 'string') {
    throw new Error('Action must be a valid string');
  }
  if (!sender || typeof sender !== 'string') {
    throw new Error('Sender identity must be provided');
  }

  return {
    id: uuidv4(),
    version: PROTOCOL_VERSION,
    type,
    action,
    sender,
    target,
    deviceId,
    timestamp: Date.now(),
    payload
  };
}

/**
 * Validates an incoming message envelope.
 * 
 * @param {Object} message - The message to validate
 * @returns {boolean} True if valid
 * @throws {Error} if invalid
 */
export function validateMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('Message must be an object');
  }
  if (!message.id) throw new Error('Missing message id');
  if (message.version !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${message.version}`);
  if (!Object.values(MESSAGE_TYPES).includes(message.type)) throw new Error(`Invalid message type: ${message.type}`);
  if (!message.action) throw new Error('Missing message action');
  if (!message.sender) throw new Error('Missing message sender');
  if (!message.timestamp) throw new Error('Missing message timestamp');

  return true;
}
