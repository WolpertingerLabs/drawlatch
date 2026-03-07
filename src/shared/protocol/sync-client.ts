/**
 * Sync client — callboard-side API for the key exchange protocol.
 *
 * Usage:
 *   const exchange = await startKeyExchange({ remoteUrl, inviteCode, encryptionKey, callerAlias });
 *   // Display exchange.confirmCode to the user
 *   // User enters confirmCode into drawlatch
 *   const result = await exchange.complete();
 *   // Keys exchanged, remote public keys saved locally
 */

import type { SerializedPublicKeys } from '../crypto/keys.js';
import {
  createCaller,
  exportPublicKeys,
  saveRemotePublicKeys,
  callerExists,
} from '../crypto/key-manager.js';
import {
  generateSyncCode,
  encryptSyncPayload,
  decryptSyncPayload,
  validateSyncRequest,
  type SyncRequest,
  type SyncResponse,
  type SyncErrorCode,
} from './sync.js';

export interface KeyExchangeInit {
  /** Display this code to the user — they enter it into drawlatch. */
  confirmCode: string;
  /** The caller's public keys (already generated). */
  publicKeys: SerializedPublicKeys;
  /** Call after the user has entered the confirm code into drawlatch. */
  complete(): Promise<SyncResult>;
}

export interface SyncResult {
  remotePublicKeys: SerializedPublicKeys;
  callerAlias: string;
  fingerprint: string;
}

export class SyncClientError extends Error {
  constructor(
    message: string,
    public readonly code: SyncErrorCode,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'SyncClientError';
  }
}

export interface StartKeyExchangeOpts {
  /** Drawlatch remote server URL (e.g., "http://host:9999"). */
  remoteUrl: string;
  /** Invite code from drawlatch sync output. */
  inviteCode: string;
  /** AES-256-GCM encryption key from drawlatch sync output (base64). */
  encryptionKey: string;
  /** Desired caller alias on the remote server. */
  callerAlias: string;
  /** Override config directory (default: ~/.drawlatch). */
  configDir?: string;
}

/**
 * Start the key exchange from callboard's side.
 *
 * 1. Creates caller keys if they don't exist yet
 * 2. Generates a confirm code
 * 3. Returns the confirm code + a `complete()` function
 * 4. `complete()` encrypts and sends POST /sync, decrypts response, saves remote keys
 */
export async function startKeyExchange(opts: StartKeyExchangeOpts): Promise<KeyExchangeInit> {
  const { remoteUrl, inviteCode, encryptionKey, callerAlias, configDir } = opts;
  const keyOpts = configDir ? { configDir } : undefined;

  // Create caller keys if they don't exist
  let publicKeys: SerializedPublicKeys;
  if (callerExists(callerAlias, keyOpts)) {
    publicKeys = exportPublicKeys('local', callerAlias, keyOpts);
  } else {
    const result = createCaller(callerAlias, keyOpts);
    publicKeys = result.publicKeys;
  }

  const confirmCode = generateSyncCode();

  return {
    confirmCode,
    publicKeys,
    async complete(): Promise<SyncResult> {
      const request: SyncRequest = {
        inviteCode,
        confirmCode,
        callerAlias,
        publicKeys,
      };

      const encryptedBody = encryptSyncPayload(request, encryptionKey);

      const url = remoteUrl.replace(/\/+$/, '') + '/sync';
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: encryptedBody,
      });

      if (!response.ok) {
        let errorCode: SyncErrorCode = 'NO_ACTIVE_SESSION';
        try {
          const errorBody = (await response.json()) as { error?: string };
          if (errorBody.error) errorCode = errorBody.error as SyncErrorCode;
        } catch {
          // Could not parse error body
        }
        throw new SyncClientError(
          `Sync failed (HTTP ${response.status}): ${errorCode}`,
          errorCode,
          response.status,
        );
      }

      const encryptedResponse = await response.text();

      let decrypted: unknown;
      try {
        decrypted = decryptSyncPayload(encryptedResponse, encryptionKey);
      } catch {
        throw new SyncClientError(
          'Failed to decrypt sync response — encryption key mismatch?',
          'DECRYPTION_FAILED',
        );
      }

      const syncResponse = decrypted as SyncResponse;
      if (
        !syncResponse.remotePublicKeys?.signing ||
        !syncResponse.remotePublicKeys?.exchange ||
        !syncResponse.callerAlias
      ) {
        throw new SyncClientError('Invalid sync response payload', 'INVALID_PAYLOAD');
      }

      // Save the remote server's public keys locally
      saveRemotePublicKeys(syncResponse.remotePublicKeys, keyOpts);

      return {
        remotePublicKeys: syncResponse.remotePublicKeys,
        callerAlias: syncResponse.callerAlias,
        fingerprint: syncResponse.fingerprint,
      };
    },
  };
}
