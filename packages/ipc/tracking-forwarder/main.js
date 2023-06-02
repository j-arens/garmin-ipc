// @ts-check

const {
  BETTERSTACK_LOGS_BEARER_TOKEN,
  BETTERSTACK_LOGS_HOST,
  GARMIN_INBOUND_API_HOST,
  GARMIN_INBOUND_API_USER,
  GARMIN_INBOUND_API_PASS,
  REQUEST_AUTH_TOKEN,
  TRACKING_SENDER_DEVICE_IMEI,
  TRACKING_SENDER_INREACH_ADDRESS,
  TRACKING_RECEIVER_DEVICE_IMEI,
} = process.env;

/**
 * Non-exhaustive list of message codes for inReach IPC Outbound messages.
 *
 * @type {Readonly<Record<string, number>>}
 */
const messageCodes = {
  PositionReport: 0,
  StartTrack: 10,
  StopTrack: 12,
};

/**
 * Message codes for inReach IPC Outbound messages that are associated with
 * tracking.
 *
 * @type {Readonly<Set<number>>}
 */
const trackingMessageCodes = new Set([
  messageCodes.PositionReport,
  messageCodes.StartTrack,
  messageCodes.StopTrack,
]);

/**
 * Mapping of message codes from the tracking sender to text for tracking
 * receiver location update messages.
 *
 * @type {Readonly<Record<number, string>>}
 */
const messageCodeToReceiverText = {
  [messageCodes.PositionReport]: 'Location Update',
  [messageCodes.StartTrack]: 'Tracking Started',
  [messageCodes.StopTrack]: 'Tracking Stopped',
};

/**
 * Base64 encoded Basic Auth credentials for the Garmin Inbound API.
 *
 * @type {string}
 */
const inboundApiAuth = Buffer
  .from(`${GARMIN_INBOUND_API_USER}:${GARMIN_INBOUND_API_PASS}`)
  .toString('base64');

/**
 * Quick and dirty DigitalOcean function to forward location updates from one
 * inReach device to another inReach device.
 *
 * Why on earth does Garmin not support inReach-to-inReach device tracking out
 * of the box?!
 *
 * Garmin's gateway can be configured to send a POST request to this function
 * whenever it processes an incoming message from an inReach device registered
 * to your account. In this case we only care about location updates. The
 * location data from these updates is forwarded to another inReach device via
 * a message so that it can essentially track the sending device.
 *
 * @see https://developer.garmin.com/inReach/IPC_Outbound.pdf
 * @see https://developer.garmin.com/inReach/IPC_Inbound.pdf
 * @see https://docs.digitalocean.com/products/functions/
 *
 * @param {InvocationEvent<IPCOutboundRequest,WebEventHTTPCustomHeaders>} event
 * @param {InvocationContext} context
 *
 * @returns {Promise<{ statusCode: 200 }>}
 *   Always returns a 200 response to the Garmin gateway to avoid queuing up
 *   retries. Updating this function to handle queued retries would be a good
 *   future improvement.
 */
exports.main = async function main(event, context) {
  const logger = getLogger(event, context);

  if (!isAuthorizedRequest(event)) {
    return { statusCode: 200 };
  }

  // Garmin IPC Outbound requests are sent as POST requests, ignore all other
  // methods, and non-HTTP invocations, and messages without any events.
  if (event?.http?.method !== 'POST' || !Array.isArray(event.Events)) {
    return { statusCode: 200 };
  }

  await logger.debug('IPC Outbound request received');

  const outboundEvent = [...event.Events]
    .sort((a, b) => a.timeStamp - b.timeStamp)
    .pop();

  if (!outboundEvent) {
    return { statusCode: 200 };
  }

  const { imei, messageCode, point } = outboundEvent;

  // Ignore events from other devices except for the configured sender.
  if (imei !== TRACKING_SENDER_DEVICE_IMEI) {
    return { statusCode: 200 };
  }

  // Ignore events that are not tracking related.
  if (!trackingMessageCodes.has(messageCode)) {
    return { statusCode: 200 };
  }

  // Ignore empty location updates (technically 0 lat and 0 lon is valid, but
  // can be ignored here).
  if (point.latitude === 0 && point.longitude === 0) {
    return { statusCode: 200 };
  }

  try {
    let result = await forwardLocationUpdate(
      messageCodeToReceiverText[messageCode] || 'Location Update',
      point,
    );

    if (!result.ok) {
      let error = await result.json();

      await logger.error('IPC Inbound request rejected', {
        status: result.status,
        error,
      });
    }
  } catch (err) {
    await logger.error('Failed to send IPC Inbound request', {
      error: err.message || 'Unknown error',
    });
  }

  return { statusCode: 200 };
}

/**
 * Checks if the given request event includes the expected authorization token.
 *
 * @param {InvocationEvent<any, WebEventHTTPCustomHeaders>} event
 * @returns {boolean}
 */
function isAuthorizedRequest(event) {
  let authorization = event?.http?.headers?.authorization;

  if (!authorization) {
    return false;
  }

  let [ _, encodedToken ] = authorization.split(' ');

  if (!encodedToken) {
    return false;
  }

  let token = Buffer.from(encodedToken, 'base64').toString('utf8');

  return token === `${REQUEST_AUTH_TOKEN}:`;
}

/**
 * Forwards the given point to the configured tracking receiver device in the
 * form of a message with location data embedded.
 *
 * @see https://explore.garmin.com/IPCInbound/docs/#!/Messaging.svc/SendMessagesPOST
 *
 * @param {string} text
 * @param {IPCOutboundEventPoint} point
 *
 * @returns {Promise<Response>}
 */
function forwardLocationUpdate(text, point) {
  /** @type {IPCInboundSendMessage} */
  const message = {
    Recipients: [TRACKING_RECEIVER_DEVICE_IMEI],
    Sender: TRACKING_SENDER_INREACH_ADDRESS,
    Timestamp: Date.now(),
    Message: `${text}: lat ${point.latitude} lon ${point.longitude}`,
    ReferencePoint: {
      LocationType: 'GPSLocation',
      Altitude: point.altitude,
      Speed: point.speed,
      Course: point.course,
      Coordinate: {
        Latitude: point.latitude,
        Longitude: point.longitude,
      },
    },
  };

  const fetchOptions = {
    body: JSON.stringify({ Messages: [message] }),
    headers: {
      Authorization: `Basic ${inboundApiAuth}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  };

  return fetch(
    `https://${GARMIN_INBOUND_API_HOST}/IPCInbound/V1/Messaging.svc/Message`,
    fetchOptions
  );
}

/**
 * Convenience wrapper around the `log()` function.
 *
 * @param {InvocationEvent<any, any>} event
 * @param {InvocationContext} context 
 */
function getLogger(event, context) {
  return {
    debug: (message, data = {}) => log(message, data, 'debug', event, context),
    info: (message, data = {}) => log(message, data, 'info', event, context),
    warn: (message, data = {}) => log(message, data, 'warn', event, context),
    error: (message, data = {}) => log(message, data, 'error', event, context),
  };
}

/**
 * DigitalOcean says it will retain anything written to STDOUT/STDERR, but
 * that's only for async invocations (e.g. the REST API). Web invocations are
 * considered "blocking" and do not create an "activation record", so anything
 * written to STDOUT/STDERR is lost.
 *
 * This DO Function is primarily intended to be invoked via the web, so logs
 * need to be sent and stored somewhere else. In this case they're being sent
 * to the configured Better Stack service.
 *
 * @see https://betterstack.com/docs/logs/http-rest-api/
 * @see https://betterstack.com/docs/logs/javascript/logging/#logging-structured-data
 *
 * @param {string} message
 * @param {object} data
 * @param {"debug" | "info" | "warn" | "error"} level
 * @param {InvocationEvent<any, any>} event
 * @param {InvocationContext} context
 *
 * @returns {Promise<void>}
 */
async function log(message, data, level, event, context) {
  if (!BETTERSTACK_LOGS_HOST || !BETTERSTACK_LOGS_BEARER_TOKEN) {
    return;
  }

  const log = {
    dt: new Date().toISOString(),
    level_string: level,
    message_string: message,
    do_function_context: {
      activation_id: context.activationId,
      apiHost: context.apiHost,
      deadline: context.deadline,
      function_name: context.functionName,
      function_version: context.functionVersion,
      namespace: context.namespace,
      remaining_time: context.getRemainingTimeInMillis(),
    },
    do_function_event: {
      ...event,
    },
    ...data,
  };

  try {
    const fetchOptions = {
      body: JSON.stringify(log),
      headers: {
        Authorization: `Bearer ${BETTERSTACK_LOGS_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    };

    await fetch(`https://${BETTERSTACK_LOGS_HOST}`, fetchOptions);
  } catch {
    // Ignore errors.
  }
}

// -- DigitalOcean Function Types -------------------------------------------------------

/**
 * Event passed to DigitalOcean functions on invocation.
 *
 * @see https://docs.digitalocean.com/products/functions/reference/parameters-responses/#event-parameter
 * @see https://docs.digitalocean.com/products/functions/reference/runtimes/node-js/#event-parameter
 *
 * @typedef {{ http?: WebEventHTTP<H>; } & Partial<T>} InvocationEvent
 *
 * Any parameters that the functions runtime parsed from the HTTP request
 * body, query string, and `project.yml`. Parameter values parsed from the
 * query string or form encoded body are always strings. Parameters parsed from
 * a JSON body, or `project.yml`, are parsed as JSON.
 * @template {{ [K: string]: unknown; }} T
 *
 * Any additional headers besides the standard HTTP headers that the DO
 * functions runtime includes from HTTP requests.
 * @template {{ [K: string]: unknown; }} H
 */

/**
 * @typedef {{
 *   headers: WebEventHTTPStandardHeaders & Partial<T>;
 *   method: string;
 *   path: string;
 * }} WebEventHTTP
 *
 * Any additional headers besides the standard HTTP headers that the DO
 * functions runtime includes from HTTP requests.
 * @template {{ [K: string]: unknown; }} T
 */

/**
 * Standard HTTP headers that the functions runtime includes in each web event.
 * Other headers may be included depending on the request.
 *
 * @see https://docs.digitalocean.com/products/functions/reference/http-headers/
 *
 * @typedef {{
 *   accept: string;
 *   "accept-encoding": string;
 *   "content-type": string;
 *   "user-agent": string;
 *   "x-forwarded-for": string;
 *   "x-forwarded-proto": string;
 *   "x-request-id": string;
 * }} WebEventHTTPStandardHeaders
 */

/**
 * Custom headers this DO functione expects to be included in HTTP requests.
 *
 * @typedef {{
 *   authorization: string;
 * }} WebEventHTTPCustomHeaders
 */

/**
 * Context object that contains information about the execution environment.
 *
 * @see https://docs.digitalocean.com/products/functions/reference/runtimes/node-js/#context-parameter
 *
 * @typedef {{
 *   activationId: string;
 *   apiHost: string;
 *   apiKey: string;
 *   deadline: number;
 *   functionName: string;
 *   functionVersion: string;
 *   getRemainingTimeInMillis: () => number;
 *   namespace: string;
 *   requestId: string;
 * }} InvocationContext
 */

// -- Garmin IPC Outbound types -----------------------------------------------

/** @see https://developer.garmin.com/inReach/IPC_Outbound.pdf */

/**
 * Root IPC Outbound message object.
 *
 * @typedef {{
 *   Version: string;
 *   Events: [IPCOutboundEvent];
 * }} IPCOutboundRequest
 */

/**
 * An IPC Outbound event from an inReach device, characterized as a single data
 * transmission from an inReach device to the Garmin gateway.
 *
 * @typedef {{
 *   imei: DeviceIMEI;
 *   messageCode: number;
 *   freeText: string;
 *   timeStamp: number;
 *   pingbackReceived: number;
 *   pingbackResponded: number;
 *   addresses: [string];
 *   point: IPCOutboundEventPoint;
 *   status: IPCOutboundEventStatus;
 *   payload: Base64Binary;
 * }} IPCOutboundEvent
 */

/**
 * A point represents the location of an event. Values are filled with 0 when
 * there is no location information.
 *
 * @typedef {{
 *   latitude: number;
 *   longitude: number;
 *   altitude: number;
 *   gpsFix: number;
 *   course: number;
 *   speed: number;
 * }} IPCOutboundEventPoint
 */

/**
 * inReach device status information.
 *
 * @typedef {{
 *   autonomous: number;
 *   lowBattery: number;
 *   intervalChange: number;
 *   resetDetected: number;
 * }} IPCOutboundEventStatus
 */

// -- Garmin IPC Inbound types ------------------------------------------------

/** @see https://developer.garmin.com/inReach/IPC_Inbound.pdf */

/**
 * @typedef {{
*   Recipients: [DeviceIMEI];
*   Sender: string;
*   Timestamp: number;
*   Message: string;
*   ReferencePoint: {
*     LocationType: "ReferencePoint" | "GPSLocation";
*     Altitude: number;
*     Speed: number;
*     Course: number;
*     Coordinate: {
*       Latitude: number;
*       Longitude: number;
*     }
*     Label?: string;
*   }
* }} IPCInboundSendMessage
*/

// -- Type aliases ------------------------------------------------------------

/** @typedef {string} DeviceIMEI */
/** @typedef {string} Base64Binary */
